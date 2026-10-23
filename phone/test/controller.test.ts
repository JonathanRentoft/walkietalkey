import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import {
  b64uEncode,
  derivePairKeys,
  generateDeviceKeys,
  randomBytes,
} from "@walkietalkey/protocol";
import type { RecorderLike } from "../src/audio/recorder";
import { PhoneController } from "../src/core/controller";
import type { WebSocketCtor } from "../src/core/link";
import { PhoneStorage } from "../src/lib/storage";

/** A socket that never connects: the controller works offline, sessions wait in memory. */
class NeverSocket {
  readyState = 0;
  binaryType = "arraybuffer";
  onmessage: unknown = null;
  onclose: unknown = null;
  constructor(_url: string) {}
  send(): void {}
  close(): void {}
}

class FakeRecorder implements RecorderLike {
  calls: string[] = [];
  onBlock: ((b: Uint8Array, level: number) => void) | null = null;
  prime(): void {
    this.calls.push("prime");
  }
  async start(onBlock: (b: Uint8Array, level: number) => void): Promise<void> {
    this.calls.push("start");
    this.onBlock = onBlock;
    // -36 dBFS: half way up the meter.
    onBlock(new Uint8Array(6400), 10 ** (-36 / 20));
  }
  async stop(): Promise<void> {
    this.calls.push("stop");
    this.onBlock?.(new Uint8Array(1000), 0);
  }
  abort(): void {
    this.calls.push("abort");
  }
}

let n = 0;
const made: { c: PhoneController; s: PhoneStorage }[] = [];

async function setup(opts: { paired: boolean; haptics?: boolean }) {
  const storage = await PhoneStorage.open(`wt-controller-${++n}`);
  if (opts.paired) {
    const device = await storage.loadOrCreateDeviceKeys();
    const computer = await generateDeviceKeys();
    const roomId = randomBytes(16);
    const keys = await derivePairKeys({
      agreementPrivateKey: device.agreement.privateKey,
      peerAgreementSpki: computer.agreementSpki,
      secret: randomBytes(32),
      roomId,
      computerId: computer.deviceId,
      phoneId: device.deviceId,
    });
    await storage.putRoom({
      roomId: b64uEncode(roomId),
      relayUrl: "wss://relay.example.com",
      computerName: "MacBook",
      os: "mac",
      computerId: b64uEncode(computer.deviceId),
      keys,
      deviceName: "iPhone",
      pairedAt: 1,
      lastUsedAt: 1,
    });
  }
  if (opts.haptics === false)
    await storage.putSettings({ mode: "hold", haptics: false });
  const recorder = new FakeRecorder();
  const haptics: string[] = [];
  const wake: string[] = [];
  const c = new PhoneController({
    storage,
    platform: { os: "ios", standalone: true, shell: true, device: "iPhone" },
    recorder,
    haptic: (k) => haptics.push(k),
    wake: {
      acquire: () => wake.push("on"),
      release: () => wake.push("off"),
      visible: () => undefined,
    },
    WebSocketImpl: NeverSocket as unknown as WebSocketCtor,
  });
  await c.init();
  made.push({ c, s: storage });
  return { c, recorder, haptics, wake };
}

const tick = () => new Promise((r) => setTimeout(r, 10));

afterEach(async () => {
  await tick();
  for (const m of made.splice(0)) {
    m.c.dispose();
    m.s.close();
  }
});

describe("Start diktering from the iOS shell (controller)", () => {
  it("is ignored when not paired", async () => {
    const { c, recorder, haptics } = await setup({ paired: false });
    expect(c.shellStart()).toBe(false);
    expect(c.getSnapshot().machine.phase).toBe("idle");
    await tick();
    expect(recorder.calls).not.toContain("start");
    expect(haptics).toEqual([]);
  });

  it("starts a tap-style recording with the start haptic; a tap on the button sends it", async () => {
    const { c, recorder, haptics, wake } = await setup({ paired: true });
    expect(c.shellStart()).toBe(true);
    const m = c.getSnapshot().machine;
    expect(m.phase).toBe("rec");
    expect(m.latched).toBe(true);
    await tick();
    expect(recorder.calls).toEqual(["prime", "start"]);
    expect(haptics).toEqual(["start"]);
    expect(wake).toEqual(["on"]);
    // A second Start diktering while recording changes nothing.
    expect(c.shellStart()).toBe(false);

    c.down();
    expect(c.getSnapshot().machine.phase).toBe("rec");
    c.up();
    await tick();
    // Not connected: the recording waits in memory ("Ingen forbindelse" on screen).
    expect(c.getSnapshot().machine.phase).toBe("send");
    expect(recorder.calls).toContain("stop");
    expect(haptics).toEqual(["start", "stop"]);
    expect(wake).toEqual(["on", "off"]);
  });

  it("the cancel control cancels it", async () => {
    const { c, recorder } = await setup({ paired: true });
    c.shellStart();
    await tick();
    c.cancel();
    expect(c.getSnapshot().machine.phase).toBe("idle");
    expect(recorder.calls).toContain("abort");
  });

  it("respects the haptics setting", async () => {
    const { c, haptics } = await setup({ paired: true, haptics: false });
    c.shellStart();
    expect(haptics).toEqual([]);
  });
});

describe("the level meter follows the microphone (PHONE-21)", () => {
  it("keeps the level of the latest 200 ms block while recording, 0 otherwise", async () => {
    const { c, recorder } = await setup({ paired: true });
    expect(c.getSnapshot().level).toBe(0);
    c.down();
    await tick();
    expect(c.getSnapshot().level).toBeCloseTo(0.5, 6);
    // The microphone goes silent (a muted headset): the meter drops flat.
    recorder.onBlock!(new Uint8Array(6400), 0);
    expect(c.getSnapshot().level).toBe(0);
    recorder.onBlock!(new Uint8Array(6400), 10 ** (-12 / 20));
    expect(c.getSnapshot().level).toBeCloseTo(1, 6);
    c.up();
    await tick();
    expect(c.getSnapshot().machine.phase).not.toBe("rec");
    expect(c.getSnapshot().level).toBe(0);
  });
});
