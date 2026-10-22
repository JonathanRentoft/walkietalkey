import { describe, expect, it } from "vitest";
import {
  DEVICE_ID_LEN,
  ProtocolError,
  SPKI_LEN,
  SPKI_PREFIX,
  assertSpki,
  bytesEqual,
  deviceIdFromSpki,
  exportSpki,
  generateDeviceKeys,
  importAgreementPublicKey,
  importSigningPublicKey,
  sha256,
} from "../src/index.ts";

describe("device keys", () => {
  it("creates non-extractable private keys (SEC-09) and exports canonical SPKI", async () => {
    const keys = await generateDeviceKeys();
    expect(keys.signing.privateKey.extractable).toBe(false);
    expect(keys.agreement.privateKey.extractable).toBe(false);
    expect(keys.signing.privateKey.algorithm.name).toBe("ECDSA");
    expect(keys.agreement.privateKey.algorithm.name).toBe("ECDH");
    expect(keys.signingSpki.length).toBe(SPKI_LEN);
    expect(keys.agreementSpki.length).toBe(SPKI_LEN);
    expect(bytesEqual(keys.signingSpki.subarray(0, SPKI_PREFIX.length), SPKI_PREFIX)).toBe(true);
    expect(bytesEqual(await exportSpki(keys.signing.publicKey), keys.signingSpki)).toBe(true);
  });

  it("derives the device id as the first 16 bytes of SHA-256(signing SPKI)", async () => {
    const keys = await generateDeviceKeys();
    const digest = await sha256(keys.signingSpki);
    expect(keys.deviceId.length).toBe(DEVICE_ID_LEN);
    expect(bytesEqual(keys.deviceId, digest.subarray(0, 16))).toBe(true);
    expect(bytesEqual(await deviceIdFromSpki(keys.signingSpki), keys.deviceId)).toBe(true);
  });

  it("imports public keys from SPKI and rejects malformed ones", async () => {
    const keys = await generateDeviceKeys();
    const sig = await importSigningPublicKey(keys.signingSpki);
    expect(sig.algorithm.name).toBe("ECDSA");
    const agree = await importAgreementPublicKey(keys.agreementSpki);
    expect(agree.algorithm.name).toBe("ECDH");

    const short = keys.signingSpki.subarray(0, 90);
    expect(() => assertSpki(short)).toThrow(ProtocolError);
    const wrongPrefix = keys.signingSpki.slice();
    wrongPrefix[3]! ^= 1;
    expect(() => assertSpki(wrongPrefix)).toThrow(ProtocolError);
    const offCurve = keys.signingSpki.slice();
    offCurve[90]! ^= 1;
    await expect(importSigningPublicKey(offCurve)).rejects.toThrow(ProtocolError);
    await expect(importAgreementPublicKey(offCurve)).rejects.toThrow(ProtocolError);
  });
});
