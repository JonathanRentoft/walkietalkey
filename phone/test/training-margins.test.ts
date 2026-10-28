import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BLOCK_BYTES,
  randomBytes,
  type DevicePayload,
} from "@walkietalkey/protocol";
import { MicDeniedError, type RecorderLike } from "../src/audio/recorder";
import {
  MAX_RECORDING_MS,
  MIC_IDLE_MS,
  PhoneController,
  TRAINING_TAIL_MS,
} from "../src/core/controller";
import { PhoneStorage } from "../src/lib/storage";
import { trainingItem } from "../src/training/state";
import { FakeComputer, FakeRelay } from "./fake-relay";

/* A training take always has margins (run 12; PHONE-30, PHONE-33, PHONE-50). The owner's pilot
   found speech at the very start or end of many takes. While the training screen shows, the warm
   microphone never goes idle, so every take starts with the 300 ms before the press (the
   pre-roll), the first after a quiet spell too; and a take records on for TRAINING_TAIL_MS after
   the release before it ends. Dictations are unchanged.

   The tail and the idle time run on fake timers; the relay's crypto runs on real time, so waits
   for it poll with the real setTimeout. */

const realSetTimeout = globalThis.setTimeout;
const realSleep = (ms: number) =>
  new Promise<void>((r) => realSetTimeout(r, ms));

