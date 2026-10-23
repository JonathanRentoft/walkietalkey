import { describe, expect, it } from "vitest";
import {
  BLOCK_BYTES,
  FrameType,
  MAX_BLOCKS_PER_FRAME,
  ProtocolError,
  b64uEncode,
  decodePayload,
  encodePayload,
  randomBytes,
  utf8Decode,
  utf8Encode,
  type DevicePayload,
} from "../src/index.ts";

const sessionId = randomBytes(16);
const sid = b64uEncode(sessionId);

function roundTrip(p: DevicePayload): DevicePayload {
  const { frameType, bytes } = encodePayload(p);
  return decodePayload(frameType, bytes);
}

describe("JSON payloads", () => {
  it("encode with the exact key order of Appendix C.2", () => {
    const cases: [DevicePayload, number, string][] = [
      [{ type: "device_info", name: "Jonathans iPhone", platform: "ios" }, 0x10, '{"name":"Jonathans iPhone","platform":"ios"}'],
      [{ type: "presence", secondsSinceInput: 12, locked: false }, 0x11, '{"secondsSinceInput":12,"locked":false}'],
      [{ type: "presence_query" }, 0x12, "{}"],
      [
        { type: "audio_start", sessionId, sampleRate: 16000, codec: "pcm16" },
        0x20,
        `{"sessionId":"${sid}","sampleRate":16000,"codec":"pcm16"}`,
      ],
      [
        { type: "audio_end", sessionId, chunks: 75, durationMs: 15000 },
        0x22,
        `{"sessionId":"${sid}","chunks":75,"durationMs":15000}`,
      ],
      [{ type: "audio_cancel", sessionId }, 0x23, `{"sessionId":"${sid}"}`],
      [{ type: "result", sessionId, ok: true }, 0x30, `{"sessionId":"${sid}","ok":true}`],
      [
        { type: "result", sessionId, ok: false, reason: "no_speech" },
        0x30,
        `{"sessionId":"${sid}","ok":false,"reason":"no_speech"}`,
      ],
    ];
    for (const [payload, type, json] of cases) {
      const enc = encodePayload(payload);
      expect(enc.frameType).toBe(type);
      expect(utf8Decode(enc.bytes)).toBe(json);
      expect(roundTrip(payload)).toEqual(payload);
    }
  });

  it("decodes regardless of key order and ignores unknown keys", () => {
    const p = decodePayload(0x22, utf8Encode(`{"durationMs":200,"extra":1,"chunks":1,"sessionId":"${sid}"}`));
    expect(p).toEqual({ type: "audio_end", sessionId, chunks: 1, durationMs: 200 });
  });

  it("maps unknown result reasons to error and rejects inconsistent results", () => {
    expect(decodePayload(0x30, utf8Encode(`{"sessionId":"${sid}","ok":false,"reason":"future_reason"}`))).toEqual({
      type: "result",
      sessionId,
      ok: false,
      reason: "error",
    });
    expect(() => decodePayload(0x30, utf8Encode(`{"sessionId":"${sid}","ok":false}`))).toThrow(ProtocolError);
    expect(() => decodePayload(0x30, utf8Encode(`{"sessionId":"${sid}","ok":true,"reason":"error"}`))).toThrow(
      ProtocolError,
    );
  });

  it("rejects invalid fields", () => {
    const bad: [number, string][] = [
      [0x10, '{"name":5,"platform":"ios"}'],
      [0x10, `{"name":"${"x".repeat(257)}","platform":"ios"}`],
      [0x10, '{"name":"a"}'],
      [0x11, '{"secondsSinceInput":-1,"locked":false}'],
      [0x11, '{"secondsSinceInput":1.5,"locked":false}'],
      [0x11, '{"secondsSinceInput":1,"locked":"no"}'],
      [0x20, `{"sessionId":"${sid}","sampleRate":48000,"codec":"pcm16"}`],
      [0x20, `{"sessionId":"${sid}","sampleRate":16000,"codec":"opus"}`],
      [0x20, '{"sessionId":"AAAA","sampleRate":16000,"codec":"pcm16"}'],
      [0x22, `{"sessionId":"${sid}","chunks":4294967296,"durationMs":1}`],
      [0x23, "{}"],
      [0x12, "[]"],
      [0x12, "not json"],
      [0x30, `{"sessionId":"${sid}","ok":1}`],
      [0x99, "{}"],
    ];
    for (const [type, json] of bad) {
      expect(() => decodePayload(type, utf8Encode(json)), json).toThrow(ProtocolError);
    }
  });

  it("rejects text that is not valid UTF-8", () => {
    expect(() => decodePayload(0x12, new Uint8Array([0x7b, 0xff, 0x7d]))).toThrow(ProtocolError);
  });
});

describe("audio_chunk payload", () => {
  it("is sessionId ‖ firstIndex (u32 BE) ‖ PCM16", () => {
    const pcm = randomBytes(BLOCK_BYTES * 2);
    const { frameType, bytes } = encodePayload({ type: "audio_chunk", sessionId, firstIndex: 0x01020304, pcm });
    expect(frameType).toBe(FrameType.AudioChunk);
    expect(bytes.length).toBe(20 + BLOCK_BYTES * 2);
    expect([...bytes.subarray(16, 20)]).toEqual([1, 2, 3, 4]);
    const decoded = decodePayload(frameType, bytes);
    expect(decoded).toEqual({ type: "audio_chunk", sessionId, firstIndex: 0x01020304, pcm });
  });

  it("accepts 1 to 10 blocks and a shorter final block", () => {
    for (const len of [2, 640, BLOCK_BYTES, BLOCK_BYTES * MAX_BLOCKS_PER_FRAME, BLOCK_BYTES * 3 + 100]) {
      expect(roundTrip({ type: "audio_chunk", sessionId, firstIndex: 0, pcm: new Uint8Array(len) })).toMatchObject({
        type: "audio_chunk",
      });
    }
  });

  it("rejects empty, odd-length and oversized PCM", () => {
    for (const len of [0, 1, 641, BLOCK_BYTES * MAX_BLOCKS_PER_FRAME + 2]) {
      expect(() => encodePayload({ type: "audio_chunk", sessionId, firstIndex: 0, pcm: new Uint8Array(len) })).toThrow(
        ProtocolError,
      );
      const raw = new Uint8Array(20 + len);
      expect(() => decodePayload(0x21, raw)).toThrow(ProtocolError);
    }
    expect(() => decodePayload(0x21, new Uint8Array(19))).toThrow(ProtocolError);
  });
});
