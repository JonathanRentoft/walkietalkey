/**
 * Run 5, spec 5.4: a pairing whose computer will never come back shows "Par igen", never a hang.
 * The controller's side, on the fake relay: a computer away for days is marked stale and still
 * gets what it is sent (PHONE-24); an old pairing code is refused without touching the working
 * pair keys (join without the member fallback).
 */
import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import {
  BLOCK_BYTES,
  CloseCode,
  b64uEncode,
  generateDeviceKeys,
  parseControlMessage,
  randomBytes,
  serializeControlMessage,
  type PairingPayload,
} from "@walkietalkey/protocol";
import type { RecorderLike } from "../src/audio/recorder";
import { PhoneController } from "../src/core/controller";
import { JoinError, joinRoom, type WebSocketCtor } from "../src/core/link";
import { dayNumber } from "../src/core/stale";
import { PhoneStorage } from "../src/lib/storage";
import { FakeComputer, FakeRelay } from "./fake-relay";

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

const NOW = Date.UTC(2026, 9, 25, 12, 0);
const TODAY = dayNumber(NOW);

async function paired(opts: { online: boolean; lastSeenDay: number }) {
  const storage = await PhoneStorage.open(`wt-stale-${++n}`);
  const relay = new FakeRelay();
  const mac = await FakeComputer.pairedWith(storage, "MacBook", 1);
  mac.online = opts.online;
  mac.lastSeenDay = opts.lastSeenDay;
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
    now: () => NOW,
  });
  await c.init();
  made.push({ c, s: storage });
  await until(() => c.getSnapshot().rooms[0]?.connected === true, "connected");
  return { c, mac, storage };
}

describe("a computer away for days (run 5)", () => {
  it("is stale after two days and offers Par igen, yet still gets its dictation when it is back", async () => {
    const { c, mac } = await paired({ online: false, lastSeenDay: TODAY - 3 });
    const room = c.getSnapshot().rooms[0]!;
    expect(room.stale).toBe(true);
    expect(room.daysAway).toBe(3);
    // PHONE-24: it may only be off; a dictation waits for it.
    c.down();
    c.up();
    await sleep(30);
    c.down();
    c.up();
    await until(() => c.getSnapshot().machine.phase === "offline", "waiting");
    mac.reconnect();
    await until(() => c.getSnapshot().machine.phase === "ready", "Klar på");
    const back = c.getSnapshot().rooms[0]!;
    expect(back.stale).toBe(false);
    expect(back.lastSeenDay).toBe(TODAY);
  });

  it("is not stale when it was seen yesterday (asleep)", async () => {
    const { c } = await paired({ online: false, lastSeenDay: TODAY - 1 });
    expect(c.getSnapshot().rooms[0]!.stale).toBe(false);
  });
});

/** A relay that refuses every join's admission (4401, `admission_invalid`) and counts auths. */
function refusingRelay() {
  const seen = { joins: 0, auths: 0 };
  class Refusing {
    readyState = 0;
    binaryType = "arraybuffer";
    onmessage: ((ev: { data: string }) => void) | null = null;
    onclose: ((ev: { code: number }) => void) | null = null;
    constructor(readonly url: string) {
      setTimeout(() => {
        this.readyState = 1;
        this.onmessage?.({
          data: serializeControlMessage({
            t: "challenge",
            n: b64uEncode(randomBytes(32)),
          }),
        });
      }, 5);
    }
    send(data: string): void {
      const msg = parseControlMessage(data);
      if (msg.t === "join") seen.joins++;
      if (msg.t === "auth") seen.auths++;
      this.onmessage?.({
        data: serializeControlMessage({
          t: "error",
          code: "admission_invalid",
          msg: "",
        }),
      });
      this.close(CloseCode.NotAuthorised);
    }
    close(code = 1000): void {
      if (this.readyState === 3) return;
      this.readyState = 3;
      setTimeout(() => this.onclose?.({ code }), 0);
    }
  }
  return { WS: Refusing as unknown as WebSocketCtor, seen };
}

async function payload(): Promise<PairingPayload> {
  const computer = await generateDeviceKeys();
  return {
    v: 1,
    r: randomBytes(16),
    a: randomBytes(32),
    s: randomBytes(32),
    e: computer.agreementSpki,
    u: "wss://relay.example.com",
    n: "MacBook",
    o: "mac",
  };
}

describe("an old pairing code (run 5)", () => {
  it("is refused as expired without trying to authenticate, when the fallback is off", async () => {
    const { WS, seen } = refusingRelay();
    const device = await generateDeviceKeys();
    await expect(
      joinRoom(WS, await payload(), device, 2000, false),
    ).rejects.toMatchObject({ kind: "expired" } satisfies Partial<JoinError>);
    expect(seen).toEqual({ joins: 1, auths: 0 });
  });

  it("still falls back to authenticating when the join's ok may have been lost", async () => {
    const { WS, seen } = refusingRelay();
    const device = await generateDeviceKeys();
    await expect(
      joinRoom(WS, await payload(), device, 2000, true),
    ).rejects.toBeInstanceOf(JoinError);
    expect(seen).toEqual({ joins: 1, auths: 1 });
  });

  it("of a room the phone is in leaves the working pairing as it was", async () => {
    const { c, mac, storage } = await paired({
      online: true,
      lastSeenDay: TODAY,
    });
    const before = await storage.listRooms();
    // A code of this same room, from an earlier pairing (a screenshot, an old link).
    const old: PairingPayload = {
      ...(await payload()),
      r: mac.roomId,
      e: mac.keys.agreementSpki,
    };
    // The fake relay answers every join like the real one answers a used admission.
    expect(await c.pair(old, "iPhone")).toBe(false);
    expect(c.getSnapshot().pairing).toMatchObject({
      state: "error",
      kind: "expired",
    });
    const after = await storage.listRooms();
    expect(after).toHaveLength(1);
    expect(after[0]!.pairedAt).toBe(before[0]!.pairedAt);
    // And a dictation still arrives with the pair keys it had.
    c.down();
    c.up();
    await sleep(30);
    c.down();
    c.up();
    await until(() => c.getSnapshot().machine.phase === "ready", "Klar på");
  });
});
