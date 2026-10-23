import { b64uDecode } from "./bytes.ts";
import {
  CHALLENGE_LEN,
  DEVICE_ID_LEN,
  MAC_LEN,
  SALT_LEN,
  SECRET_LEN,
  SHA256_LEN,
  SIGNATURE_LEN,
  type Role,
} from "./constants.ts";
import { ProtocolError } from "./errors.ts";
import { assertSpki } from "./keys.ts";

/** A member as listed in `ok` (RELAY-02). `lastSeenDay` is days since 1970-01-01 UTC. */
export interface MemberInfo {
  id: string;
  role: Role;
  online: boolean;
  lastSeenDay: number;
}

/** Owner commands the relay confirms with `ack` (extension, see PROTOCOL.md). */
export type AckOp = "add_admission" | "cancel_admission" | "revoke";

/**
 * Control messages (Appendix C.1). Binary fields are base64url strings without padding;
 * parseControlMessage checks their decoded lengths.
 */
export type ControlMessage =
  | { t: "challenge"; n: string }
  | { t: "auth"; id: string; sig: string }
  | { t: "create"; pub: string; salt: string; sig: string }
  | {
      t: "join";
      a: string;
      pub: string;
      agree: string;
      mac: string;
      sig: string;
    }
  | { t: "ok"; role: Role; members: MemberInfo[] }
  | { t: "add_admission"; h: string; exp: number }
  | { t: "cancel_admission"; h: string }
  | {
      t: "member_joined";
      id: string;
      pub: string;
      agree: string;
      mac: string;
      eid: number;
    }
  | { t: "member_left"; id: string; eid: number }
  | { t: "event_ack"; eid: number }
  | { t: "ack"; op: AckOp; h?: string; id?: string }
  | { t: "leave" }
  | { t: "revoke"; id: string }
  | { t: "delete_room" }
  | { t: "peer"; id: string; online: boolean }
  | { t: "error"; code: string; msg: string }
  | { t: "ping" }
  | { t: "pong" };

export type ControlType = ControlMessage["t"];
export type ControlOf<T extends ControlType> = Extract<
  ControlMessage,
  { t: T }
>;

type FieldKind =
  | { k: "bytes"; len: number }
  | { k: "spki" }
  | { k: "bool" }
  | { k: "uint" }
  | { k: "role" }
  | { k: "str"; max: number }
  | { k: "members" }
  | { k: "op" };

interface FieldSpec {
  name: string;
  kind: FieldKind;
  optional?: boolean;
}

const bytes = (len: number): FieldKind => ({ k: "bytes", len });
const f = (name: string, kind: FieldKind, optional = false): FieldSpec => ({
  name,
  kind,
  optional,
});

/** Field order here is the serialization order. */
const SCHEMA: Record<ControlType, FieldSpec[]> = {
  challenge: [f("n", bytes(CHALLENGE_LEN))],
  auth: [f("id", bytes(DEVICE_ID_LEN)), f("sig", bytes(SIGNATURE_LEN))],
  create: [
    f("pub", { k: "spki" }),
    f("salt", bytes(SALT_LEN)),
    f("sig", bytes(SIGNATURE_LEN)),
  ],
  join: [
    f("a", bytes(SECRET_LEN)),
    f("pub", { k: "spki" }),
    f("agree", { k: "spki" }),
    f("mac", bytes(MAC_LEN)),
    f("sig", bytes(SIGNATURE_LEN)),
  ],
  ok: [f("role", { k: "role" }), f("members", { k: "members" })],
  add_admission: [f("h", bytes(SHA256_LEN)), f("exp", { k: "uint" })],
  cancel_admission: [f("h", bytes(SHA256_LEN))],
  member_joined: [
    f("id", bytes(DEVICE_ID_LEN)),
    f("pub", { k: "spki" }),
    f("agree", { k: "spki" }),
    f("mac", bytes(MAC_LEN)),
    f("eid", { k: "uint" }),
  ],
  member_left: [f("id", bytes(DEVICE_ID_LEN)), f("eid", { k: "uint" })],
  event_ack: [f("eid", { k: "uint" })],
  ack: [
    f("op", { k: "op" }),
    f("h", bytes(SHA256_LEN), true),
    f("id", bytes(DEVICE_ID_LEN), true),
  ],
  leave: [],
  revoke: [f("id", bytes(DEVICE_ID_LEN))],
  delete_room: [],
  peer: [f("id", bytes(DEVICE_ID_LEN)), f("online", { k: "bool" })],
  error: [f("code", { k: "str", max: 64 }), f("msg", { k: "str", max: 512 })],
  ping: [],
  pong: [],
};

