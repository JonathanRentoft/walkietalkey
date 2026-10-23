import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import type { RecorderLike } from "../src/audio/recorder";
import { PhoneController } from "../src/core/controller";
import { PhoneStorage } from "../src/lib/storage";
import { FakeComputer, FakeRelay } from "./fake-relay";

class SilentRecorder implements RecorderLike {
  prime(): void {}
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  abort(): void {}
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

async function until(
  cond: () => boolean,
  what: string,
  timeoutMs = 5000,
): Promise<number> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out: ${what}`);
    await sleep(10);
  }
  return Date.now() - t0;
}

/** At home: the MacBook (used last) is where the user types; the ThinkPad at the office is locked. */
async function atHome() {
  const storage = await PhoneStorage.open(`wt-foreground-${++n}`);
  const relay = new FakeRelay();
  const home = await FakeComputer.pairedWith(storage, "MacBook", 200);
  const work = await FakeComputer.pairedWith(storage, "ThinkPad", 100);
  relay.add(home);
  relay.add(work);
  home.presence = { secondsSinceInput: 3, locked: false };
  work.presence = { secondsSinceInput: 5000, locked: true };
  const c = new PhoneController({
    storage,
    platform: { os: "ios", standalone: true, shell: false, device: "iPhone" },
    recorder: new SilentRecorder(),
    haptic: () => undefined,
    wake: {
      acquire: () => undefined,
      release: () => undefined,
      visible: () => undefined,
    },
    WebSocketImpl: relay.WebSocket,
    // The phone's own retries are far away: only the return to the foreground reconnects.
    backoffMs: [60_000],
  });
  await c.init();
  made.push({ c, s: storage });
  // The choice at start asks both computers; let it finish.
  await until(
    () => home.presenceQueries > 0 && work.presenceQueries > 0,
    "the first choice",
  );
  await sleep(100);
  expect(c.getSnapshot().rooms.every((r) => r.online)).toBe(true);
  expect(c.getSnapshot().target).toBe(home.roomB64);
  return { c, home, work };
}

/** At the office: now the ThinkPad is in use and the MacBook at home is locked. */
function atTheOffice(home: FakeComputer, work: FakeComputer): void {
  home.presence = { secondsSinceInput: 4000, locked: true };
  work.presence = { secondsSinceInput: 2, locked: false };
}

describe("the target after coming back to the foreground (PHONE-40)", () => {
  it("waits for links that closed in the background to authenticate again", async () => {
    const { c, home, work } = await atHome();
    for (const s of [...home.openSockets, ...work.openSockets]) s.drop();
    await until(
      () => c.getSnapshot().rooms.every((r) => !r.connected),
      "both links down",
    );
    atTheOffice(home, work);
    c.foreground();
    await until(
      () => c.getSnapshot().target === work.roomB64,
      "the ThinkPad as target",
    );
    expect(c.getSnapshot().rooms.every((r) => r.online)).toBe(true);
  });

  it("does not trust a socket that still looks open until it answers a ping", async () => {
    const { c, home, work } = await atHome();
    const dead = [...home.openSockets, ...work.openSockets];
    // iOS suspended the app: the sockets died, but the page still thinks they are open.
    for (const s of dead) s.freeze();
    atTheOffice(home, work);
    c.foreground();
    await until(
      () => c.getSnapshot().target === work.roomB64,
      "the ThinkPad as target",
    );
    // Both rooms are on new sockets; the frozen ones were given up.
    expect(home.openSockets.some((s) => !dead.includes(s))).toBe(true);
    expect(work.openSockets.some((s) => !dead.includes(s))).toBe(true);
  });

  it("goes ahead as soon as live sockets answer their ping", async () => {
    const { c, home, work } = await atHome();
    atTheOffice(home, work);
    c.foreground();
    const took = await until(
      () => c.getSnapshot().target === work.roomB64,
      "the ThinkPad as target",
    );
    expect(took).toBeLessThan(1000);
  });

  it("chooses the one computer that comes back online when the other stays away", async () => {
    const { c, home, work } = await atHome();
    for (const s of [...home.openSockets, ...work.openSockets]) s.drop();
    await until(
      () => c.getSnapshot().rooms.every((r) => !r.connected),
      "both links down",
    );
    // The MacBook at home went to sleep; the ThinkPad does not answer presence at all.
    home.online = false;
    work.presence = null;
    c.foreground();
    await until(
      () => c.getSnapshot().target === work.roomB64,
      "the ThinkPad as target",
    );
  });
});
