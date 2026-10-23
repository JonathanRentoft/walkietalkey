import { ProtocolError } from "./errors.ts";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const DECODE = new Int16Array(128).fill(-1);
for (let i = 0; i < ALPHABET.length; i++) DECODE[ALPHABET.charCodeAt(i)] = i;

/** Casts for WebCrypto, whose lib types want ArrayBuffer-backed views. */
export function bs(bytes: Uint8Array): BufferSource {
  return bytes as unknown as BufferSource;
}

/** base64url without padding (RFC 4648 section 5). */
export function b64uEncode(bytes: Uint8Array): string {
  let out = "";
  let i = 0;
  for (; i + 3 <= bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out += ALPHABET[n >> 18]! + ALPHABET[(n >> 12) & 63]! + ALPHABET[(n >> 6) & 63]! + ALPHABET[n & 63]!;
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i]! << 16;
    out += ALPHABET[n >> 18]! + ALPHABET[(n >> 12) & 63]!;
  } else if (rest === 2) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8);
    out += ALPHABET[n >> 18]! + ALPHABET[(n >> 12) & 63]! + ALPHABET[(n >> 6) & 63]!;
  }
  return out;
}

/**
 * Strict base64url decoding: URL alphabet only, no padding, no whitespace, and the
 * unused trailing bits must be zero, so every byte string has exactly one encoding.
 * Throws ProtocolError("bad_base64"), or "bad_length" when `expectedLength` differs.
 */
export function b64uDecode(text: string, expectedLength?: number): Uint8Array {
  if (typeof text !== "string") throw new ProtocolError("bad_base64", "not a string");
  const len = text.length;
  if (len % 4 === 1) throw new ProtocolError("bad_base64", "impossible length");
  const values = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    const c = text.charCodeAt(i);
    const v = c < 128 ? DECODE[c]! : -1;
    if (v < 0) throw new ProtocolError("bad_base64", "character outside the base64url alphabet");
    values[i] = v;
  }
  const out = new Uint8Array(Math.floor((len * 3) / 4));
  let o = 0;
  let i = 0;
  for (; i + 4 <= len; i += 4) {
    const n = (values[i]! << 18) | (values[i + 1]! << 12) | (values[i + 2]! << 6) | values[i + 3]!;
    out[o++] = n >> 16;
    out[o++] = (n >> 8) & 255;
    out[o++] = n & 255;
  }
  const rest = len - i;
  if (rest === 2) {
    if ((values[i + 1]! & 15) !== 0) throw new ProtocolError("bad_base64", "non-canonical trailing bits");
    out[o++] = (values[i]! << 2) | (values[i + 1]! >> 4);
  } else if (rest === 3) {
    if ((values[i + 2]! & 3) !== 0) throw new ProtocolError("bad_base64", "non-canonical trailing bits");
    const n = (values[i]! << 10) | (values[i + 1]! << 4) | (values[i + 2]! >> 2);
    out[o++] = n >> 8;
    out[o++] = n & 255;
  }
  if (expectedLength !== undefined && out.length !== expectedLength) {
    throw new ProtocolError("bad_length", `expected ${expectedLength} bytes, got ${out.length}`);
  }
  return out;
}

export function hexEncode(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

export function hexDecode(text: string): Uint8Array {
  if (text.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(text)) throw new ProtocolError("bad_hex");
  const out = new Uint8Array(text.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(text.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Equality that does not stop at the first difference. */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export function utf8Encode(text: string): Uint8Array {
  return encoder.encode(text);
}

export function utf8Decode(bytes: Uint8Array): string {
  try {
    return decoder.decode(bytes);
  } catch {
    throw new ProtocolError("bad_utf8");
  }
}

export function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  crypto.getRandomValues(out);
  return out;
}

export async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bs(bytes)));
}

export function writeU32BE(target: Uint8Array, offset: number, value: number): void {
  new DataView(target.buffer, target.byteOffset, target.byteLength).setUint32(offset, value, false);
}

export function readU32BE(source: Uint8Array, offset: number): number {
  return new DataView(source.buffer, source.byteOffset, source.byteLength).getUint32(offset, false);
}

export function writeU64BE(target: Uint8Array, offset: number, value: bigint): void {
  new DataView(target.buffer, target.byteOffset, target.byteLength).setBigUint64(offset, value, false);
}

export function readU64BE(source: Uint8Array, offset: number): bigint {
  return new DataView(source.buffer, source.byteOffset, source.byteLength).getBigUint64(offset, false);
}
