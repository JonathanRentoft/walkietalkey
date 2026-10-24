import { describe, expect, it } from "vitest";
import {
  FrameType,
  MAX_PROMPT_ID_BYTES,
  MAX_TRAINING_TEXT_BYTES,
  PAYLOAD_DIRECTION,
  ProtocolError,
  b64uEncode,
  decodePayload,
  encodePayload,
  randomBytes,
  utf8Decode,
  utf8Encode,
  type DevicePayload,
} from "../src/index.ts";

/* Training payloads (PROTOCOL.md 8.2, spec 12.1): a recorded sentence for the fine-tuning
   workbench. 0x24 starts a take on the phone; 0x31 and 0x32 are the computer's prompt and the end
   of the session, the one deliberate exception to "text never goes back to the phone". */

const sessionId = randomBytes(16);
const training = randomBytes(16);
const sid = b64uEncode(sessionId);
const tid = b64uEncode(training);

function roundTrip(p: DevicePayload): DevicePayload {
  const { frameType, bytes } = encodePayload(p);
  return decodePayload(frameType, bytes);
}

describe("training payloads", () => {
  it("have their own frame types and directions", () => {
    expect(FrameType.AudioStartTraining).toBe(0x24);
    expect(FrameType.TrainingPrompt).toBe(0x31);
    expect(FrameType.TrainingEnd).toBe(0x32);
    expect(PAYLOAD_DIRECTION.audio_start_training).toBe("p2c");
    expect(PAYLOAD_DIRECTION.training_prompt).toBe("c2p");
    expect(PAYLOAD_DIRECTION.training_end).toBe("c2p");
  });

  it("encode with a fixed key order and round-trip", () => {
    const cases: [DevicePayload, number, string][] = [
      [
        {
          type: "audio_start_training",
          sessionId,
          sampleRate: 16000,
          codec: "pcm16",
          training,
          prompt: "s0042",
          microphone: "iPhone-mikrofon",
        },
        0x24,
        `{"sessionId":"${sid}","sampleRate":16000,"codec":"pcm16","training":"${tid}","prompt":"s0042","microphone":"iPhone-mikrofon"}`,
      ],
      [
        {
          type: "audio_start_training",
          sessionId,
          sampleRate: 16000,
          codec: "pcm16",
          training,
          prompt: "e01",
        },
        0x24,
        `{"sessionId":"${sid}","sampleRate":16000,"codec":"pcm16","training":"${tid}","prompt":"e01"}`,
      ],
      [
        {
          type: "training_prompt",
          training,
          style: "whisper",
          done: 12,
          total: 416,
          next: {
            prompt: "s0043",
            text: "Vi merger PR'en, når buildet er grønt.",
          },
          last: {
            prompt: "s0042",
            text: "Kan du deploye til staging?",
            check: "quiet",
          },
        },
        0x31,
        `{"training":"${tid}","style":"whisper","done":12,"total":416,` +
          `"next":{"prompt":"s0043","text":"Vi merger PR'en, når buildet er grønt."},` +
          `"last":{"prompt":"s0042","text":"Kan du deploye til staging?","check":"quiet"}}`,
      ],
      [
        {
          type: "training_prompt",
          training,
          style: "normal",
          done: 0,
          total: 3,
        },
        0x31,
        `{"training":"${tid}","style":"normal","done":0,"total":3}`,
      ],
      [{ type: "training_end", training }, 0x32, `{"training":"${tid}"}`],
    ];
    for (const [payload, type, json] of cases) {
      const enc = encodePayload(payload);
      expect(enc.frameType).toBe(type);
      expect(utf8Decode(enc.bytes)).toBe(json);
      expect(roundTrip(payload)).toEqual(payload);
    }
  });

  it("ignore unknown keys and map unknown checks to error", () => {
    const p = decodePayload(
      0x31,
      utf8Encode(
        `{"total":5,"later":true,"done":5,"style":"normal","training":"${tid}",` +
          `"last":{"check":"too_fast","text":"Hej","prompt":"e01","x":1}}`,
      ),
    );
    expect(p).toEqual({
      type: "training_prompt",
      training,
      style: "normal",
      done: 5,
      total: 5,
      last: { prompt: "e01", text: "Hej", check: "error" },
    });
  });

  it("refuse what does not fit", () => {
    const longId = "x".repeat(MAX_PROMPT_ID_BYTES + 1);
    const longText = "ø".repeat(MAX_TRAINING_TEXT_BYTES / 2 + 1);
    const bad: DevicePayload[] = [
      {
        type: "audio_start_training",
        sessionId,
        sampleRate: 16000,
        codec: "pcm16",
        training,
        prompt: "",
      },
      {
        type: "audio_start_training",
        sessionId,
        sampleRate: 16000,
        codec: "pcm16",
        training,
        prompt: longId,
      },
      {
        type: "audio_start_training",
        sessionId,
        sampleRate: 16000,
        codec: "pcm16",
        training: randomBytes(15),
        prompt: "s1",
      },
      {
        type: "training_prompt",
        training,
        style: "loud" as "normal",
        done: 0,
        total: 1,
      },
      {
        type: "training_prompt",
        training,
        style: "normal",
        done: -1,
        total: 1,
      },
      {
        type: "training_prompt",
        training,
        style: "normal",
        done: 0,
        total: 1,
        next: { prompt: "s1", text: longText },
      },
      {
        type: "training_prompt",
        training,
        style: "normal",
        done: 0,
        total: 1,
        next: { prompt: "s1", text: "" },
      },
    ];
    for (const p of bad)
      expect(() => encodePayload(p), JSON.stringify(p.type)).toThrow(
        ProtocolError,
      );
    const raw = [
      [
        0x24,
        `{"sessionId":"${sid}","sampleRate":16000,"codec":"pcm16","prompt":"s1"}`,
      ],
      [
        0x24,
        `{"sessionId":"${sid}","sampleRate":8000,"codec":"pcm16","training":"${tid}","prompt":"s1"}`,
      ],
      [
        0x24,
        `{"sessionId":"${sid}","sampleRate":16000,"codec":"pcm16","training":"${tid}","prompt":7}`,
      ],
      [0x31, `{"training":"${tid}","style":"normal","done":0}`],
      [
        0x31,
        `{"training":"${tid}","style":"normal","done":0,"total":1,"next":"s1"}`,
      ],
      [
        0x31,
        `{"training":"${tid}","style":"normal","done":0,"total":1,"next":{"prompt":"s1"}}`,
      ],
      [
        0x31,
        `{"training":"${tid}","style":"normal","done":0,"total":1,"last":{"prompt":"s1","text":"Hej"}}`,
      ],
      [0x32, `{}`],
    ] as const;
    for (const [type, json] of raw)
      expect(() => decodePayload(type, utf8Encode(json)), json).toThrow(
        ProtocolError,
      );
  });
});
