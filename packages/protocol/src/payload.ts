import { b64uDecode, b64uEncode, readU32BE, utf8Decode, utf8Encode, writeU32BE } from "./bytes.ts";
import {
  AUDIO_CHUNK_HEADER_LEN,
  BLOCK_BYTES,
  FrameType,
  MAX_BLOCKS_PER_FRAME,
  MAX_DEVICE_NAME_BYTES,
  MAX_PLATFORM_BYTES,
  MAX_U32,
  RESULT_REASONS,
  SAMPLE_RATE,
  SESSION_ID_LEN,
  type ResultReason,
} from "./constants.ts";
import { ProtocolError } from "./errors.ts";

/** Decrypted device frame payloads (Appendix C.2). */
export type DevicePayload =
  | { type: "device_info"; name: string; platform: string }
  | { type: "presence"; secondsSinceInput: number; locked: boolean }
  | { type: "presence_query" }
  | { type: "audio_start"; sessionId: Uint8Array; sampleRate: 16000; codec: "pcm16" }
  | { type: "audio_chunk"; sessionId: Uint8Array; firstIndex: number; pcm: Uint8Array }
  | { type: "audio_end"; sessionId: Uint8Array; chunks: number; durationMs: number }
  | { type: "audio_cancel"; sessionId: Uint8Array }
  | { type: "result"; sessionId: Uint8Array; ok: true }
  | { type: "result"; sessionId: Uint8Array; ok: false; reason: ResultReason };

export type DevicePayloadType = DevicePayload["type"];

export const PAYLOAD_FRAME_TYPE: Record<DevicePayloadType, number> = {
  device_info: FrameType.DeviceInfo,
  presence: FrameType.Presence,
  presence_query: FrameType.PresenceQuery,
  audio_start: FrameType.AudioStart,
  audio_chunk: FrameType.AudioChunk,
  audio_end: FrameType.AudioEnd,
  audio_cancel: FrameType.AudioCancel,
  result: FrameType.Result,
};

/** Who may send each payload type. */
export const PAYLOAD_DIRECTION: Record<DevicePayloadType, "p2c" | "c2p"> = {
  device_info: "p2c",
  presence: "c2p",
  presence_query: "p2c",
  audio_start: "p2c",
  audio_chunk: "p2c",
  audio_end: "p2c",
  audio_cancel: "p2c",
  result: "c2p",
};

const TYPE_BY_FRAME = new Map<number, DevicePayloadType>(
  Object.entries(PAYLOAD_FRAME_TYPE).map(([k, v]) => [v, k as DevicePayloadType]),
);

export function payloadTypeOf(frameType: number): DevicePayloadType | undefined {
  return TYPE_BY_FRAME.get(frameType);
}

function bad(msg: string): never {
  throw new ProtocolError("bad_payload", msg);
}

function checkSessionId(id: Uint8Array): void {
  if (!(id instanceof Uint8Array) || id.length !== SESSION_ID_LEN) bad("sessionId must be 16 bytes");
}

function checkU32(n: unknown, what: string): number {
  if (typeof n !== "number" || !Number.isInteger(n) || n < 0 || n > MAX_U32) bad(`${what} must be a uint32`);
  return n;
}

function checkString(s: unknown, maxBytes: number, what: string): string {
  if (typeof s !== "string") bad(`${what} must be a string`);
  if (utf8Encode(s).length > maxBytes) bad(`${what} longer than ${maxBytes} bytes`);
  return s;
}

function checkPcm(pcm: Uint8Array): void {
  if (pcm.length === 0 || pcm.length % 2 !== 0) bad("PCM16 needs a whole, non-zero number of samples");
  if (pcm.length > BLOCK_BYTES * MAX_BLOCKS_PER_FRAME) bad("more than 10 blocks in one frame");
}

function json(obj: unknown): Uint8Array {
  return utf8Encode(JSON.stringify(obj));
}