async function until(cond: () => boolean, what: string, timeoutMs = 5000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out: ${what}`);
    await realSleep(5);
  }
}

/** Fake time from here on (setTimeout only: storage and crypto keep their own scheduling). */
function fakeTime(): void {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout"],
    shouldClearNativeTimers: true,
  });
}

const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);

/** The microphone as the controller sees it: what it was asked, and blocks when the test says so. */
class MarginMic implements RecorderLike {
  calls: string[] = [];
  warmError: Error | null = null;
  private onBlock: ((b: Uint8Array, level: number) => void) | null = null;
  prime(): void {}
  async warm(): Promise<void> {
    this.calls.push("warm");
    if (this.warmError) throw this.warmError;
  }
  cool(): void {
    this.calls.push("cool");
  }
  microphoneName(): string | null {
    return "iPhone-mikrofon";
  }
  /** The pre-roll and the first block, at once. */
  async start(onBlock: (b: Uint8Array, level: number) => void): Promise<void> {
    this.calls.push("start");
    this.onBlock = onBlock;
    onBlock(new Uint8Array(BLOCK_BYTES), 0.1);
  }
  /** The last, shorter block; then the take is over. */
  async stop(): Promise<void> {
    this.calls.push("stop");
    this.onBlock?.(new Uint8Array(1000), 0);
    this.onBlock = null;
  }
  abort(): void {
    this.calls.push("abort");
    this.onBlock = null;
  }
  /** One 200 ms block from the microphone, while a take records. */
  block(rms = 0.1): void {
    this.onBlock?.(new Uint8Array(BLOCK_BYTES), rms);
  }
  /** Calls since the last look. */
  take(): string[] {
    return this.calls.splice(0);
  }
}

let n = 0;
const made: { c: PhoneController; s: PhoneStorage }[] = [];

afterEach(async () => {
  vi.useRealTimers();
  for (const m of made.splice(0)) {
    m.c.dispose();
    m.s.close();
  }
  await realSleep(20);
});

const training = randomBytes(16);

function prompt(next: string): DevicePayload {
  return {
    type: "training_prompt",
    training,
    style: "whisper",
    done: 0,
    total: 416,
    next: { prompt: next, text: `Sætning ${next}.` },
  };
}

/** Paired with one computer; by default its training screen shows. The microphone is warm. */
async function setup(opts: { training?: boolean } = {}) {
  const storage = await PhoneStorage.open(`wt-margins-${++n}`);
  const relay = new FakeRelay();
  const mac = await FakeComputer.pairedWith(storage, "MacBook", 1);
  relay.add(mac);
  const mic = new MarginMic();
  const clock = { t: Date.now() };
  const c = new PhoneController({
    storage,
    platform: { os: "ios", standalone: true, shell: false, device: "iPhone" },
    recorder: mic,
    haptic: () => undefined,
    wake: {
      acquire: () => undefined,
      release: () => undefined,
      visible: () => undefined,
    },
    WebSocketImpl: relay.WebSocket,
    backoffMs: [60_000],
    trainingStaleMs: 300,
    now: () => clock.t,
  });
  await c.init();
  made.push({ c, s: storage });
  await until(
    () => c.getSnapshot().rooms.every((r) => r.online),
    "the computer online",
  );
  if (opts.training ?? true) {
    await mac.toPhone(prompt("s0001"));
    await until(() => c.getSnapshot().training !== null, "the training screen");
  }
  expect(mic.take()).toEqual(["warm"]);
  return { c, mac, mic, clock, relay };
}

type Setup = Awaited<ReturnType<typeof setup>>;

/** A frame from the computer while the time is fake: the relay's delay passes, then its crypto. */
async function fromComputer(
  { mac, relay }: Setup,
  p: DevicePayload,
  arrived: () => boolean,
  what: string,
) {
  await mac.toPhone(p);
  await advance(relay.latencyMs);
  await until(arrived, what);
}

/** The computer's view of the takes, in the order they started. */
const takes = (mac: FakeComputer) => [...mac.sessions.values()];

/** Holds the button for 1.5 s (push-to-talk, PHONE-26) with two more blocks, and lets go. */
async function holdAndRelease({ c, mic, clock }: Setup): Promise<void> {
  c.down();
  await until(() => mic.calls.includes("start"), "recording");
  mic.block();
  mic.block();
  clock.t += 1500;
  expect(mic.take()).toEqual(["start"]);
  c.up();
}

/** The idle time counts from now: the warm microphone closes MIC_IDLE_MS later, not sooner. */
async function idleFromNow(mic: MarginMic): Promise<void> {
  await advance(MIC_IDLE_MS - 1);
  expect(mic.take()).toEqual([]);
  await advance(1);
  expect(mic.take()).toEqual(["cool"]);
}

describe("the pre-roll is always there while the training screen shows (PHONE-30, PHONE-50)", () => {
  it("the warm microphone never goes idle over the sentence; after Afslut the idle time counts from then", async () => {
    const t = await setup();
    fakeTime();
    // A touch (Tag om, say) would start the idle time on the main screen.
    t.c.activity();
    await advance(MIC_IDLE_MS * 3);
    expect(t.mic.take()).toEqual([]);
    t.c.leaveTraining();
    await idleFromNow(t.mic);
  });

  it("after the computer's training_end the idle time counts from then", async () => {
    const t = await setup();
    fakeTime();
    t.c.activity();
    await advance(MIC_IDLE_MS * 2);
    await fromComputer(
      t,
      { type: "training_end", training },
      () => t.c.getSnapshot().training === null,
      "the main screen",
    );
    expect(t.mic.take()).toEqual([]);
    await idleFromNow(t.mic);
  });

  it("stays warm while a stale prompt waits; when it ends unrenewed the idle time counts from then (PHONE-51)", async () => {
    const t = await setup();
    fakeTime();
    t.c.activity();
    t.mac.leave();
    await advance(t.relay.latencyMs);
    await until(() => t.c.getSnapshot().training?.stale === true, "stale");
    // "Venter på MacBook" for 300 ms (trainingStaleMs), still warm.
    await advance(299);
    expect(t.c.getSnapshot().training).not.toBeNull();
    await advance(1);
    expect(t.c.getSnapshot().training).toBeNull();
    expect(t.mic.take()).toEqual([]);
    await idleFromNow(t.mic);
  });

  it("the first take after a quiet spell starts with the pre-roll: the microphone was warm all along", async () => {
    const t = await setup();
    fakeTime();
    await holdAndRelease(t);
    await advance(TRAINING_TAIL_MS);
    expect(t.mic.take()).toEqual(["stop"]);
    // Four quiet minutes over the next sentence, longer than the idle time.
    await advance(MIC_IDLE_MS + 60_000);
    expect(t.mic.take()).toEqual([]);
    t.c.down();
    await until(() => t.mic.calls.includes("start"), "the next take");
    // Not opened at the press (that would have no pre-roll): warm, with the 300 ms before it.
    expect(t.mic.take()).toEqual(["start"]);
  });

  it("a training prompt opens a microphone that went idle on the main screen", async () => {
    const t = await setup({ training: false });
    fakeTime();
    t.c.activity();
    await advance(MIC_IDLE_MS);
    expect(t.mic.take()).toEqual(["cool"]);
    await fromComputer(
      t,
      prompt("s0001"),
      () => t.c.getSnapshot().training !== null,
      "the training screen",
    );
    expect(t.mic.take()).toEqual(["warm"]);
    await advance(MIC_IDLE_MS * 2);
    expect(t.mic.take()).toEqual([]);
  });

  it("still closes in the background and opens again in the foreground, the screen still there", async () => {
    const t = await setup();
    fakeTime();
    t.c.hidden();
    await advance(0);
    expect(t.mic.take()).toEqual(["cool"]);
    t.c.foreground();
    expect(t.mic.take()).toEqual(["warm"]);
    await advance(MIC_IDLE_MS * 2);
    expect(t.mic.take()).toEqual([]);
    expect(t.c.getSnapshot().training).not.toBeNull();
  });

  it("a refused microphone is not asked again for every prompt or touch, only when the app comes back", async () => {
    const t = await setup();
    t.mic.warmError = new MicDeniedError();
    t.c.hidden();
    t.c.foreground();
    await realSleep(5);
    expect(t.mic.take()).toEqual(["warm"]);
    // The computer sends its prompt again (it does when it sees the phone online), a touch.
    await t.mac.toPhone(prompt("s0002"));
    await until(
      () => trainingItem(t.c.getSnapshot().training!)?.prompt === "s0002",
      "the prompt again",
    );
    t.c.activity();
    await realSleep(5);
    expect(t.mic.take()).toEqual([]);
    t.mic.warmError = null;
    t.c.hidden();
    t.c.foreground();
    expect(t.mic.take()).toContain("warm");
  });
});

describe("a training take records on for TRAINING_TAIL_MS after the release (PHONE-50)", () => {
  it("is half a second", () => {
    expect(TRAINING_TAIL_MS).toBe(500);
  });

  it("stops the microphone 0.5 s after the release; the screen shows it on its way at once", async () => {
    const t = await setup();
    fakeTime();
    await holdAndRelease(t);
    // At the release: "Sender til MacBook", the meter down, as before.
    expect(t.c.getSnapshot().machine.phase).toBe("send");
    expect(t.c.getSnapshot().level).toBe(0);
    // The tail is recorded but not shown on the meter.
    t.mic.block(0.5);
    expect(t.c.getSnapshot().level).toBe(0);
    await advance(TRAINING_TAIL_MS - 1);
    expect(t.mic.take()).toEqual([]);
    await advance(1);
    expect(t.mic.take()).toEqual(["stop"]);
    // Every block reaches the computer, the tail's too: the first, two, the tail's, the last.
    await until(() => takes(t.mac)[0]?.end === 5, "the take's end");
    const [s] = takes(t.mac);
    expect(s!.training?.prompt).toBe("s0001");
    expect(s!.blocks.size).toBe(5);
    expect(s!.cancelled).toBeUndefined();
    // Once.
    await advance(TRAINING_TAIL_MS);
    expect(t.mic.take()).toEqual([]);
  });

  it("so does a hands-free take, stopped with a tap (PHONE-26)", async () => {
    const t = await setup();
    fakeTime();
    t.c.down();
    t.clock.t += 100;
    t.c.up();
    await until(() => t.mic.calls.includes("start"), "recording");
    expect(t.c.getSnapshot().machine.handsFree).toBe(true);
    t.clock.t += 3000;
    t.c.down();
    t.clock.t += 100;
    t.c.up();
    expect(t.c.getSnapshot().machine.phase).toBe("send");
    expect(t.mic.take()).toEqual(["start"]);
    await advance(TRAINING_TAIL_MS - 1);
    expect(t.mic.take()).toEqual([]);
    await advance(1);
    expect(t.mic.take()).toEqual(["stop"]);
  });

  it("a dictation still stops at the release: no tail once the training screen is gone", async () => {
    const t = await setup();
    t.c.leaveTraining();
    fakeTime();
    await holdAndRelease(t);
    expect(t.c.getSnapshot().machine.phase).toBe("send");
    await advance(0);
    expect(t.mic.take()).toEqual(["stop"]);
    await until(() => takes(t.mac)[0]?.end === 4, "the dictation's end");
    expect(takes(t.mac)[0]!.training).toBeUndefined();
  });

  it("the 5 minute limit ends a take through the same tail (PHONE-29)", async () => {
    const t = await setup();
    fakeTime();
    t.c.down();
    await until(() => t.mic.calls.includes("start"), "recording");
    t.mic.take();
    await advance(MAX_RECORDING_MS);
    expect(t.c.getSnapshot().machine.phase).toBe("send");
    expect(t.mic.take()).toEqual([]);
    await advance(TRAINING_TAIL_MS);
    expect(t.mic.take()).toEqual(["stop"]);
  });

  it("the page hidden during the tail: the take goes at once, then the microphone closes", async () => {
    const t = await setup();
    fakeTime();
    await holdAndRelease(t);
    t.mic.block();
    await advance(200);
    t.c.hidden();
    await until(() => t.mic.calls.includes("cool"), "the microphone closed");
    // The last block is delivered before the microphone closes.
    expect(t.mic.take()).toEqual(["stop", "cool"]);
    await until(() => takes(t.mac)[0]?.end === 5, "the take's end");
    await advance(TRAINING_TAIL_MS);
    expect(t.mic.take()).toEqual([]);
  });

  it("the page hidden while a take records: it goes at once, with no tail", async () => {
    const t = await setup();
    fakeTime();
    t.c.down();
    await until(() => t.mic.calls.includes("start"), "recording");
    t.clock.t += 1500;
    t.mic.take();
    t.c.hidden();
    await until(() => t.mic.calls.includes("cool"), "the microphone closed");
    expect(t.mic.take()).toEqual(["stop", "cool"]);
    expect(t.c.getSnapshot().machine.phase).toBe("send");
  });

  it("a press during the tail ends that take at once; the next take starts after it", async () => {
    const t = await setup();
    fakeTime();
    await holdAndRelease(t);
    t.mic.block();
    await advance(200);
    t.c.down();
    expect(t.c.getSnapshot().machine.phase).toBe("rec");
    await until(() => t.mic.calls.includes("start"), "the next take");
    expect(t.mic.take()).toEqual(["stop", "start"]);
    // The first take's tail is over: it never stops the next take.
    await advance(TRAINING_TAIL_MS);
    expect(t.mic.take()).toEqual([]);
    t.clock.t += 1500;
    t.c.up();
    await advance(TRAINING_TAIL_MS - 1);
    expect(t.mic.take()).toEqual([]);
    await advance(1);
    expect(t.mic.take()).toEqual(["stop"]);
    await until(
      () => takes(t.mac).length === 2 && takes(t.mac).every((s) => !!s.end),
      "both takes",
    );
    // The first: its first block, two, the tail's and the last; the second: its first and last.
    expect(takes(t.mac).map((s) => s.end)).toEqual([5, 2]);
  });

  it("a cancel or a slide during the tail changes nothing: the take is sent", async () => {
    const t = await setup();
    fakeTime();
    await holdAndRelease(t);
    t.c.slide(false);
    t.c.cancel();
    t.c.up();
    expect(t.c.getSnapshot().machine.phase).toBe("send");
    await advance(TRAINING_TAIL_MS);
    expect(t.mic.take()).toEqual(["stop"]);
    await until(() => takes(t.mac)[0]?.end === 4, "the take's end");
    expect(takes(t.mac)[0]!.cancelled).toBeUndefined();
  });

  it("the session ending during the tail: the main screen at once, the take still whole", async () => {
    const t = await setup();
    fakeTime();
    await holdAndRelease(t);
    await fromComputer(
      t,
      { type: "training_end", training },
      () => t.c.getSnapshot().training === null,
      "the main screen",
    );
    expect(t.c.getSnapshot().machine.phase).toBe("send");
    expect(t.mic.take()).toEqual([]);
    await advance(TRAINING_TAIL_MS - t.relay.latencyMs);
    expect(t.mic.take()).toEqual(["stop"]);
    await until(() => takes(t.mac)[0]?.end === 4, "the take's end");
    expect(takes(t.mac)[0]!.training?.prompt).toBe("s0001");
  });

  it("removed by the computer during the tail: the take goes with the room, the microphone closes at once (PHONE-14)", async () => {
    const t = await setup();
    fakeTime();
    await holdAndRelease(t);
    // The computer has the take so far: its start and three blocks.
    await until(
      () => takes(t.mac)[0]?.blocks.size === 3,
      "the take at the computer",
    );
    for (const s of t.mac.openSockets) s.drop(4404);
    await until(() => t.c.getSnapshot().rooms.length === 0, "the room gone");
    await until(() => t.mic.calls.includes("cool"), "the microphone closed");
    expect(t.mic.take()).toEqual(["stop", "cool"]);
    expect(takes(t.mac)[0]!.end).toBeNull();
    await advance(TRAINING_TAIL_MS);
    expect(t.mic.take()).toEqual([]);
  });
});
