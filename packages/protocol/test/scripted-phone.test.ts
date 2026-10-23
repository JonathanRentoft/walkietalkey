import { describe, expect, it } from "vitest";
import { BLOCK_BYTES, randomBytes } from "../src/index.ts";
import { encodeWav, parseWav, splitBlocks } from "../scripts/wav.ts";
import { packResend } from "../scripts/scripted-phone.ts";

describe("WAV helpers", () => {
  it("round-trips 16 kHz mono PCM16", () => {
    const pcm = randomBytes(9600);
    const wav = encodeWav(pcm);
    expect(wav.length).toBe(44 + 9600);
    const back = parseWav(wav);
    expect(back.sampleRate).toBe(16000);
    expect(back.channels).toBe(1);
    expect(Buffer.from(back.pcm).equals(Buffer.from(pcm))).toBe(true);
  });

  it("refuses other formats", () => {
    const wav = encodeWav(randomBytes(100));
    const stereo = wav.slice();
    new DataView(stereo.buffer).setUint16(22, 2, true);
    expect(() => parseWav(stereo)).toThrow();
    const rate = wav.slice();
    new DataView(rate.buffer).setUint32(24, 44100, true);
    expect(() => parseWav(rate)).toThrow();
    expect(() => parseWav(new Uint8Array(10))).toThrow();
  });

  it("splits into 200 ms blocks with a shorter last block", () => {
    const blocks = splitBlocks(new Uint8Array(BLOCK_BYTES * 2 + 640));
    expect(blocks.map((b) => b.length)).toEqual([
      BLOCK_BYTES,
      BLOCK_BYTES,
      640,
    ]);
    expect(splitBlocks(new Uint8Array(BLOCK_BYTES * 2)).length).toBe(2);
  });
});

describe("resend packing (PHONE-32)", () => {
  it("packs up to 10 blocks per frame, in order", () => {
    const blocks = Array.from({ length: 23 }, (_, i) =>
      new Uint8Array(BLOCK_BYTES).fill(i),
    );
    blocks.push(new Uint8Array(100).fill(99));
    const frames = packResend(blocks);
    expect(frames.map((f) => [f.firstIndex, f.pcm.length])).toEqual([
      [0, BLOCK_BYTES * 10],
      [10, BLOCK_BYTES * 10],
      [20, BLOCK_BYTES * 3 + 100],
    ]);
    expect(frames[1]!.pcm[0]).toBe(10);
    expect(frames[2]!.pcm[BLOCK_BYTES * 3]).toBe(99);
  });
});
