import { bs, bytesEqual, concatBytes, sha256, utf8Encode } from "./bytes.ts";
import { DEVICE_ID_LEN, KEY_LEN, LABELS, MAC_LEN, ROOM_ID_LEN, SALT_LEN, SECRET_LEN } from "./constants.ts";
import { ProtocolError } from "./errors.ts";
import { assertSpki, importAgreementPublicKey } from "./keys.ts";

const EMPTY = new Uint8Array(0);

function need(bytes: Uint8Array, len: number, what: string): void {
  if (!(bytes instanceof Uint8Array) || bytes.length !== len) {
    throw new ProtocolError("bad_length", `${what} must be ${len} bytes`);
  }
}

/** roomId = first 16 bytes of SHA-256("wt-room-v1" ‖ owner signing SPKI ‖ salt) (RELAY-03). */
export async function computeRoomId(ownerSigningSpki: Uint8Array, salt: Uint8Array): Promise<Uint8Array> {
  assertSpki(ownerSigningSpki);
  need(salt, SALT_LEN, "salt");
  return (await sha256(concatBytes(utf8Encode(LABELS.room), ownerSigningSpki, salt))).slice(0, ROOM_ID_LEN);
}

/** ECDH P-256 shared secret: the 32-byte x coordinate. */
export async function ecdhSharedSecret(agreementPrivateKey: CryptoKey, peerAgreementSpki: Uint8Array): Promise<Uint8Array> {
  const peer = await importAgreementPublicKey(peerAgreementSpki);
  // `public` is the WebCrypto name; the cast keeps DOM and Workers typings both happy.
  const params = { name: "ECDH", public: peer } as unknown as Parameters<SubtleCrypto["deriveBits"]>[0];
  return new Uint8Array(await crypto.subtle.deriveBits(params, agreementPrivateKey, 256));
}

/** HKDF-SHA-256 to raw bytes. A zero-length salt is the RFC 5869 default (HashLen zero bytes). */
export async function hkdfBytes(ikm: Uint8Array, salt: Uint8Array, info: Uint8Array, length = KEY_LEN): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", bs(ikm), "HKDF", false, ["deriveBits"]);
  return new Uint8Array(
    await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: bs(salt), info: bs(info) }, key, length * 8),
  );
}

export interface PairKeyInput {
  /** This device's ECDH private key. */
  agreementPrivateKey: CryptoKey;
  /** The other device's agreement SPKI (the computer's from the QR, or the phone's from member_joined). */
  peerAgreementSpki: Uint8Array;
  /** The pairing secret `s` from the QR. */
  secret: Uint8Array;
  roomId: Uint8Array;
  computerId: Uint8Array;
  phoneId: Uint8Array;
}

export interface PairKeys {
  /** k_p2c: phone → computer. */
  p2c: CryptoKey;
  /** k_c2p: computer → phone. */
  c2p: CryptoKey;
}

/** shared and base of spec 9.3. Internal; callers keep these bytes short-lived. */
export async function deriveBase(input: PairKeyInput): Promise<{ shared: Uint8Array; base: Uint8Array }> {
  need(input.secret, SECRET_LEN, "s");
  need(input.roomId, ROOM_ID_LEN, "roomId");
  need(input.computerId, DEVICE_ID_LEN, "computerId");
  need(input.phoneId, DEVICE_ID_LEN, "phoneId");
  const shared = await ecdhSharedSecret(input.agreementPrivateKey, input.peerAgreementSpki);
  const info = concatBytes(utf8Encode(LABELS.pair), input.roomId, input.computerId, input.phoneId);
  const base = await hkdfBytes(shared, input.secret, info);
  return { shared, base };
}

async function aesFromBase(base: Uint8Array, label: string, extractable: boolean): Promise<CryptoKey> {
  const baseKey = await crypto.subtle.importKey("raw", bs(base), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: bs(EMPTY), info: bs(utf8Encode(label)) },
    baseKey,
    { name: "AES-GCM", length: 256 },
    extractable,
    ["encrypt", "decrypt"],
  );
}

/**
 * Derives the two direction keys of a pair (spec 9.3) as AES-256-GCM CryptoKeys,
 * non-extractable unless `extractable` is set (tests only).
 */
export async function derivePairKeys(input: PairKeyInput, extractable = false): Promise<PairKeys> {
  const { base } = await deriveBase(input);
  const keys = {
    p2c: await aesFromBase(base, LABELS.p2c, extractable),
    c2p: await aesFromBase(base, LABELS.c2p, extractable),
  };
  base.fill(0);
  return keys;
}

/** mac_key = HKDF-SHA256(ikm = s, salt = "", info = "wt-join-mac-v1", 32 bytes). */
export async function joinMacKey(secret: Uint8Array): Promise<Uint8Array> {
  need(secret, SECRET_LEN, "s");
  return hkdfBytes(secret, EMPTY, utf8Encode(LABELS.joinMac));
}

/** join_mac = HMAC-SHA256(mac_key, roomId ‖ phone signing SPKI ‖ phone agreement SPKI). */
export async function computeJoinMac(
  secret: Uint8Array,
  roomId: Uint8Array,
  phoneSigningSpki: Uint8Array,
  phoneAgreementSpki: Uint8Array,
): Promise<Uint8Array> {
  need(roomId, ROOM_ID_LEN, "roomId");
  assertSpki(phoneSigningSpki);
  assertSpki(phoneAgreementSpki);
  const raw = await joinMacKey(secret);
  const key = await crypto.subtle.importKey("raw", bs(raw), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  raw.fill(0);
  const data = concatBytes(roomId, phoneSigningSpki, phoneAgreementSpki);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, bs(data)));
}

/** Verifies a join MAC; false for any mismatch or malformed input. */
export async function verifyJoinMac(
  secret: Uint8Array,
  roomId: Uint8Array,
  phoneSigningSpki: Uint8Array,
  phoneAgreementSpki: Uint8Array,
  mac: Uint8Array,
): Promise<boolean> {
  if (mac.length !== MAC_LEN) return false;
  try {
    const expected = await computeJoinMac(secret, roomId, phoneSigningSpki, phoneAgreementSpki);
    return bytesEqual(expected, mac);
  } catch (e) {
    if (e instanceof ProtocolError) return false;
    throw e;
  }
}
