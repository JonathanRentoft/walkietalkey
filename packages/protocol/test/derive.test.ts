import { describe, expect, it } from "vitest";
import {
  LABELS,
  ProtocolError,
  bytesEqual,
  computeJoinMac,
  computeRoomId,
  concatBytes,
  derivePairKeys,
  generateDeviceKeys,
  randomBytes,
  sha256,
  utf8Encode,
  verifyJoinMac,
} from "../src/index.ts";
import { deriveRawPairSecrets } from "../src/testing.ts";

describe("room id", () => {
  it("is the first 16 bytes of SHA-256(label ‖ SPKI ‖ salt)", async () => {
    const keys = await generateDeviceKeys();
    const salt = randomBytes(16);
    const roomId = await computeRoomId(keys.signingSpki, salt);
    const digest = await sha256(concatBytes(utf8Encode(LABELS.room), keys.signingSpki, salt));
    expect(roomId.length).toBe(16);
    expect(bytesEqual(roomId, digest.subarray(0, 16))).toBe(true);
    const other = await computeRoomId(keys.signingSpki, randomBytes(16));
    expect(bytesEqual(roomId, other)).toBe(false);
  });

  it("requires a 16-byte salt", async () => {
    const keys = await generateDeviceKeys();
    await expect(computeRoomId(keys.signingSpki, randomBytes(15))).rejects.toThrow(ProtocolError);
  });
});

describe("pair keys", () => {
  it("are identical on both sides and differ per direction", async () => {
    const computer = await generateDeviceKeys();
    const phone = await generateDeviceKeys();
    const s = randomBytes(32);
    const roomId = await computeRoomId(computer.signingSpki, randomBytes(16));
    const common = { secret: s, roomId, computerId: computer.deviceId, phoneId: phone.deviceId };

    const onPhone = await deriveRawPairSecrets({
      ...common,
      agreementPrivateKey: phone.agreement.privateKey,
      peerAgreementSpki: computer.agreementSpki,
    });
    const onComputer = await deriveRawPairSecrets({
      ...common,
      agreementPrivateKey: computer.agreement.privateKey,
      peerAgreementSpki: phone.agreementSpki,
    });
    expect(bytesEqual(onPhone.shared, onComputer.shared)).toBe(true);
    expect(bytesEqual(onPhone.p2c, onComputer.p2c)).toBe(true);
    expect(bytesEqual(onPhone.c2p, onComputer.c2p)).toBe(true);
    expect(bytesEqual(onPhone.p2c, onPhone.c2p)).toBe(false);
    expect(onPhone.p2c.length).toBe(32);
  });

  it("produces non-extractable AES-GCM CryptoKeys by default", async () => {
    const computer = await generateDeviceKeys();
    const phone = await generateDeviceKeys();
    const keys = await derivePairKeys({
      secret: randomBytes(32),
      roomId: randomBytes(16),
      computerId: computer.deviceId,
      phoneId: phone.deviceId,
      agreementPrivateKey: phone.agreement.privateKey,
      peerAgreementSpki: computer.agreementSpki,
    });
    expect(keys.p2c.extractable).toBe(false);
    expect(keys.c2p.extractable).toBe(false);
    expect(keys.p2c.algorithm.name).toBe("AES-GCM");
  });
});

describe("join MAC", () => {
  it("verifies with the right secret and fails with anything changed", async () => {
    const phone = await generateDeviceKeys();
    const s = randomBytes(32);
    const roomId = randomBytes(16);
    const mac = await computeJoinMac(s, roomId, phone.signingSpki, phone.agreementSpki);
    expect(mac.length).toBe(32);
    expect(await verifyJoinMac(s, roomId, phone.signingSpki, phone.agreementSpki, mac)).toBe(true);

    expect(await verifyJoinMac(randomBytes(32), roomId, phone.signingSpki, phone.agreementSpki, mac)).toBe(false);
    expect(await verifyJoinMac(s, randomBytes(16), phone.signingSpki, phone.agreementSpki, mac)).toBe(false);
    const other = await generateDeviceKeys();
    // A relay that swaps the agreement key is caught.
    expect(await verifyJoinMac(s, roomId, phone.signingSpki, other.agreementSpki, mac)).toBe(false);
    expect(await verifyJoinMac(s, roomId, other.signingSpki, phone.agreementSpki, mac)).toBe(false);
    const flipped = mac.slice();
    flipped[0]! ^= 0x80;
    expect(await verifyJoinMac(s, roomId, phone.signingSpki, phone.agreementSpki, flipped)).toBe(false);
    expect(await verifyJoinMac(s, roomId, phone.signingSpki, phone.agreementSpki, mac.subarray(0, 31))).toBe(false);
  });
});
