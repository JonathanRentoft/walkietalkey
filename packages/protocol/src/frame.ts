import { bs, bytesEqual, randomBytes, readU64BE, writeU64BE } from "./bytes.ts";
import {
  AAD_LEN,
  DEVICE_ID_LEN,
  FRAME_OVERHEAD,
  HEADER_LEN,
  MAX_FRAME_LEN,
  MAX_PLAINTEXT_LEN,
  NONCE_LEN,
  PROTOCOL_VERSION,
} from "./constants.ts";
import { ProtocolError } from "./errors.ts";

const MAX_U64 = (1n << 64n) - 1n;

export interface FrameHeader {
  version: number;
  type: number;
  sender: Uint8Array;
  recipient: Uint8Array;
  counter: bigint;
  nonce: Uint8Array;
}

export interface ParsedFrame {
  header: FrameHeader;
  /** The first 42 bytes, authenticated as AAD. */
  aad: Uint8Array;
  /** AES-GCM ciphertext followed by the 16-byte tag. */
  ciphertext: Uint8Array;
}

/** What a sender chooses; version is always 1 and the nonce is random. */
export interface SealHeader {
  type: number;
  sender: Uint8Array;
  recipient: Uint8Array;
  counter: bigint;
}

/**
 * Splits a device frame into header, AAD and ciphertext without decrypting (spec 9.4).
 * Throws ProtocolError for anything shorter than 70 bytes, longer than 65,536 bytes, or
 * with a version other than 1. The relay uses this to route.
 */
export function parseFrame(bytes: Uint8Array): ParsedFrame {
  if (!(bytes instanceof Uint8Array))
    throw new ProtocolError("bad_frame", "not bytes");
  if (bytes.length > MAX_FRAME_LEN) throw new ProtocolError("frame_too_large");
  if (bytes.length < FRAME_OVERHEAD)
    throw new ProtocolError("bad_frame", "too short");
  if (bytes[0] !== PROTOCOL_VERSION)
    throw new ProtocolError("bad_version", String(bytes[0]));
  return {
    header: {
      version: bytes[0],
      type: bytes[1]!,
      sender: bytes.subarray(2, 18),
      recipient: bytes.subarray(18, 34),
      counter: readU64BE(bytes, 34),
      nonce: bytes.subarray(AAD_LEN, HEADER_LEN),
    },
    aad: bytes.subarray(0, AAD_LEN),
    ciphertext: bytes.subarray(HEADER_LEN),
  };
}

function encodeHeader(h: SealHeader, nonce: Uint8Array): Uint8Array {
  if (!Number.isInteger(h.type) || h.type < 0 || h.type > 255)
    throw new ProtocolError("bad_frame", "type");
  if (
    h.sender.length !== DEVICE_ID_LEN ||
    h.recipient.length !== DEVICE_ID_LEN
  ) {
    throw new ProtocolError("bad_length", "device ids must be 16 bytes");
  }
  if (typeof h.counter !== "bigint" || h.counter < 1n || h.counter > MAX_U64) {
    throw new ProtocolError("bad_frame", "counter must be 1..2^64-1");
  }
  if (nonce.length !== NONCE_LEN)
    throw new ProtocolError("bad_length", "nonce must be 12 bytes");
  const out = new Uint8Array(HEADER_LEN);
  out[0] = PROTOCOL_VERSION;
  out[1] = h.type;
  out.set(h.sender, 2);
  out.set(h.recipient, 18);
  writeU64BE(out, 34, h.counter);
  out.set(nonce, AAD_LEN);
  return out;
}

/** Internal: seal with a given nonce. Production code goes through sealFrame (random nonce). */
export async function sealFrameInternal(
  key: CryptoKey,
  h: SealHeader,
  plaintext: Uint8Array,
  nonce: Uint8Array,
): Promise<Uint8Array<ArrayBuffer>> {
  if (plaintext.length > MAX_PLAINTEXT_LEN)
    throw new ProtocolError("frame_too_large");
  const header = encodeHeader(h, nonce);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv: bs(nonce),
        additionalData: bs(header.subarray(0, AAD_LEN)),
        tagLength: 128,
      },
      key,
      bs(plaintext),
    ),
  );
  const out = new Uint8Array(HEADER_LEN + ct.length);
  out.set(header, 0);
  out.set(ct, HEADER_LEN);
  return out;
}

/** Encrypts one device frame with AES-256-GCM, a random 96-bit nonce and the header as AAD. */
export async function sealFrame(
  key: CryptoKey,
  h: SealHeader,
  plaintext: Uint8Array,
): Promise<Uint8Array<ArrayBuffer>> {
  return sealFrameInternal(key, h, plaintext, randomBytes(NONCE_LEN));
}

export interface OpenExpectations {
  /** This device's id; frames for anyone else are refused before decrypting. */
  recipient: Uint8Array;
  /** When given, the sender the key belongs to. */
  sender?: Uint8Array;
}

/**
 * Checks the recipient (and sender), then decrypts. Throws ProtocolError with code
 * wrong_recipient, wrong_sender, decrypt_failed or a parse error. Replay checks are the
 * caller's (see PairChannel).
 */
export async function openFrame(
  key: CryptoKey,
  bytes: Uint8Array,
  expect: OpenExpectations,
): Promise<{ header: FrameHeader; plaintext: Uint8Array }> {
  const { header, aad, ciphertext } = parseFrame(bytes);
  if (!bytesEqual(header.recipient, expect.recipient))
    throw new ProtocolError("wrong_recipient");
  if (expect.sender && !bytesEqual(header.sender, expect.sender))
    throw new ProtocolError("wrong_sender");
  let plaintext: Uint8Array;
  try {
    plaintext = new Uint8Array(
      await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: bs(header.nonce),
          additionalData: bs(aad),
          tagLength: 128,
        },
        key,
        bs(ciphertext),
      ),
    );
  } catch {
    throw new ProtocolError("decrypt_failed");
  }
  return { header, plaintext };
}
