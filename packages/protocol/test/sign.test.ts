import { describe, expect, it } from "vitest";
import {
  LABELS,
  ProtocolError,
  bytesEqual,
  challengeMessage,
  concatBytes,
  generateDeviceKeys,
  randomBytes,
  signChallenge,
  utf8Encode,
  verifyChallenge,
} from "../src/index.ts";

describe("challenge signatures", () => {
  it("builds label ‖ roomId ‖ challenge", () => {
    const roomId = randomBytes(16);
    const challenge = randomBytes(32);
    const msg = challengeMessage("wt-auth-v1", roomId, challenge);
    expect(bytesEqual(msg, concatBytes(utf8Encode(LABELS.auth), roomId, challenge))).toBe(true);
    expect(() => challengeMessage("wt-auth-v1", randomBytes(15), challenge)).toThrow(ProtocolError);
    expect(() => challengeMessage("wt-auth-v1", roomId, randomBytes(31))).toThrow(ProtocolError);
    // @ts-expect-error not a challenge label
    expect(() => challengeMessage("wt-pair-v1", roomId, challenge)).toThrow(ProtocolError);
  });

  it("signs with 64-byte raw r‖s and verifies", async () => {
    const keys = await generateDeviceKeys();
    const roomId = randomBytes(16);
    const challenge = randomBytes(32);
    const sig = await signChallenge(keys.signing.privateKey, "wt-auth-v1", roomId, challenge);
    expect(sig.length).toBe(64);
    expect(await verifyChallenge(keys.signingSpki, "wt-auth-v1", roomId, challenge, sig)).toBe(true);
  });

  it("separates purposes by label and binds room and challenge", async () => {
    const keys = await generateDeviceKeys();
    const roomId = randomBytes(16);
    const challenge = randomBytes(32);
    const sig = await signChallenge(keys.signing.privateKey, "wt-create-v1", roomId, challenge);
    expect(await verifyChallenge(keys.signingSpki, "wt-create-v1", roomId, challenge, sig)).toBe(true);
    expect(await verifyChallenge(keys.signingSpki, "wt-auth-v1", roomId, challenge, sig)).toBe(false);
    expect(await verifyChallenge(keys.signingSpki, "wt-join-v1", roomId, challenge, sig)).toBe(false);
    expect(await verifyChallenge(keys.signingSpki, "wt-create-v1", randomBytes(16), challenge, sig)).toBe(false);
    expect(await verifyChallenge(keys.signingSpki, "wt-create-v1", roomId, randomBytes(32), sig)).toBe(false);
    const other = await generateDeviceKeys();
    expect(await verifyChallenge(other.signingSpki, "wt-create-v1", roomId, challenge, sig)).toBe(false);
  });

  it("returns false (not throw) for malformed signatures", async () => {
    const keys = await generateDeviceKeys();
    const roomId = randomBytes(16);
    const challenge = randomBytes(32);
    expect(await verifyChallenge(keys.signingSpki, "wt-auth-v1", roomId, challenge, randomBytes(63))).toBe(false);
    expect(await verifyChallenge(keys.signingSpki, "wt-auth-v1", roomId, challenge, new Uint8Array(64))).toBe(false);
  });
});
