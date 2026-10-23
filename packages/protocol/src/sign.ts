import { bs, concatBytes, utf8Encode } from "./bytes.ts";
import {
  CHALLENGE_LEN,
  LABELS,
  ROOM_ID_LEN,
  SIGNATURE_LEN,
  type ChallengeLabel,
} from "./constants.ts";
import { ProtocolError } from "./errors.ts";
import { importSigningPublicKey } from "./keys.ts";

const CHALLENGE_LABELS: readonly string[] = [
  LABELS.auth,
  LABELS.create,
  LABELS.join,
];
const ECDSA_SHA256 = { name: "ECDSA", hash: "SHA-256" } as const;

/** label ‖ roomId ‖ challenge, the message every challenge answer signs (spec 9.3). */
export function challengeMessage(
  label: ChallengeLabel,
  roomId: Uint8Array,
  challenge: Uint8Array,
): Uint8Array {
  if (!CHALLENGE_LABELS.includes(label))
    throw new ProtocolError("bad_label", String(label));
  if (roomId.length !== ROOM_ID_LEN)
    throw new ProtocolError("bad_length", "roomId must be 16 bytes");
  if (challenge.length !== CHALLENGE_LEN)
    throw new ProtocolError("bad_length", "challenge must be 32 bytes");
  return concatBytes(utf8Encode(label), roomId, challenge);
}

/** ECDSA P-256/SHA-256 signature in WebCrypto's 64-byte raw r‖s form. */
export async function signChallenge(
  privateKey: CryptoKey,
  label: ChallengeLabel,
  roomId: Uint8Array,
  challenge: Uint8Array,
): Promise<Uint8Array> {
  const msg = challengeMessage(label, roomId, challenge);
  return new Uint8Array(
    await crypto.subtle.sign(ECDSA_SHA256, privateKey, bs(msg)),
  );
}

/**
 * Verifies a challenge answer. Returns false for a wrong or malformed signature; throws
 * ProtocolError only for a malformed public key or wrong-length room id or challenge.
 */
export async function verifyChallenge(
  publicKey: Uint8Array | CryptoKey,
  label: ChallengeLabel,
  roomId: Uint8Array,
  challenge: Uint8Array,
  signature: Uint8Array,
): Promise<boolean> {
  const msg = challengeMessage(label, roomId, challenge);
  if (signature.length !== SIGNATURE_LEN) return false;
  const key =
    publicKey instanceof Uint8Array
      ? await importSigningPublicKey(publicKey)
      : publicKey;
  try {
    return await crypto.subtle.verify(
      ECDSA_SHA256,
      key,
      bs(signature),
      bs(msg),
    );
  } catch {
    return false;
  }
}