/** Serializes a payload to its plaintext bytes and frame type. JSON keys follow Appendix C.2 order. */
export function encodePayload(p: DevicePayload): { frameType: number; bytes: Uint8Array } {
  const frameType = PAYLOAD_FRAME_TYPE[p.type];
  if (frameType === undefined) bad("unknown payload type");
  switch (p.type) {
    case "device_info":
      checkString(p.name, MAX_DEVICE_NAME_BYTES, "name");
      checkString(p.platform, MAX_PLATFORM_BYTES, "platform");
      return { frameType, bytes: json({ name: p.name, platform: p.platform }) };
    case "presence":
      checkU32(p.secondsSinceInput, "secondsSinceInput");
      if (typeof p.locked !== "boolean") bad("locked must be a boolean");
      return { frameType, bytes: json({ secondsSinceInput: p.secondsSinceInput, locked: p.locked }) };
    case "presence_query":
      return { frameType, bytes: json({}) };
    case "audio_start":
      checkSessionId(p.sessionId);
      if (p.sampleRate !== SAMPLE_RATE || p.codec !== "pcm16") bad("only 16 kHz pcm16 is supported");
      return {
        frameType,
        bytes: json({ sessionId: b64uEncode(p.sessionId), sampleRate: SAMPLE_RATE, codec: "pcm16" }),
      };
    case "audio_chunk": {
      checkSessionId(p.sessionId);
      checkU32(p.firstIndex, "firstIndex");
      checkPcm(p.pcm);
      const out = new Uint8Array(AUDIO_CHUNK_HEADER_LEN + p.pcm.length);
      out.set(p.sessionId, 0);
      writeU32BE(out, SESSION_ID_LEN, p.firstIndex);
      out.set(p.pcm, AUDIO_CHUNK_HEADER_LEN);
      return { frameType, bytes: out };
    }
    case "audio_end":
      checkSessionId(p.sessionId);
      checkU32(p.chunks, "chunks");
      checkU32(p.durationMs, "durationMs");
      return {
        frameType,
        bytes: json({ sessionId: b64uEncode(p.sessionId), chunks: p.chunks, durationMs: p.durationMs }),
      };
    case "audio_cancel":
      checkSessionId(p.sessionId);
      return { frameType, bytes: json({ sessionId: b64uEncode(p.sessionId) }) };
    case "result":
      checkSessionId(p.sessionId);
      if (p.ok === true) return { frameType, bytes: json({ sessionId: b64uEncode(p.sessionId), ok: true }) };
      if (p.ok !== false || !RESULT_REASONS.includes(p.reason)) bad("a failed result needs a known reason");
      return { frameType, bytes: json({ sessionId: b64uEncode(p.sessionId), ok: false, reason: p.reason }) };
  }
  return bad("unknown payload type");
}

function parseObject(bytes: Uint8Array): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(utf8Decode(bytes));
  } catch (e) {
    if (e instanceof ProtocolError) bad("not UTF-8");
    bad("not JSON");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) bad("not a JSON object");
  return value as Record<string, unknown>;
}

function sessionIdField(o: Record<string, unknown>): Uint8Array {
  if (typeof o.sessionId !== "string") bad("sessionId missing");
  try {
    return b64uDecode(o.sessionId, SESSION_ID_LEN);
  } catch {
    return bad("sessionId must be 16 bytes base64url");
  }
}

/**
 * Parses a decrypted payload for the given frame type. Unknown JSON keys are ignored; unknown
 * result reasons become "error". Throws ProtocolError("bad_payload") for anything else invalid.
 */
export function decodePayload(frameType: number, bytes: Uint8Array): DevicePayload {
  const type = payloadTypeOf(frameType);
  if (!type) bad(`unknown frame type 0x${frameType.toString(16)}`);
  if (type === "audio_chunk") {
    if (bytes.length < AUDIO_CHUNK_HEADER_LEN) bad("audio_chunk too short");
    const pcm = bytes.slice(AUDIO_CHUNK_HEADER_LEN);
    checkPcm(pcm);
    return {
      type,
      sessionId: bytes.slice(0, SESSION_ID_LEN),
      firstIndex: readU32BE(bytes, SESSION_ID_LEN),
      pcm,
    };
  }
  const o = parseObject(bytes);
  switch (type) {
    case "device_info":
      return {
        type,
        name: checkString(o.name, MAX_DEVICE_NAME_BYTES, "name"),
        platform: checkString(o.platform, MAX_PLATFORM_BYTES, "platform"),
      };
    case "presence":
      if (typeof o.locked !== "boolean") bad("locked must be a boolean");
      return { type, secondsSinceInput: checkU32(o.secondsSinceInput, "secondsSinceInput"), locked: o.locked };
    case "presence_query":
      return { type };
    case "audio_start": {
      const sessionId = sessionIdField(o);
      if (o.sampleRate !== SAMPLE_RATE || o.codec !== "pcm16") bad("only 16 kHz pcm16 is supported");
      return { type, sessionId, sampleRate: SAMPLE_RATE, codec: "pcm16" };
    }
    case "audio_end":
      return {
        type,
        sessionId: sessionIdField(o),
        chunks: checkU32(o.chunks, "chunks"),
        durationMs: checkU32(o.durationMs, "durationMs"),
      };
    case "audio_cancel":
      return { type, sessionId: sessionIdField(o) };
    case "result": {
      const sessionId = sessionIdField(o);
      if (o.ok === true) {
        if (o.reason !== undefined) bad("a successful result has no reason");
        return { type, sessionId, ok: true };
      }
      if (o.ok !== false) bad("ok must be a boolean");
      if (typeof o.reason !== "string") bad("a failed result needs a reason");
      const reason = (RESULT_REASONS as readonly string[]).includes(o.reason) ? (o.reason as ResultReason) : "error";
      return { type, sessionId, ok: false, reason };
    }
  }
  return bad("unknown payload type");
}
