import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  encodePairingUrl,
  generateDeviceKeys,
  randomBytes,
  type PairingPayload,
} from "@walkietalkey/protocol";
import {
  cleanAppUrl,
  pairingLinkId,
  parseScanned,
  peekPairingFragment,
  suggestPhoneName,
  takePairingFragment,
} from "../src/lib/pairingLink";

describe("the phone's name, prefilled (PHONE-12, Phase 5)", () => {
  it("takes the owner from the computer's name", () => {
    expect(suggestPhoneName("Jonathans MacBook Pro", "iPhone")).toBe(
      "Jonathans iPhone",
    );
    expect(suggestPhoneName("Mettes iMac", "iPhone")).toBe("Mettes iPhone");
    expect(suggestPhoneName("Jonathan’s MacBook Air", "iPhone")).toBe(
      "Jonathan’s iPhone",
    );
    expect(suggestPhoneName("Ida's Mac mini", "Android")).toBe("Ida's Android");
    expect(suggestPhoneName("Anne-Maries MacBook", "iPhone")).toBe(
      "Anne-Maries iPhone",
    );
  });

  it("falls back to the kind of phone", () => {
    for (const n of [
      "MacBook Pro",
      "Kontor-PC",
      "DESKTOP-4F2K9QX",
      "",
      "s Mac",
    ])
      expect(suggestPhoneName(n, "iPhone")).toBe("iPhone");
  });
});

let payload: PairingPayload;

beforeAll(async () => {
  const computer = await generateDeviceKeys();
  payload = {
    v: 1,
    r: randomBytes(16),
    a: randomBytes(32),
    s: randomBytes(32),
    e: computer.agreementSpki,
    u: "wss://relay.example.com",
    n: "Jonathans MacBook",
    o: "mac",
  };
});

function history() {
  return { replaceState: vi.fn() };
}

describe("pairing link (PHONE-11, PHONE-15)", () => {
  it("reads the fragment and removes it from the address bar and history at once", () => {
    const url = encodePairingUrl("https://app.walkietalkey.com", payload);
    const h = history();
    const r = takePairingFragment({ href: url }, h);
    expect(r.kind).toBe("pairing");
    if (r.kind !== "pairing") return;
    expect(r.payload.n).toBe("Jonathans MacBook");
    expect(r.payload.o).toBe("mac");
    expect(r.payload.r).toEqual(payload.r);
    expect(h.replaceState).toHaveBeenCalledTimes(1);
    expect(h.replaceState).toHaveBeenCalledWith(
      null,
      "",
      "https://app.walkietalkey.com/",
    );
  });

  it("removes even an invalid fragment and reports it", () => {
    const h = history();
    const r = takePairingFragment(
      { href: "https://app.walkietalkey.com/p#bm90LWpzb24" },
      h,
    );
    expect(r.kind).toBe("invalid");
    expect(h.replaceState).toHaveBeenCalledWith(
      null,
      "",
      "https://app.walkietalkey.com/",
    );
  });

  it("does nothing without a fragment", () => {
    const h = history();
    expect(
      takePairingFragment({ href: "https://app.walkietalkey.com/" }, h).kind,
    ).toBe("none");
    expect(
      takePairingFragment({ href: "https://app.walkietalkey.com/#" }, h).kind,
    ).toBe("none");
    expect(h.replaceState).toHaveBeenCalledTimes(1);
  });

  it("keeps a company's own app path (PhoneAppUrl) and the iOS shell's file URL", () => {
    expect(cleanAppUrl("https://intra.example.dk/walkie/p#abc")).toBe(
      "https://intra.example.dk/walkie/",
    );
    expect(cleanAppUrl("https://intra.example.dk/walkie/p.html?x=1#abc")).toBe(
      "https://intra.example.dk/walkie/",
    );
    expect(cleanAppUrl("walkietalkey://app/index.html#abc")).toBe(
      "walkietalkey://app/index.html",
    );
    expect(cleanAppUrl("http://127.0.0.1:4173/#abc")).toBe(
      "http://127.0.0.1:4173/",
    );
  });

  it("returns to the app root from the folder form of the pairing path (nginx and IIS redirect /p to /p/)", () => {
    expect(cleanAppUrl("https://intra.example.dk/walkie/p/#abc")).toBe(
      "https://intra.example.dk/walkie/",
    );
    expect(cleanAppUrl("https://app.example.dk/p/index.html#abc")).toBe(
      "https://app.example.dk/",
    );
    expect(cleanAppUrl("https://app.example.dk/pp/#abc")).toBe(
      "https://app.example.dk/pp/",
    );
  });

  it("accepts the link from the app's own scanner, any origin", () => {
    const url = encodePairingUrl("https://intra.example.dk/walkie/", payload);
    expect(parseScanned(url).n).toBe("Jonathans MacBook");
    expect(() =>
      parseScanned("https://example.com/not-a-pairing-code"),
    ).toThrow();
  });

  it("the Safari tab on an iPhone reads the link but leaves it in the address bar (Phase 5)", () => {
    const url = encodePairingUrl("https://app.walkietalkey.com", payload);
    const r = peekPairingFragment({ href: url });
    expect(r.kind).toBe("pairing");
    if (r.kind === "pairing") expect(r.payload.n).toBe("Jonathans MacBook");
    expect(peekPairingFragment({ href: "https://x.dk/" }).kind).toBe("none");
    expect(peekPairingFragment({ href: "https://x.dk/p#bm90" }).kind).toBe(
      "invalid",
    );
  });

  it("knows a link again by the hash of its single-use secret, never the secret itself", async () => {
    const id = await pairingLinkId(payload);
    expect(id).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await pairingLinkId(payload)).toBe(id);
    expect(await pairingLinkId({ ...payload, a: randomBytes(32) })).not.toBe(
      id,
    );
    const b64 = (u: Uint8Array) => Buffer.from(u).toString("base64url");
    expect(id).not.toContain(b64(payload.a).slice(0, 12));
  });

  it("refuses ws:// relays unless debugging against localhost (SEC-06)", () => {
    const local = encodePairingUrl("http://127.0.0.1:4173", {
      ...payload,
      u: "ws://127.0.0.1:8787",
    });
    expect(() => parseScanned(local)).toThrow();
    expect(parseScanned(local, { allowInsecureLocalhost: true }).u).toBe(
      "ws://127.0.0.1:8787",
    );
    const h = history();
    expect(takePairingFragment({ href: local }, h).kind).toBe("invalid");
    expect(
      takePairingFragment({ href: local }, h, { allowInsecureLocalhost: true })
        .kind,
    ).toBe("pairing");
  });
});
