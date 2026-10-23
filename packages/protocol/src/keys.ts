import { bs, bytesEqual, sha256 } from "./bytes.ts";
import { DEVICE_ID_LEN, SPKI_LEN, SPKI_PREFIX } from "./constants.ts";
import { ProtocolError } from "./errors.ts";

const ECDSA = { name: "ECDSA", namedCurve: "P-256" } as const;
const ECDH = { name: "ECDH", namedCurve: "P-256" } as const;

/** One device's two key pairs plus the derived public values. */
export interface DeviceKeys {
  signing: CryptoKeyPair;
  agreement: CryptoKeyPair;
  signingSpki: Uint8Array;
  agreementSpki: Uint8Array;
  deviceId: Uint8Array;
}

/**
 * Checks the canonical encoding: a P-256 SPKI with an uncompressed point, exactly 91 bytes.
 * Device ids hash the SPKI, so only one encoding of a key may exist. Does not check that the
 * point is on the curve; the import functions do.
 */
export function assertSpki(spki: Uint8Array): void {
  if (!(spki instanceof Uint8Array) || spki.length !== SPKI_LEN) {
    throw new ProtocolError("bad_key", `SPKI must be ${SPKI_LEN} bytes`);
  }
  if (!bytesEqual(spki.subarray(0, SPKI_PREFIX.length), SPKI_PREFIX)) {
    throw new ProtocolError("bad_key", "not an uncompressed P-256 SPKI");
  }
}

export async function exportSpki(publicKey: CryptoKey): Promise<Uint8Array> {
  const spki = new Uint8Array((await crypto.subtle.exportKey("spki", publicKey)) as ArrayBuffer);
  assertSpki(spki);
  return spki;
}

/** Imports an ECDSA P-256 verification key from canonical SPKI. Throws ProtocolError("bad_key"). */
export async function importSigningPublicKey(spki: Uint8Array): Promise<CryptoKey> {
  assertSpki(spki);
  try {
    return await crypto.subtle.importKey("spki", bs(spki), ECDSA, true, ["verify"]);
  } catch {
    throw new ProtocolError("bad_key", "invalid P-256 point");
  }
}

/** Imports an ECDH P-256 public key from canonical SPKI. Throws ProtocolError("bad_key"). */
export async function importAgreementPublicKey(spki: Uint8Array): Promise<CryptoKey> {
  assertSpki(spki);
  try {
    return await crypto.subtle.importKey("spki", bs(spki), ECDH, true, []);
  } catch {
    throw new ProtocolError("bad_key", "invalid P-256 point");
  }
}

/** Device id = first 16 bytes of SHA-256(signing SPKI) (spec 9.2). */
export async function deviceIdFromSpki(signingSpki: Uint8Array): Promise<Uint8Array> {
  assertSpki(signingSpki);
  return (await sha256(signingSpki)).slice(0, DEVICE_ID_LEN);
}

/** ECDSA P-256 key pair; the private key is non-extractable unless asked (SEC-09). */
export async function generateSigningKeyPair(extractable = false): Promise<CryptoKeyPair> {
  return (await crypto.subtle.generateKey(ECDSA, extractable, ["sign", "verify"])) as CryptoKeyPair;
}

/** ECDH P-256 key pair; the private key is non-extractable unless asked (SEC-09). */
export async function generateAgreementKeyPair(extractable = false): Promise<CryptoKeyPair> {
  return (await crypto.subtle.generateKey(ECDH, extractable, ["deriveBits", "deriveKey"])) as CryptoKeyPair;
}

/** Builds DeviceKeys from existing key pairs (for example loaded from IndexedDB). */
export async function deviceKeysFromPairs(signing: CryptoKeyPair, agreement: CryptoKeyPair): Promise<DeviceKeys> {
  const signingSpki = await exportSpki(signing.publicKey);
  const agreementSpki = await exportSpki(agreement.publicKey);
  return { signing, agreement, signingSpki, agreementSpki, deviceId: await deviceIdFromSpki(signingSpki) };
}

/** Creates a device's two key pairs with non-extractable private keys. */
export async function generateDeviceKeys(): Promise<DeviceKeys> {
  return deviceKeysFromPairs(await generateSigningKeyPair(false), await generateAgreementKeyPair(false));
}
