import {
  b64uDecode,
  b64uEncode,
  readU32BE,
  utf8Decode,
  utf8Encode,
  writeU32BE,
} from "./bytes.ts";
import {
  AUDIO_CHUNK_HEADER_LEN,
  BLOCK_BYTES,
  FrameType,
  MAX_BLOCKS_PER_FRAME,
  MAX_DEVICE_NAME_BYTES,
  MAX_PLATFORM_BYTES,
  MAX_PROMPT_ID_BYTES,
  MAX_TRAINING_TEXT_BYTES,
  MAX_U32,
  RESULT_REASONS,
  SAMPLE_RATE,
  SESSION_ID_LEN,
  TRAINING_CHECKS,
  TRAINING_ID_LEN,
  TRAINING_STYLES,
  type ResultReason,
  type TrainingCheck,
  type TrainingStyle,
} from "./constants.ts";
import { ProtocolError } from "./errors.ts";

/** A sentence (or paragraph) of a training session: its prompt id and the text to read. */
export interface TrainingItem {
  prompt: string;
  text: string;
}

/** The take just made of a prompt, and how the computer judged it. */
export interface TrainingLast extends TrainingItem {
  check: TrainingCheck;
}

/** Decrypted device frame payloads (Appendix C.2). */
export type DevicePayload =
  | { type: "device_info"; name: string; platform: string }
  | { type: "presence"; secondsSinceInput: number; locked: boolean }
  | { type: "presence_query" }
  | {
      type: "audio_start";
      sessionId: Uint8Array;
      sampleRate: 16000;
      codec: "pcm16";
    }
  | {
      type: "audio_chunk";
      sessionId: Uint8Array;
      firstIndex: number;
      pcm: Uint8Array;
    }
  | {
      type: "audio_end";
      sessionId: Uint8Array;
      chunks: number;
      durationMs: number;
    }
  | { type: "audio_cancel"; sessionId: Uint8Array }
  | {
      type: "audio_start_training";
      sessionId: Uint8Array;
      sampleRate: 16000;
      codec: "pcm16";
      /** The training session the prompt came from. */
      training: Uint8Array;
      /** The prompt this take is a reading of. */
      prompt: string;
    }
  | { type: "result"; sessionId: Uint8Array; ok: true }
  | { type: "result"; sessionId: Uint8Array; ok: false; reason: ResultReason }
  | {
      type: "training_prompt";
      training: Uint8Array;
      style: TrainingStyle;
      /** Progress in this session's condition. */
      done: number;
      total: number;
      /** What to read now; absent when the condition is complete. */
      next?: TrainingItem;
      /** The take just made; absent before the first. */
      last?: TrainingLast;
    }
  | { type: "training_end"; training: Uint8Array };

export type DevicePayloadType = DevicePayload["type"];

export const PAYLOAD_FRAME_TYPE: Record<DevicePayloadType, number> = {
  device_info: FrameType.DeviceInfo,
  presence: FrameType.Presence,
  presence_query: FrameType.PresenceQuery,
  audio_start: FrameType.AudioStart,
  audio_chunk: FrameType.AudioChunk,
  audio_end: FrameType.AudioEnd,
  audio_cancel: FrameType.AudioCancel,
  audio_start_training: FrameType.AudioStartTraining,
  result: FrameType.Result,
  training_prompt: FrameType.TrainingPrompt,
  training_end: FrameType.TrainingEnd,
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
  audio_start_training: "p2c",
  result: "c2p",
  training_prompt: "c2p",
  training_end: "c2p",
};

const TYPE_BY_FRAME = new Map<number, DevicePayloadType>(
  Object.entries(PAYLOAD_FRAME_TYPE).map(([k, v]) => [
    v,
    k as DevicePayloadType,
  ]),
);

export function payloadTypeOf(
  frameType: number,
): DevicePayloadType | undefined {
  return TYPE_BY_FRAME.get(frameType);
}

function bad(msg: string): never {
  throw new ProtocolError("bad_payload", msg);
}

