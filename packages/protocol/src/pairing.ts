import { b64uDecode, b64uEncode, utf8Decode, utf8Encode } from "./bytes.ts";
import { MAX_COMPUTER_NAME_BYTES, ROOM_ID_LEN, SECRET_LEN, type ComputerOs, type Intent } from "./constants.ts";
import { ProtocolError } from "./errors.ts";
import { assertSpki } from "./keys.ts";

/** The QR payload of spec 5.3, with binary fields as bytes. */
export interface PairingPayload {
  v: 1;
  /** roomId (16 bytes) */
  r: Uint8Array;
  /** admission secret a (32 bytes) */
  a: Uint8Array;
  /** pairing secret s (32 bytes) */
  s: Uint8Array;
  /** computer agreement SPKI */
  e: Uint8Array;
  /** relay base URL, wss:// */
  u: string;
  /** computer name */
  n: string;
  /** computer OS, for the ⌘V or Ctrl+V hint */
  o: ComputerOs;
}

export interface UrlPolicy {
  /** Allow ws:// to localhost, 127.0.0.1 or [::1] (debug builds and tests only, SEC-06). */
  allowInsecureLocalhost?: boolean;
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Throws ProtocolError("bad_relay_url") unless the URL is wss:// (or ws:// to loopback when allowed). */
export function assertRelayUrl(url: string, policy: UrlPolicy = {}): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ProtocolError("bad_relay_url", "not a URL");
  }
  if (parsed.protocol === "wss:") return;
  if (parsed.protocol === "ws:" && policy.allowInsecureLocalhost && LOOPBACK.has(parsed.hostname)) return;
  throw new ProtocolError("bad_relay_url", "the relay must use wss://");
}

/** `<relayUrl>/v1/rooms/<roomId>/ws?intent=<intent>` (spec 8.2; intent is our extension). */
export function roomSocketUrl(relayUrl: string, roomId: Uint8Array, intent: Intent): string {
  if (roomId.length !== ROOM_ID_LEN) throw new ProtocolError("bad_length", "roomId must be 16 bytes");
  return `${relayUrl.replace(/\/+$/, "")}/v1/rooms/${b64uEncode(roomId)}/ws?intent=${intent}`;
}

/** `<phoneAppUrl>/p#<base64url(UTF-8 JSON)>`, JSON keys exactly v, r, a, s, e, u, n, o. */
export function encodePairingUrl(phoneAppUrl: string, p: PairingPayload): string {
  validate(p, { allowInsecureLocalhost: true });
  const json = JSON.stringify({
    v: 1,
    r: b64uEncode(p.r),
    a: b64uEncode(p.a),
    s: b64uEncode(p.s),
    e: b64uEncode(p.e),
    u: p.u,
    n: p.n,
    o: p.o,
  });
  return `${phoneAppUrl.replace(/\/+$/, "")}/p#${b64uEncode(utf8Encode(json))}`;
}

function bad(msg: string): never {
  throw new ProtocolError("bad_pairing_url", msg);
}

function validate(p: PairingPayload, policy: UrlPolicy): void {
  if (p.v !== 1) bad("unsupported version");
  if (!(p.r instanceof Uint8Array) || p.r.length !== ROOM_ID_LEN) bad("r must be 16 bytes");
  if (!(p.a instanceof Uint8Array) || p.a.length !== SECRET_LEN) bad("a must be 32 bytes");
  if (!(p.s instanceof Uint8Array) || p.s.length !== SECRET_LEN) bad("s must be 32 bytes");
  try {
    assertSpki(p.e);
  } catch {
    bad("e must be a P-256 SPKI");
  }
  if (typeof p.u !== "string") bad("u must be a string");
  try {
    assertRelayUrl(p.u, policy);
  } catch {
    bad("u must be a wss:// relay URL");
  }
  if (typeof p.n !== "string" || utf8Encode(p.n).length > MAX_COMPUTER_NAME_BYTES) bad("n must be a short string");
  if (p.o !== "mac" && p.o !== "win") bad("o must be mac or win");
}

function bytesField(o: Record<string, unknown>, key: string): Uint8Array {
  const v = o[key];
  if (typeof v !== "string") bad(`${key} missing`);
  try {
    return b64uDecode(v);
  } catch {
    return bad(`${key} is not base64url`);
  }
}

/** Decodes only the fragment part (after `#`). */
export function decodePairingFragment(fragment: string, policy: UrlPolicy = {}): PairingPayload {
  let o: unknown;
  try {
    o = JSON.parse(utf8Decode(b64uDecode(fragment)));
  } catch {
    bad("fragment is not base64url JSON");
  }
  if (typeof o !== "object" || o === null || Array.isArray(o)) bad("not a JSON object");
  const rec = o as Record<string, unknown>;
  const p = {
    v: rec.v,
    r: bytesField(rec, "r"),
    a: bytesField(rec, "a"),
    s: bytesField(rec, "s"),
    e: bytesField(rec, "e"),
    u: rec.u,
    n: rec.n,
    o: rec.o,
  } as PairingPayload;
  validate(p, policy);
  return p;
}

/** Decodes a pairing URL (any origin and path; the payload is after `#`). */
export function decodePairingUrl(url: string, policy: UrlPolicy = {}): PairingPayload {
  const hash = url.indexOf("#");
  if (hash < 0) bad("no fragment");
  return decodePairingFragment(url.slice(hash + 1), policy);
}
