import { describe, expect, it } from "vitest";
import vectors from "../test-vectors.json" with { type: "json" };
import {
  COUNTER_BLOCK,
  LABELS,
  MemoryCounterStore,
  SendCounter,
  b64uEncode,
  bytesEqual,
  challengeMessage,
  computeJoinMac,
  computeRoomId,
  concatBytes,
  decodePairingUrl,
  decodePayload,
  deviceIdFromSpki,
  encodePairingUrl,
  encodePayload,
  exportSpki,
  hexDecode,
  hexEncode,
  openFrame,
  parseControlMessage,
  serializeControlMessage,
  sha256,
  signChallenge,
  utf8Decode,
  utf8Encode,
  verifyChallenge,
  verifyJoinMac,
  type ChallengeLabel,
  type DevicePayload,
} from "../src/index.ts";
import {
  deriveRawPairSecrets,
  importAesKey,
  importAgreementPrivateKeyPkcs8,
  importSigningPrivateKeyPkcs8,
  sealFrameWithNonce,
} from "../src/testing.ts";

const hx = hexDecode;
const v = vectors;

/** The canonical description used by the Rust generator: camelCase, binary as hex. */
function describe_(p: DevicePayload): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(p))
    out[k] = val instanceof Uint8Array ? hexEncode(val) : val;
  return out;
}

async function device(d: (typeof v.devices)["computer"]) {
  const signing = await importSigningPrivateKeyPkcs8(hx(d.signingPkcs8), true);
  const agreement = await importAgreementPrivateKeyPkcs8(
    hx(d.agreementPkcs8),
    true,
  );
  return { signing, agreement };
}