function checkSessionId(id: Uint8Array): void {
  if (!(id instanceof Uint8Array) || id.length !== SESSION_ID_LEN)
    bad("sessionId must be 16 bytes");
}

function checkU32(n: unknown, what: string): number {
  if (typeof n !== "number" || !Number.isInteger(n) || n < 0 || n > MAX_U32)
    bad(`${what} must be a uint32`);
  return n;
}

function checkString(s: unknown, maxBytes: number, what: string): string {
  if (typeof s !== "string") bad(`${what} must be a string`);
  if (utf8Encode(s).length > maxBytes)
    bad(`${what} longer than ${maxBytes} bytes`);
  return s;
}

function checkTrainingId(id: Uint8Array): void {
  if (!(id instanceof Uint8Array) || id.length !== TRAINING_ID_LEN)
    bad("training must be 16 bytes");
}

/** A non-empty string of at most `maxBytes` UTF-8 bytes. */
function checkNonEmpty(s: unknown, maxBytes: number, what: string): string {
  checkString(s, maxBytes, what);
  if ((s as string).length === 0) bad(`${what} must not be empty`);
  return s as string;
}

function checkStyle(s: unknown): TrainingStyle {
  if (!(TRAINING_STYLES as readonly unknown[]).includes(s))
    bad("style must be normal or whisper");
  return s as TrainingStyle;
}

function trainingItem(o: unknown, what: string): TrainingItem {
  if (typeof o !== "object" || o === null || Array.isArray(o))
    bad(`${what} must be an object`);
  const r = o as Record<string, unknown>;
  return {
    prompt: checkNonEmpty(r.prompt, MAX_PROMPT_ID_BYTES, `${what}.prompt`),
    text: checkNonEmpty(r.text, MAX_TRAINING_TEXT_BYTES, `${what}.text`),
  };
}

function checkPcm(pcm: Uint8Array): void {
  if (pcm.length === 0 || pcm.length % 2 !== 0)
    bad("PCM16 needs a whole, non-zero number of samples");
  if (pcm.length > BLOCK_BYTES * MAX_BLOCKS_PER_FRAME)
    bad("more than 10 blocks in one frame");
}

function json(obj: unknown): Uint8Array {
  return utf8Encode(JSON.stringify(obj));
}

/** Serializes a payload to its plaintext bytes and frame type. JSON keys follow Appendix C.2 order. */
export function encodePayload(p: DevicePayload): {
  frameType: number;
  bytes: Uint8Array;
} {
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
      return {
        frameType,
        bytes: json({
          secondsSinceInput: p.secondsSinceInput,
          locked: p.locked,
        }),
      };
    case "presence_query":
      return { frameType, bytes: json({}) };
    case "audio_start":
      checkSessionId(p.sessionId);
      if (p.sampleRate !== SAMPLE_RATE || p.codec !== "pcm16")
        bad("only 16 kHz pcm16 is supported");
      return {
        frameType,
        bytes: json({
          sessionId: b64uEncode(p.sessionId),
          sampleRate: SAMPLE_RATE,
          codec: "pcm16",
        }),
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
        bytes: json({
          sessionId: b64uEncode(p.sessionId),
          chunks: p.chunks,
          durationMs: p.durationMs,
        }),
      };
    case "audio_cancel":
      checkSessionId(p.sessionId);
      return { frameType, bytes: json({ sessionId: b64uEncode(p.sessionId) }) };
    case "audio_start_training":
      checkSessionId(p.sessionId);
      if (p.sampleRate !== SAMPLE_RATE || p.codec !== "pcm16")
        bad("only 16 kHz pcm16 is supported");
      checkTrainingId(p.training);
      checkNonEmpty(p.prompt, MAX_PROMPT_ID_BYTES, "prompt");
      return {
        frameType,
        bytes: json({
          sessionId: b64uEncode(p.sessionId),
          sampleRate: SAMPLE_RATE,
          codec: "pcm16",
          training: b64uEncode(p.training),
          prompt: p.prompt,
        }),
      };
    case "training_prompt": {
      checkTrainingId(p.training);
      checkStyle(p.style);
      checkU32(p.done, "done");
      checkU32(p.total, "total");
      const out: Record<string, unknown> = {
        training: b64uEncode(p.training),
        style: p.style,
        done: p.done,
        total: p.total,
      };
      if (p.next !== undefined) {
        const next = trainingItem(p.next, "next");
        out.next = { prompt: next.prompt, text: next.text };
      }
      if (p.last !== undefined) {
        const last = trainingItem(p.last, "last");
        if (!TRAINING_CHECKS.includes(p.last.check))
          bad("last.check is not a known check");
        out.last = {
          prompt: last.prompt,
          text: last.text,
          check: p.last.check,
        };
      }
      return { frameType, bytes: json(out) };
    }
    case "training_end":
      checkTrainingId(p.training);
      return { frameType, bytes: json({ training: b64uEncode(p.training) }) };
    case "result":
      checkSessionId(p.sessionId);
      if (p.ok === true)
        return {
          frameType,
          bytes: json({ sessionId: b64uEncode(p.sessionId), ok: true }),
        };
      if (p.ok !== false || !RESULT_REASONS.includes(p.reason))
        bad("a failed result needs a known reason");
      return {
        frameType,
        bytes: json({
          sessionId: b64uEncode(p.sessionId),
          ok: false,
          reason: p.reason,
        }),
      };
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
  if (typeof value !== "object" || value === null || Array.isArray(value))
    bad("not a JSON object");
  return value as Record<string, unknown>;
}

