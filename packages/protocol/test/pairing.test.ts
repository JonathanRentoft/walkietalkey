import { describe, expect, it } from "vitest";
import {
  ProtocolError,
  assertRelayUrl,
  b64uDecode,
  b64uEncode,
  bytesEqual,
  decodePairingUrl,
  encodePairingUrl,
  generateDeviceKeys,
  randomBytes,
  roomSocketUrl,
  utf8Decode,
  utf8Encode,
  type PairingPayload,
} from "../src/index.ts";

async function payload(): Promise<PairingPayload> {
  const keys = await generateDeviceKeys();
  return {
    v: 1,
    r: randomBytes(16),
    a: randomBytes(32),
    s: randomBytes(32),
    e: keys.agreementSpki,
    u: "wss://relay.walkietalkey.com",
    n: "Jonathans MacBook Pro",
    o: "mac",
  };
}

describe("pairing URL", () => {
  it("is <phoneAppUrl>/p#<base64url(JSON)> with exactly the keys of spec 5.3", async () => {
    const p = await payload();
    const url = encodePairingUrl("https://app.walkietalkey.com/", p);
    expect(url.startsWith("https://app.walkietalkey.com/p#")).toBe(true);
    const json = utf8Decode(b64uDecode(url.split("#")[1]!));
    expect(Object.keys(JSON.parse(json))).toEqual(["v", "r", "a", "s", "e", "u", "n", "o"]);
    expect(JSON.parse(json).r).toBe(b64uEncode(p.r));
    const back = decodePairingUrl(url);
    expect(back.v).toBe(1);
    expect(bytesEqual(back.r, p.r)).toBe(true);
    expect(bytesEqual(back.a, p.a)).toBe(true);
    expect(bytesEqual(back.s, p.s)).toBe(true);
    expect(bytesEqual(back.e, p.e)).toBe(true);
    expect(back.u).toBe(p.u);
    expect(back.n).toBe(p.n);
    expect(back.o).toBe("mac");
  });

  it("keeps a company phone app path", async () => {
    const p = await payload();
    expect(encodePairingUrl("https://intranet.example.dk/walkietalkey", p)).toMatch(
      /^https:\/\/intranet\.example\.dk\/walkietalkey\/p#/,
    );
  });

  it("rejects malformed payloads", async () => {
    const p = await payload();
    const good = JSON.parse(utf8Decode(b64uDecode(encodePairingUrl("https://x.dk", p).split("#")[1]!)));
    const variants = [
      { ...good, v: 2 },
      { ...good, r: b64uEncode(randomBytes(15)) },
      { ...good, a: undefined },
      { ...good, e: b64uEncode(randomBytes(91)) },
      { ...good, o: "linux" },
      { ...good, u: "https://relay.example" },
      { ...good, u: "ws://relay.example" },
      { ...good, n: 7 },
    ];
    for (const v of variants) {
      const url = `https://x.dk/p#${b64uEncode(utf8Encode(JSON.stringify(v)))}`;
      expect(() => decodePairingUrl(url), JSON.stringify(v)).toThrow(ProtocolError);
    }
    expect(() => decodePairingUrl("https://x.dk/p")).toThrow(ProtocolError);
    expect(() => decodePairingUrl("https://x.dk/p#%%%")).toThrow(ProtocolError);
  });

  it("allows ws://localhost only when asked (SEC-06)", async () => {
    const p = { ...(await payload()), u: "ws://127.0.0.1:8787" };
    const url = encodePairingUrl("http://localhost:5173", p);
    expect(() => decodePairingUrl(url)).toThrow(ProtocolError);
    expect(decodePairingUrl(url, { allowInsecureLocalhost: true }).u).toBe("ws://127.0.0.1:8787");
  });
});

describe("relay URLs", () => {
  it("accepts wss and refuses ws except localhost when allowed", () => {
    expect(() => assertRelayUrl("wss://relay.walkietalkey.com")).not.toThrow();
    expect(() => assertRelayUrl("ws://relay.walkietalkey.com")).toThrow(ProtocolError);
    expect(() => assertRelayUrl("ws://localhost:8787")).toThrow(ProtocolError);
    expect(() => assertRelayUrl("ws://localhost:8787", { allowInsecureLocalhost: true })).not.toThrow();
    expect(() => assertRelayUrl("ws://[::1]:8787", { allowInsecureLocalhost: true })).not.toThrow();
    expect(() => assertRelayUrl("ws://evil.localhost.example", { allowInsecureLocalhost: true })).toThrow(ProtocolError);
    expect(() => assertRelayUrl("https://relay.walkietalkey.com")).toThrow(ProtocolError);
  });

  it("builds the room socket URL with the declared intent", () => {
    const roomId = randomBytes(16);
    expect(roomSocketUrl("wss://relay.example/", roomId, "join")).toBe(
      `wss://relay.example/v1/rooms/${b64uEncode(roomId)}/ws?intent=join`,
    );
  });
});