describe("test vectors (SEC-05)", () => {
  it("device keys: PKCS#8 imports, SPKI and device ids", async () => {
    for (const d of [v.devices.computer, v.devices.phone]) {
      const { signing, agreement } = await device(d);
      // A JWK export of the imported private key gives back the scalar.
      const jwk = await crypto.subtle.exportKey("jwk", signing);
      expect(hexEncode(Uint8Array.from(Buffer.from(jwk.d!, "base64url")))).toBe(
        d.signingScalar,
      );
      const ajwk = await crypto.subtle.exportKey("jwk", agreement);
      expect(
        hexEncode(Uint8Array.from(Buffer.from(ajwk.d!, "base64url"))),
      ).toBe(d.agreementScalar);
      // Public halves from the JWK, exported as SPKI.
      const pub = await crypto.subtle.importKey(
        "jwk",
        { kty: "EC", crv: "P-256", x: jwk.x!, y: jwk.y! },
        { name: "ECDSA", namedCurve: "P-256" },
        true,
        ["verify"],
      );
      expect(hexEncode(await exportSpki(pub))).toBe(d.signingSpki);
      const apub = await crypto.subtle.importKey(
        "jwk",
        { kty: "EC", crv: "P-256", x: ajwk.x!, y: ajwk.y! },
        { name: "ECDH", namedCurve: "P-256" },
        true,
        [],
      );
      expect(hexEncode(await exportSpki(apub))).toBe(d.agreementSpki);
      expect(hexEncode(await deviceIdFromSpki(hx(d.signingSpki)))).toBe(
        d.deviceId,
      );
    }
  });

  it("room id", async () => {
    const spki = hx(v.devices.computer.signingSpki);
    const salt = hx(v.room.salt);
    expect(hexEncode(concatBytes(utf8Encode(LABELS.room), spki, salt))).toBe(
      v.room.preimage,
    );
    const roomId = await computeRoomId(spki, salt);
    expect(hexEncode(roomId)).toBe(v.room.roomId);
    expect(b64uEncode(roomId)).toBe(v.room.roomIdBase64url);
  });

  it("challenge signatures verify exactly as recorded", async () => {
    for (const s of v.signatures) {
      const label = s.label as ChallengeLabel;
      expect(
        hexEncode(challengeMessage(label, hx(s.roomId), hx(s.challenge))),
      ).toBe(s.message);
      const ok = await verifyChallenge(
        hx(s.signerSpki),
        label,
        hx(s.roomId),
        hx(s.challenge),
        hx(s.signature),
      );
      expect(ok, s.name).toBe(s.valid);
    }
  });

  it("WebCrypto signatures from the fixed keys verify too", async () => {
    const { signing } = await device(v.devices.phone);
    const sig = await signChallenge(
      signing,
      "wt-join-v1",
      hx(v.room.roomId),
      hx(v.signatures[0]!.challenge),
    );
    expect(sig.length).toBe(64);
    expect(
      await verifyChallenge(
        hx(v.devices.phone.signingSpki),
        "wt-join-v1",
        hx(v.room.roomId),
        hx(v.signatures[0]!.challenge),
        sig,
      ),
    ).toBe(true);
  });

  it("pair keys and join MAC on both sides", async () => {
    const computer = await device(v.devices.computer);
    const phone = await device(v.devices.phone);
    const p = v.pairing;
    expect(hexEncode(await sha256(hx(p.a)))).toBe(p.aSha256);
    const common = {
      secret: hx(p.s),
      roomId: hx(v.room.roomId),
      computerId: hx(v.devices.computer.deviceId),
      phoneId: hx(v.devices.phone.deviceId),
    };
    const sides = [
      await deriveRawPairSecrets({
        ...common,
        agreementPrivateKey: phone.agreement,
        peerAgreementSpki: hx(v.devices.computer.agreementSpki),
      }),
      await deriveRawPairSecrets({
        ...common,
        agreementPrivateKey: computer.agreement,
        peerAgreementSpki: hx(v.devices.phone.agreementSpki),
      }),
    ];
    for (const raw of sides) {
      expect(hexEncode(raw.shared)).toBe(p.shared);
      expect(hexEncode(raw.base)).toBe(p.base);
      expect(hexEncode(raw.p2c)).toBe(p.kP2c);
      expect(hexEncode(raw.c2p)).toBe(p.kC2p);
      expect(hexEncode(raw.macKey)).toBe(p.macKey);
    }
    expect(
      hexEncode(
        concatBytes(
          utf8Encode(LABELS.pair),
          common.roomId,
          common.computerId,
          common.phoneId,
        ),
      ),
    ).toBe(p.pairInfo);
    const phoneSpki = hx(v.devices.phone.signingSpki);
    const phoneAgree = hx(v.devices.phone.agreementSpki);
    expect(hexEncode(concatBytes(common.roomId, phoneSpki, phoneAgree))).toBe(
      p.macInput,
    );
    const mac = await computeJoinMac(
      common.secret,
      common.roomId,
      phoneSpki,
      phoneAgree,
    );
    expect(hexEncode(mac)).toBe(p.joinMac);
    expect(
      await verifyJoinMac(
        common.secret,
        common.roomId,
        phoneSpki,
        phoneAgree,
        mac,
      ),
    ).toBe(true);
  });

  it("pairing URL", async () => {
    const u = v.pairingUrl;
    const decoded = decodePairingUrl(u.url);
    expect(hexEncode(decoded.r)).toBe(v.room.roomId);
    expect(hexEncode(decoded.a)).toBe(v.pairing.a);
    expect(hexEncode(decoded.s)).toBe(v.pairing.s);
    expect(hexEncode(decoded.e)).toBe(v.devices.computer.agreementSpki);
    expect(decoded.u).toBe(u.relayUrl);
    expect(decoded.n).toBe(u.computerName);
    expect(decoded.o).toBe(u.os);
    const again = encodePairingUrl(u.phoneAppUrl, decoded);
    expect(again).toBe(u.url);
    expect(utf8Decode(Buffer.from(again.split("#")[1]!, "base64url"))).toBe(
      u.json,
    );
  });

  it("every frame seals byte-for-byte and opens", async () => {
    const keys = {
      p2c: await importAesKey(hx(v.pairing.kP2c)),
      c2p: await importAesKey(hx(v.pairing.kC2p)),
    };
    const ids = {
      computer: hx(v.devices.computer.deviceId),
      phone: hx(v.devices.phone.deviceId),
    };
    const types = new Set<number>();
    for (const f of v.frames) {
      const key = keys[f.key as "p2c" | "c2p"];
      const sender = ids[f.sender as "phone" | "computer"];
      const recipient = ids[f.recipient as "phone" | "computer"];
      types.add(f.frameType);
      const plaintext = hx(f.plaintext);
      const sealed = await sealFrameWithNonce(
        key,
        { type: f.frameType, sender, recipient, counter: BigInt(f.counter) },
        plaintext,
        hx(f.nonce),
      );
      expect(hexEncode(sealed), f.name).toBe(f.frame);
      const opened = await openFrame(key, hx(f.frame), { recipient, sender });
      expect(opened.header.counter).toBe(BigInt(f.counter));
      expect(bytesEqual(opened.plaintext, plaintext)).toBe(true);
      const decoded = decodePayload(f.frameType, opened.plaintext);
      expect(describe_(decoded), f.name).toEqual(f.decoded);
      expect(hexEncode(encodePayload(decoded).bytes)).toBe(f.plaintext);
    }
    expect([...types].sort((a, b) => a - b)).toEqual([
      0x10, 0x11, 0x12, 0x20, 0x21, 0x22, 0x23, 0x30,
    ]);
  });

  it("invalid frames fail with the recorded error", async () => {
    const keys = {
      p2c: await importAesKey(hx(v.pairing.kP2c)),
      c2p: await importAesKey(hx(v.pairing.kC2p)),
    };
    for (const f of v.invalidFrames) {
      await expect(
        openFrame(keys[f.key as "p2c" | "c2p"], hx(f.frame), {
          recipient: hx(v.devices.computer.deviceId),
          sender: hx(v.devices.phone.deviceId),
        }),
        f.name,
      ).rejects.toMatchObject({ code: f.error });
    }
  });

  it("control messages parse and serialize identically", () => {
    expect(v.controlMessages.length).toBeGreaterThanOrEqual(18);
    for (const c of v.controlMessages) {
      const parsed = parseControlMessage(c.json);
      expect(parsed.t).toBe(c.t);
      expect(serializeControlMessage(parsed)).toBe(c.json);
    }
  });

  it("counter reservation steps", async () => {
    expect(v.counters.blockSize).toBe(COUNTER_BLOCK);
    const store = new MemoryCounterStore();
    let c = await SendCounter.open(store, "k");
    for (const step of v.counters.steps as Array<Record<string, unknown>>) {
      switch (step.op) {
        case "open":
          expect(await store.loadSendReservation("k")).toBe(
            BigInt(step.storedBefore as string),
          );
          break;
        case "next":
          expect(await c.next()).toBe(BigInt(step.expect as string));
          expect(await store.loadSendReservation("k")).toBe(
            BigInt(step.storedAfter as string),
          );
          break;
        case "nextMany": {
          let last = 0n;
          for (let i = 0; i < (step.count as number); i++)
            last = await c.next();
          expect(last).toBe(BigInt(step.expectLast as string));
          expect(await store.loadSendReservation("k")).toBe(
            BigInt(step.storedAfter as string),
          );
          break;
        }
        case "restart":
          c = await SendCounter.open(store, "k");
          break;
        default:
          throw new Error(`unknown op ${String(step.op)}`);
      }
    }
  });
});
