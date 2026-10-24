/* When the microphone is open (PHONE-30, PHONE-33): warm while the app is visible and paired, so a
   dictation keeps its first syllable; closed when the page is hidden and after a few idle
   minutes; never left open by a recording that the background interrupted. */
import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import {
  b64uEncode,
  derivePairKeys,
  generateDeviceKeys,
  randomBytes,
} from "@walkietalkey/protocol";
import { MicDeniedError, type RecorderLike } from "../src/audio/recorder";
import { MIC_IDLE_MS, PhoneController } from "../src/core/controller";
import type { WebSocketCtor } from "../src/core/link";
import { PhoneStorage } from "../src/lib/storage";

class NeverSocket {
  readyState = 0;
  binaryType = "arraybuffer";
  onmessage: unknown = null;
  onclose: unknown = null;
  constructor(_url: string) {}
  send(): void {}
  close(): void {}
}

class MicLog implements RecorderLike {
  calls: string[] = [];
  warmError: Error | null = null;
  prime(): void {}
  async warm(): Promise<void> {
    this.calls.push("warm");
    if (this.warmError) throw this.warmError;
  }
  cool(): void {
    this.calls.push("cool");
  }
  async start(onBlock: (b: Uint8Array, level: number) => void): Promise<void> {
    this.calls.push("start");
    onBlock(new Uint8Array(6400), 0.1);
  }
  async stop(): Promise<void> {
    this.calls.push("stop");
  }
  abort(): void {
    this.calls.push("abort");
  }
  /** Calls since the last look. */
  take(): string[] {
    return this.calls.splice(0);
  }
}

let n = 0;
const made: { c: PhoneController; s: PhoneStorage }[] = [];

async function setup(opts: {
  paired: boolean;
  idleMs?: number;
  visible?: boolean;
}) {
  const storage = await PhoneStorage.open(`wt-mic-${++n}`);
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
  const mic = new MicLog();
  const clock = { t: 1_000_000 };
  const c = new PhoneController({
    storage,
    platform: { os: "ios", standalone: true, shell: false, device: "iPhone" },
    recorder: mic,
    haptic: () => undefined,
    wake: { acquire() {}, release() {}, visible() {} },
    WebSocketImpl: NeverSocket as unknown as WebSocketCtor,
    micIdleMs: opts.idleMs,
    visible: () => opts.visible ?? true,
    now: () => clock.t,
  });
  await c.init();
  made.push({ c, s: storage });
  return { c, mic, clock };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

afterEach(async () => {
  await sleep(10);
  for (const m of made.splice(0)) {
    m.c.dispose();
    m.s.close();
  }
});

describe("the warm microphone", () => {
  it("closes after a few idle minutes", () => {
    expect(MIC_IDLE_MS).toBe(3 * 60 * 1000);
  });

  it("opens when the app starts visible and paired", async () => {
    const { mic } = await setup({ paired: true });
    expect(mic.take()).toEqual(["warm"]);
  });

  it("stays closed when not paired, or when the app starts hidden", async () => {
    expect((await setup({ paired: false })).mic.take()).toEqual([]);
    expect((await setup({ paired: true, visible: false })).mic.take()).toEqual(
      [],
    );
  });

  it("closes when the page is hidden and opens again when it comes back", async () => {
    const { c, mic } = await setup({ paired: true });
    mic.take();
    c.hidden();
    await sleep(1);
    expect(mic.take()).toEqual(["cool"]);
    c.hidden();
    await sleep(1);
    expect(mic.take()).toEqual([]);
    c.foreground();
    expect(mic.take()).toEqual(["warm"]);
  });

  it("back before the close went through: the microphone stays open", async () => {
    const { c, mic } = await setup({ paired: true });
    mic.take();
    c.hidden();
    c.foreground();
    await sleep(1);
    expect(mic.take()).toEqual(["warm"]);
  });

  it("a recording interrupted by the background is sent, then the microphone closes", async () => {
    const { c, mic } = await setup({ paired: true });
    c.down();
    await sleep(5);
    c.up(); // a tap: hands-free
    expect(c.getSnapshot().machine.handsFree).toBe(true);
    mic.take();
    c.hidden();
    await sleep(5);
    expect(c.getSnapshot().machine.phase).toBe("send");
    // The last block is delivered before the microphone closes.
    expect(mic.take()).toEqual(["stop", "cool"]);
  });

  it("closes after the idle time without a touch; a touch opens it again", async () => {
    const { c, mic } = await setup({ paired: true, idleMs: 40 });
    mic.take();
    await sleep(25);
    c.activity();
    await sleep(25);
    // The touch restarted the idle time.
    expect(mic.take()).toEqual([]);
    await sleep(40);
    expect(mic.take()).toEqual(["cool"]);
    c.activity();
    expect(mic.take()).toEqual(["warm"]);
  });

  it("never closes for idleness during a recording; the idle time restarts after it", async () => {
    const { c, mic, clock } = await setup({ paired: true, idleMs: 30 });
    c.down();
    await sleep(80);
    expect(mic.calls).not.toContain("cool");
    clock.t += 2000;
    c.up();
    await sleep(10);
    expect(mic.calls).not.toContain("cool");
    await sleep(50);
    expect(mic.calls).toContain("cool");
  });

  it("a refused microphone is not asked again on every touch, only when the app comes back", async () => {
    const { c, mic } = await setup({ paired: true, idleMs: 20 });
    mic.warmError = new MicDeniedError();
    c.hidden();
    c.foreground();
    await sleep(5);
    mic.take();
    c.activity();
    await sleep(40);
    c.activity();
    expect(mic.take().filter((x) => x === "warm")).toEqual([]);
    mic.warmError = null;
    c.hidden();
    c.foreground();
    expect(mic.take()).toContain("warm");
  });
});
