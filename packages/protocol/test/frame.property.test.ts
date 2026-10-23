import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  FRAME_OVERHEAD,
  MAX_PLAINTEXT_LEN,
  ProtocolError,
  bytesEqual,
  decodePayload,
  openFrame,
  parseControlMessage,
  parseFrame,
  sealFrame,
} from "../src/index.ts";
import { aesKey } from "./helpers.ts";

const id = fc.uint8Array({ minLength: 16, maxLength: 16 });

describe("frame parsing properties", () => {
  it("random bytes never throw anything but ProtocolError", () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 400 }), (bytes) => {
        try {
          parseFrame(bytes);
        } catch (e) {
          expect(e).toBeInstanceOf(ProtocolError);
        }
      }),
      { numRuns: 2000 },
    );
  });

  it("random bytes with a valid version byte parse when long enough", () => {
    fc.assert(
      fc.property(
        fc.uint8Array({ minLength: FRAME_OVERHEAD, maxLength: 400 }),
        (bytes) => {
          bytes[0] = 1;
          const parsed = parseFrame(bytes);
          expect(parsed.ciphertext.length).toBe(bytes.length - 54);
        },
      ),
    );
  });

  it("random payload bytes never throw anything but ProtocolError", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 255 }),
        fc.uint8Array({ maxLength: 200 }),
        (type, bytes) => {
          try {
            decodePayload(type, bytes);
          } catch (e) {
            expect(e).toBeInstanceOf(ProtocolError);
          }
        },
      ),
      { numRuns: 2000 },
    );
  });

  it("random JSON-ish control text never throws anything but ProtocolError", () => {
    const text = fc.oneof(
      fc.string(),
      fc.json(),
      fc
        .record({
          t: fc.constantFrom(
            "auth",
            "join",
            "ok",
            "peer",
            "member_joined",
            "error",
            "ping",
          ),
        })
        .map((o) => JSON.stringify(o)),
    );
    fc.assert(
      fc.property(text, (t) => {
        try {
          parseControlMessage(t);
        } catch (e) {
          expect(e).toBeInstanceOf(ProtocolError);
        }
      }),
      { numRuns: 2000 },
    );
  });

  it("seal then open round-trips", async () => {
    const key = await aesKey();
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 255 }),
        id,
        id,
        fc.bigInt({ min: 1n, max: (1n << 64n) - 1n }),
        fc.uint8Array({ maxLength: 2000 }),
        async (type, sender, recipient, counter, plaintext) => {
          const frame = await sealFrame(
            key,
            { type, sender, recipient, counter },
            plaintext,
          );
          const opened = await openFrame(key, frame, { recipient, sender });
          expect(opened.header.type).toBe(type);
          expect(opened.header.counter).toBe(counter);
          expect(bytesEqual(opened.plaintext, plaintext)).toBe(true);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("any single-bit change in header or ciphertext fails to open", async () => {
    const key = await aesKey();
    await fc.assert(
      fc.asyncProperty(
        id,
        id,
        fc.uint8Array({ maxLength: 300 }),
        fc.nat(),
        fc.integer({ min: 0, max: 7 }),
        async (sender, recipient, plaintext, pos, bit) => {
          const frame = await sealFrame(
            key,
            { type: 0x21, sender, recipient, counter: 5n },
            plaintext,
          );
          const changed = frame.slice();
          const i = pos % changed.length;
          changed[i]! ^= 1 << bit;
          // Use the recipient that is now in the (possibly changed) header, so the
          // recipient check cannot be what catches the change.
          const headerRecipient =
            changed.length >= 34 ? changed.slice(18, 34) : recipient;
          await expect(
            openFrame(key, changed, { recipient: headerRecipient }),
          ).rejects.toBeInstanceOf(ProtocolError);
        },
      ),
      { numRuns: 300 },
    );
  });

  it("the maximum plaintext is exactly what fits in 65,536 bytes", () => {
    expect(MAX_PLAINTEXT_LEN + FRAME_OVERHEAD).toBe(65536);
  });
});
