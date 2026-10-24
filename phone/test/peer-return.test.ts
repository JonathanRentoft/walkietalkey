import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import { BLOCK_BYTES } from "@walkietalkey/protocol";
import type { RecorderLike } from "../src/audio/recorder";
import { PhoneController } from "../src/core/controller";
import { PhoneStorage } from "../src/lib/storage";
import { FakeComputer, FakeRelay } from "./fake-relay";

/** Delivers three 200 ms blocks at start and a short last block at stop. */
class ThreeBlocks implements RecorderLike {
  private onBlock: ((b: Uint8Array, level: number) => void) | null = null;
  prime(): void {}
  async warm(): Promise<void> {}
  cool(): void {}
  async start(onBlock: (b: Uint8Array, level: number) => void): Promise<void> {
    this.onBlock = onBlock;
    for (let i = 0; i < 3; i++)
      onBlock(new Uint8Array(BLOCK_BYTES).fill(i), 0.1);
  }
  async stop(): Promise<void> {
    this.onBlock?.(new Uint8Array(1000), 0);
    this.onBlock = null;
  }
  abort(): void {
    this.onBlock = null;
  }
}

let n = 0;
const made: { c: PhoneController; s: PhoneStorage }[] = [];

afterEach(async () => {
  for (const m of made.splice(0)) {
    m.c.dispose();
    m.s.close();
  }
  await sleep(20);
});

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function until(cond: () => boolean, what: string, timeoutMs = 5000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out: ${what}`);
    await sleep(10);
  }
}

async function paired() {
  const storage = await PhoneStorage.open(`wt-peer-return-${++n}`);
  const relay = new FakeRelay();
  const mac = await FakeComputer.pairedWith(storage, "MacBook", 1);
  relay.add(mac);
  const c = new PhoneController({
    storage,
    platform: { os: "ios", standalone: true, shell: false, device: "iPhone" },
    recorder: new ThreeBlocks(),
    haptic: () => undefined,
    wake: {
      acquire: () => undefined,
      release: () => undefined,
      visible: () => undefined,
    },
    WebSocketImpl: relay.WebSocket,
    backoffMs: [60_000],
  });
  await c.init();
  made.push({ c, s: storage });
  await until(() => c.getSnapshot().rooms[0]?.online === true, "online");
  return { c, mac };
}

/** Tap to start (hands-free), tap again to stop and send (PHONE-26). */
async function dictate(c: PhoneController): Promise<void> {
  c.down();
  c.up();
  await sleep(30);
  c.down();
  c.up();
  await until(() => c.getSnapshot().machine.phase === "send", "sending");
}

describe("the computer comes back after its socket went quiet (PHONE-32, RELAY-10)", () => {
  it("resends the open dictation on peer online, and the result arrives", async () => {
    const { c, mac } = await paired();
    // The lid closes: the relay still counts the computer's socket as live, the frames are lost.
    mac.deaf = true;
    await dictate(c);
    await sleep(100);
    expect(mac.sessions.size).toBe(0);
    mac.reconnect();
    await until(() => c.getSnapshot().machine.phase === "ready", "Klar på");
    const [s] = [...mac.sessions.values()];
    expect(s!.starts).toBe(1);
    expect(s!.end).toBe(4);
    expect([...s!.blocks].sort()).toEqual([0, 1, 2, 3]);
  });

  it("the peer status that comes with the phone's own authentication sends nothing twice", async () => {
    const { c, mac } = await paired();
    mac.answer = false;
    await dictate(c);
    await sleep(100);
    const [s] = [...mac.sessions.values()];
    expect(s!.starts).toBe(1);
    expect(s!.end).toBe(4);
    // The phone's socket drops and comes back: one resend, not one per event.
    for (const sock of mac.openSockets) sock.drop();
    c.network(true);
    await until(() => s!.starts === 2, "the resend");
    await sleep(200);
    expect(s!.starts).toBe(2);
  });
});
