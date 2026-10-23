import { describe, expect, it } from "vitest";
import {
  AAD_LEN,
  FRAME_OVERHEAD,
  FrameType,
  MAX_FRAME_LEN,
  MAX_PLAINTEXT_LEN,
  ProtocolError,
  bytesEqual,
  openFrame,
  parseFrame,
  randomBytes,
  sealFrame,
} from "../src/index.ts";
import { sealFrameWithNonce } from "../src/testing.ts";
import { aesKey } from "./helpers.ts";

const sender = randomBytes(16);
const recipient = randomBytes(16);

describe("frame layout", () => {
  it("writes the header of spec 9.4", async () => {
    const key = await aesKey();
    const nonce = randomBytes(12);
    const frame = await sealFrameWithNonce(
      key,
      { type: FrameType.AudioStart, sender, recipient, counter: 0x0102030405060708n },
      new Uint8Array([1, 2, 3]),
      nonce,
    );
    expect(frame.length).toBe(FRAME_OVERHEAD + 3);
    expect(frame[0]).toBe(1);
    expect(frame[1]).toBe(0x20);
    expect(bytesEqual(frame.subarray(2, 18), sender)).toBe(true);
    expect(bytesEqual(frame.subarray(18, 34), recipient)).toBe(true);
    expect([...frame.subarray(34, 42)]).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(bytesEqual(frame.subarray(42, 54), nonce)).toBe(true);

    const parsed = parseFrame(frame);
    expect(parsed.header.version).toBe(1);
    expect(parsed.header.type).toBe(0x20);
    expect(parsed.header.counter).toBe(0x0102030405060708n);
    expect(bytesEqual(parsed.aad, frame.subarray(0, AAD_LEN))).toBe(true);
    expect(parsed.ciphertext.length).toBe(3 + 16);
  });

  it("random nonces differ per frame", async () => {
    const key = await aesKey();
    const h = { type: FrameType.AudioChunk, sender, recipient, counter: 1n };
    const a = await sealFrame(key, h, new Uint8Array(10));
    const b = await sealFrame(key, h, new Uint8Array(10));
    expect(bytesEqual(a.subarray(42, 54), b.subarray(42, 54))).toBe(false);
  });
});

describe("seal and open", () => {
  it("round-trips and checks the recipient", async () => {
    const key = await aesKey();
    const plaintext = randomBytes(500);
    const frame = await sealFrame(key, { type: FrameType.Result, sender, recipient, counter: 7n }, plaintext);
    const opened = await openFrame(key, frame, { recipient, sender });
    expect(bytesEqual(opened.plaintext, plaintext)).toBe(true);
    expect(opened.header.counter).toBe(7n);

    await expect(openFrame(key, frame, { recipient: sender })).rejects.toMatchObject({ code: "wrong_recipient" });
    await expect(openFrame(key, frame, { recipient, sender: recipient })).rejects.toMatchObject({
      code: "wrong_sender",
    });
    await expect(openFrame(await aesKey(), frame, { recipient })).rejects.toMatchObject({ code: "decrypt_failed" });
  });

  it("authenticates the header as AAD", async () => {
    const key = await aesKey();
    const frame = await sealFrame(key, { type: FrameType.AudioEnd, sender, recipient, counter: 3n }, randomBytes(40));
    for (const offset of [0, 1, 5, 20, 40, 41, 45, 60]) {
      const changed = frame.slice();
      changed[offset]! ^= 0x01;
      await expect(openFrame(key, changed, { recipient: changed.slice(18, 34) })).rejects.toBeInstanceOf(ProtocolError);
    }
  });

  it("enforces the maximum frame size", async () => {
    const key = await aesKey();
    const h = { type: FrameType.AudioChunk, sender, recipient, counter: 1n };
    const max = await sealFrame(key, h, new Uint8Array(MAX_PLAINTEXT_LEN));
    expect(max.length).toBe(MAX_FRAME_LEN);
    expect(MAX_FRAME_LEN).toBe(65536);
    await expect(sealFrame(key, h, new Uint8Array(MAX_PLAINTEXT_LEN + 1))).rejects.toMatchObject({
      code: "frame_too_large",
    });
    const tooBig = new Uint8Array(MAX_FRAME_LEN + 1);
    tooBig[0] = 1;
    expect(() => parseFrame(tooBig)).toThrow(ProtocolError);
  });

  it("rejects bad header values when sealing", async () => {
    const key = await aesKey();
    await expect(
      sealFrame(key, { type: FrameType.Result, sender: randomBytes(15), recipient, counter: 1n }, new Uint8Array()),
    ).rejects.toBeInstanceOf(ProtocolError);
    await expect(
      sealFrame(key, { type: FrameType.Result, sender, recipient, counter: 1n << 64n }, new Uint8Array()),
    ).rejects.toBeInstanceOf(ProtocolError);
    await expect(
      sealFrame(key, { type: FrameType.Result, sender, recipient, counter: 0n }, new Uint8Array()),
    ).rejects.toBeInstanceOf(ProtocolError);
    await expect(
      sealFrame(key, { type: 256, sender, recipient, counter: 1n }, new Uint8Array()),
    ).rejects.toBeInstanceOf(ProtocolError);
  });

  it("parse rejects short frames and unknown versions", () => {
    expect(() => parseFrame(new Uint8Array(FRAME_OVERHEAD - 1).fill(1))).toThrow(ProtocolError);
    const v2 = new Uint8Array(FRAME_OVERHEAD);
    v2[0] = 2;
    expect(() => parseFrame(v2)).toThrow(ProtocolError);
    const ok = new Uint8Array(FRAME_OVERHEAD);
    ok[0] = 1;
    expect(parseFrame(ok).ciphertext.length).toBe(16);
  });
});