function trainingField(o: Record<string, unknown>): Uint8Array {
  if (typeof o.training !== "string") bad("training missing");
  try {
    return b64uDecode(o.training, TRAINING_ID_LEN);
  } catch {
    return bad("training must be 16 bytes base64url");
  }
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
export function decodePayload(
  frameType: number,
  bytes: Uint8Array,
): DevicePayload {
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
      return {
        type,
        secondsSinceInput: checkU32(o.secondsSinceInput, "secondsSinceInput"),
        locked: o.locked,
      };
    case "presence_query":
      return { type };
    case "audio_start": {
      const sessionId = sessionIdField(o);
      if (o.sampleRate !== SAMPLE_RATE || o.codec !== "pcm16")
        bad("only 16 kHz pcm16 is supported");
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
    case "audio_start_training": {
      const sessionId = sessionIdField(o);
      if (o.sampleRate !== SAMPLE_RATE || o.codec !== "pcm16")
        bad("only 16 kHz pcm16 is supported");
      return {
        type,
        sessionId,
        sampleRate: SAMPLE_RATE,
        codec: "pcm16",
        training: trainingField(o),
        prompt: checkNonEmpty(o.prompt, MAX_PROMPT_ID_BYTES, "prompt"),
      };
    }
    case "training_prompt": {
      const p: DevicePayload = {
        type,
        training: trainingField(o),
        style: checkStyle(o.style),
        done: checkU32(o.done, "done"),
        total: checkU32(o.total, "total"),
      };
      if (o.next !== undefined) p.next = trainingItem(o.next, "next");
      if (o.last !== undefined) {
        const last = trainingItem(o.last, "last");
        const check = (o.last as Record<string, unknown>).check;
        if (typeof check !== "string") bad("last.check must be a string");
        p.last = {
          ...last,
          // Forward compatibility, as with result reasons: a newer computer's check is "error".
          check: (TRAINING_CHECKS as readonly string[]).includes(check)
            ? (check as TrainingCheck)
            : "error",
        };
      }
      return p;
    }
    case "training_end":
      return { type, training: trainingField(o) };
    case "result": {
      const sessionId = sessionIdField(o);
      if (o.ok === true) {
        if (o.reason !== undefined) bad("a successful result has no reason");
        return { type, sessionId, ok: true };
      }
      if (o.ok !== false) bad("ok must be a boolean");
      if (typeof o.reason !== "string") bad("a failed result needs a reason");
      const reason = (RESULT_REASONS as readonly string[]).includes(o.reason)
        ? (o.reason as ResultReason)
        : "error";
      return { type, sessionId, ok: false, reason };
    }
  }
  return bad("unknown payload type");
}