const ACK_OPS: readonly string[] = [
  "add_admission",
  "cancel_admission",
  "revoke",
];
const MAX_MEMBERS = 64;

function bad(msg: string): never {
  throw new ProtocolError("bad_message", msg);
}

function checkB64(value: unknown, len: number, what: string): string {
  if (typeof value !== "string") bad(`${what} must be base64url`);
  try {
    b64uDecode(value, len);
  } catch {
    bad(`${what} must be ${len} bytes base64url`);
  }
  return value;
}

function checkUint(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    bad(`${what} must be a non-negative integer`);
  return value;
}

function checkRole(value: unknown): Role {
  if (value !== "owner" && value !== "phone")
    bad("role must be owner or phone");
  return value;
}

function checkField(value: unknown, spec: FieldSpec): unknown {
  const kind = spec.kind;
  switch (kind.k) {
    case "bytes":
      return checkB64(value, kind.len, spec.name);
    case "spki": {
      if (typeof value !== "string") bad(`${spec.name} must be base64url SPKI`);
      try {
        assertSpki(b64uDecode(value));
      } catch {
        bad(`${spec.name} must be a P-256 SPKI`);
      }
      return value;
    }
    case "bool":
      if (typeof value !== "boolean") bad(`${spec.name} must be a boolean`);
      return value;
    case "uint":
      return checkUint(value, spec.name);
    case "role":
      return checkRole(value);
    case "str":
      if (typeof value !== "string" || value.length > kind.max)
        bad(`${spec.name} must be a short string`);
      return value;
    case "op":
      if (typeof value !== "string" || !ACK_OPS.includes(value))
        bad("unknown ack op");
      return value;
    case "members": {
      if (!Array.isArray(value) || value.length > MAX_MEMBERS)
        bad("members must be a list");
      return value.map((m: unknown) => {
        if (typeof m !== "object" || m === null || Array.isArray(m))
          bad("member must be an object");
        const o = m as Record<string, unknown>;
        if (typeof o.online !== "boolean")
          bad("member.online must be a boolean");
        return {
          id: checkB64(o.id, DEVICE_ID_LEN, "member.id"),
          role: checkRole(o.role),
          online: o.online,
          lastSeenDay: checkUint(o.lastSeenDay, "member.lastSeenDay"),
        } satisfies MemberInfo;
      });
    }
  }
}

function build(
  t: ControlType,
  source: Record<string, unknown>,
): ControlMessage {
  const out: Record<string, unknown> = { t };
  for (const spec of SCHEMA[t]) {
    const value = source[spec.name];
    if (value === undefined) {
      if (spec.optional) continue;
      bad(`${t}.${spec.name} missing`);
    }
    out[spec.name] = checkField(value, spec);
  }
  return out as ControlMessage;
}

/**
 * Parses and validates one control message (a WebSocket text frame). Unknown fields are
 * dropped. Throws ProtocolError("bad_message" or "unknown_message").
 */
export function parseControlMessage(text: string): ControlMessage {
  if (typeof text !== "string") bad("not text");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    bad("not JSON");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value))
    bad("not a JSON object");
  const o = value as Record<string, unknown>;
  if (typeof o.t !== "string") bad("t missing");
  if (!Object.prototype.hasOwnProperty.call(SCHEMA, o.t))
    throw new ProtocolError("unknown_message", o.t.slice(0, 32));
  return build(o.t as ControlType, o);
}

/** Validates and serializes a control message with a fixed key order (`t` first). */
export function serializeControlMessage(msg: ControlMessage): string {
  if (!Object.prototype.hasOwnProperty.call(SCHEMA, msg.t))
    throw new ProtocolError("unknown_message", String(msg.t));
  return JSON.stringify(
    build(msg.t, msg as unknown as Record<string, unknown>),
  );
}
