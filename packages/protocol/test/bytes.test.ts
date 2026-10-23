import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  ProtocolError,
  b64uDecode,
  b64uEncode,
  bytesEqual,
  concatBytes,
  hexDecode,
  hexEncode,
  utf8Decode,
  utf8Encode,
} from "../src/index.ts";

describe("base64url", () => {
  it("encodes without padding using the URL alphabet", () => {
    expect(b64uEncode(new Uint8Array([]))).toBe("");
    expect(b64uEncode(new Uint8Array([0xfb]))).toBe("-w");
    expect(b64uEncode(new Uint8Array([0xfb, 0xff]))).toBe("-_8");
    expect(b64uEncode(new Uint8Array([1, 2, 3]))).toBe("AQID");
    expect(b64uEncode(utf8Encode("hello"))).toBe("aGVsbG8");
  });

  it("round-trips arbitrary bytes", () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 300 }), (bytes) => {
        const text = b64uEncode(bytes);
        expect(text).not.toMatch(/[=+/]/);
        expect(bytesEqual(b64uDecode(text), bytes)).toBe(true);
      }),
    );
  });

  it("rejects padding, standard alphabet, bad lengths and non-canonical trailing bits", () => {
    for (const bad of [
      "AQID=",
      "aGVsbG8=",
      "+w",
      "/w",
      "A",
      "AQIDB",
      "-x",
      "AB",
      "a b",
      "é",
    ]) {
      expect(() => b64uDecode(bad), bad).toThrow(ProtocolError);
    }
    // "-w" is canonical for 0xfb; "-x" has non-zero trailing bits.
    expect(b64uDecode("-w")).toEqual(new Uint8Array([0xfb]));
    expect(b64uDecode("AA")).toEqual(new Uint8Array([0]));
  });

  it("decodes with an expected length", () => {
    expect(b64uDecode("AQID", 3)).toEqual(new Uint8Array([1, 2, 3]));
    expect(() => b64uDecode("AQID", 4)).toThrow(ProtocolError);
  });
});

describe("byte helpers", () => {
  it("concatenates", () => {
    expect(
      concatBytes(
        new Uint8Array([1]),
        new Uint8Array([]),
        new Uint8Array([2, 3]),
      ),
    ).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("compares", () => {
    expect(bytesEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(
      true,
    );
    expect(bytesEqual(new Uint8Array([1, 2]), new Uint8Array([1, 3]))).toBe(
      false,
    );
    expect(bytesEqual(new Uint8Array([1, 2]), new Uint8Array([1]))).toBe(false);
  });

  it("hex round-trips and rejects odd or invalid input", () => {
    expect(hexEncode(new Uint8Array([0, 0xab, 0xff]))).toBe("00abff");
    expect(hexDecode("00ABff")).toEqual(new Uint8Array([0, 0xab, 0xff]));
    expect(() => hexDecode("abc")).toThrow(ProtocolError);
    expect(() => hexDecode("zz")).toThrow(ProtocolError);
  });

  it("utf8 decoding is strict", () => {
    expect(utf8Decode(utf8Encode("Jonathans iPhone æøå"))).toBe(
      "Jonathans iPhone æøå",
    );
    expect(() => utf8Decode(new Uint8Array([0xff, 0xfe]))).toThrow(
      ProtocolError,
    );
  });
});
