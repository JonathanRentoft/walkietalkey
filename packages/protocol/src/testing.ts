/**
 * TEST-ONLY helpers: fixed private keys, fixed nonces and raw key bytes, so test vectors are
 * reproducible. Never import this from production code; a fixed nonce breaks AES-GCM.
 */
import { bs } from "./bytes.ts";
import {
  deriveBase,
  hkdfBytes,
  joinMacKey,
  type PairKeyInput,
} from "./derive.ts";
import { LABELS } from "./constants.ts";
import { utf8Encode } from "./bytes.ts";
import { sealFrameInternal, type SealHeader } from "./frame.ts";

/** Imports an ECDSA P-256 private key from PKCS#8 DER. */
export async function importSigningPrivateKeyPkcs8(
  pkcs8: Uint8Array,
  extractable = false,
): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "pkcs8",
    bs(pkcs8),
    { name: "ECDSA", namedCurve: "P-256" },
    extractable,
    ["sign"],
  );
}

/** Imports an ECDH P-256 private key from PKCS#8 DER. */
export async function importAgreementPrivateKeyPkcs8(
  pkcs8: Uint8Array,
  extractable = false,
): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "pkcs8",
    bs(pkcs8),
    { name: "ECDH", namedCurve: "P-256" },
    extractable,
    ["deriveBits", "deriveKey"],
  );
}

/** Imports raw AES-256-GCM key bytes. */
export async function importAesKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", bs(raw), { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

/** sealFrame with a caller-chosen nonce. */
export async function sealFrameWithNonce(
  key: CryptoKey,
  header: SealHeader,
  plaintext: Uint8Array,
  nonce: Uint8Array,
): Promise<Uint8Array> {
  return sealFrameInternal(key, header, plaintext, nonce);
}

/** Every intermediate value of spec 9.3 as raw bytes. */
export async function deriveRawPairSecrets(input: PairKeyInput): Promise<{
  shared: Uint8Array;
  base: Uint8Array;
  p2c: Uint8Array;
  c2p: Uint8Array;
  macKey: Uint8Array;
}> {
  const { shared, base } = await deriveBase(input);
  const empty = new Uint8Array(0);
  return {
    shared,
    base,
    p2c: await hkdfBytes(base, empty, utf8Encode(LABELS.p2c)),
    c2p: await hkdfBytes(base, empty, utf8Encode(LABELS.c2p)),
    macKey: await joinMacKey(input.secret),
  };
}
