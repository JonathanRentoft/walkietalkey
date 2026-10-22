import { generateDeviceKeys, randomBytes, type DeviceKeys } from "../src/index.ts";

export async function aesKey(raw: Uint8Array = randomBytes(32)): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", raw as BufferSource, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export interface TwoDevices {
  computer: DeviceKeys;
  phone: DeviceKeys;
}

export async function twoDevices(): Promise<TwoDevices> {
  return { computer: await generateDeviceKeys(), phone: await generateDeviceKeys() };
}
