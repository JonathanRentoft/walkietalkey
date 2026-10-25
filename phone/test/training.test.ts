import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import {
  BLOCK_BYTES,
  b64uEncode,
  randomBytes,
  utf8Encode,
  type DevicePayload,
  type TrainingCheck,
} from "@walkietalkey/protocol";
import type { RecorderLike } from "../src/audio/recorder";
import { PhoneController } from "../src/core/controller";
import { PhoneStorage } from "../src/lib/storage";
import { checkMessage, trainingItem } from "../src/training/state";
import { FakeComputer, FakeRelay } from "./fake-relay";

/* Training takes for the fine-tuning workbench (PROTOCOL.md 8.4, PRIV-05): the computer's
   prompt shows the training screen, a press records the prompt through the dictation path and
   sends it as audio_start_training, and the phone returns to normal when the session ends. */

class ThreeBlocks implements RecorderLike {
  private onBlock: ((b: Uint8Array, level: number) => void) | null = null;
  prime(): void {}
  async warm(): Promise<void> {}
  cool(): void {}
  microphoneName(): string | null {
    return "iPhone-mikrofon";
  }
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

async function paired(names = ["MacBook"]) {
  const storage = await PhoneStorage.open(`wt-training-${++n}`);
  const relay = new FakeRelay();
  const computers: FakeComputer[] = [];
  for (const [i, name] of names.entries()) {
    const c = await FakeComputer.pairedWith(storage, name, i + 1);
    relay.add(c);
    computers.push(c);
  }
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
    trainingStaleMs: 300,
  });
  await c.init();
  made.push({ c, s: storage });
  await until(
    () => c.getSnapshot().rooms.every((r) => r.online),
    "every computer online",
  );
  return { c, mac: computers[0]!, computers };
}

const training = randomBytes(16);

function prompt(
  next: string | null,
  last: [string, TrainingCheck] | null = null,
  id = training,
): DevicePayload {
  return {
    type: "training_prompt",
    training: id,
    style: "whisper",
    done: last ? 1 : 0,
    total: 416,
    ...(next ? { next: { prompt: next, text: `Sætning ${next}.` } } : {}),
    ...(last
      ? {
          last: {
            prompt: last[0],
            text: `Sætning ${last[0]}.`,
            check: last[1],
          },
        }
      : {}),
  };
}

async function record(c: PhoneController): Promise<void> {
  c.down();
  c.up();
  await sleep(30);
  c.down();
  c.up();
}

describe("training takes on the phone", () => {
  it("shows the prompt, records it as a training take, and moves on", async () => {
    const { c, mac } = await paired();
    expect(c.getSnapshot().training).toBeNull();
    await mac.toPhone(prompt("s0042"));
    await until(() => c.getSnapshot().training !== null, "the training screen");
    const t = c.getSnapshot().training!;
    expect(t.computer).toBe("MacBook");
    expect(t.style).toBe("whisper");
    expect([t.done, t.total]).toEqual([0, 416]);
    expect(trainingItem(t)).toEqual({
      prompt: "s0042",
      text: "Sætning s0042.",
    });

    await record(c);
    await until(() => c.getSnapshot().machine.phase === "ready", "saved");
    const [s] = [...mac.sessions.values()];
    expect(s!.training).toEqual({
      id: b64uEncode(training),
      prompt: "s0042",
      microphone: "iPhone-mikrofon",
    });
    expect(s!.end).toBe(4);

    // The computer's next prompt carries the check of the take just made.
    await mac.toPhone(prompt("s0043", ["s0042", "quiet"]));
    await until(
      () => trainingItem(c.getSnapshot().training!)?.prompt === "s0043",
      "the next sentence",
    );
    expect(c.getSnapshot().training!.last?.check).toBe("quiet");
  });

  it("records the last sentence again on request (a redo)", async () => {
    const { c, mac } = await paired();
    await mac.toPhone(prompt("s0043", ["s0042", "clipped"]));
    await until(() => c.getSnapshot().training !== null, "the training screen");
    c.trainingRedo(true);
    expect(trainingItem(c.getSnapshot().training!)).toEqual({
      prompt: "s0042",
      text: "Sætning s0042.",
    });
    await record(c);
    await until(() => c.getSnapshot().machine.phase === "ready", "saved");
    expect([...mac.sessions.values()][0]!.training!.prompt).toBe("s0042");
    // The computer answers with a new prompt; the redo is over.
    await mac.toPhone(prompt("s0043", ["s0042", "ok"]));
    await until(
      () => c.getSnapshot().training!.last?.check === "ok",
      "the new prompt",
    );
    expect(c.getSnapshot().training!.redo).toBe(false);
    expect(trainingItem(c.getSnapshot().training!)?.prompt).toBe("s0043");
  });

  it("returns to normal at the end, and a press is a dictation again", async () => {
    const { c, mac } = await paired();
    await mac.toPhone(prompt("s0001"));
    await until(() => c.getSnapshot().training !== null, "the training screen");
    // An end for another session changes nothing.
    await mac.toPhone({ type: "training_end", training: randomBytes(16) });
    await sleep(80);
    expect(c.getSnapshot().training).not.toBeNull();
    await mac.toPhone({ type: "training_end", training });
    await until(() => c.getSnapshot().training === null, "back to normal");
    // A prompt of the session that ended is not shown again.
    await mac.toPhone(prompt("s0002"));
    await sleep(80);
    expect(c.getSnapshot().training).toBeNull();
    await record(c);
    await until(() => c.getSnapshot().machine.phase === "ready", "sent");
    const [s] = [...mac.sessions.values()];
    expect(s!.training).toBeUndefined();
    expect(s!.starts).toBe(1);
  });

  it("waits for a fresh prompt when the computer goes away or the connection drops", async () => {
    const { c, mac } = await paired();
    await mac.toPhone(prompt("s0001"));
    await until(() => c.getSnapshot().training !== null, "the training screen");
    // A take only goes to a computer that showed it supports training on this connection.
    mac.leave();
    await until(
      () => c.getSnapshot().training?.stale === true,
      "computer away",
    );
    await record(c);
    await sleep(60);
    expect(c.getSnapshot().machine.phase).toBe("idle");
    expect(mac.sessions.size).toBe(0);
    // The computer is back and sends the prompt again: recording works.
    mac.reconnect();
    await mac.toPhone(prompt("s0001"));
    await until(
      () => c.getSnapshot().training?.stale === false,
      "prompt again",
    );
    // Without a fresh prompt the phone returns to normal.
    for (const sock of mac.openSockets) sock.drop();
    await until(() => c.getSnapshot().training?.stale === true, "dropped");
    await until(() => c.getSnapshot().training === null, "back to normal");
  });

  it("can be left by hand; a new session shows again", async () => {
    const { c, mac } = await paired();
    await mac.toPhone(prompt("s0001"));
    await until(() => c.getSnapshot().training !== null, "the training screen");
    c.leaveTraining();
    expect(c.getSnapshot().training).toBeNull();
    await mac.toPhone(prompt("s0002"));
    await sleep(80);
    expect(c.getSnapshot().training).toBeNull();
    await mac.toPhone(prompt("s0003", null, randomBytes(16)));
    await until(() => c.getSnapshot().training !== null, "a new session");
  });

  it("takes the computer that sent the prompt as the target", async () => {
    const { c, computers } = await paired(["MacBook", "ThinkPad"]);
    const other = computers.find(
      (x) =>
        x.roomB64 !==
        c.getSnapshot().rooms.find((r) => r.roomId === c.getSnapshot().target)!
          .roomId,
    )!;
    await other.toPhone(prompt("s0001"));
    await until(() => c.getSnapshot().training !== null, "the training screen");
    expect(c.getSnapshot().target).toBe(other.roomB64);
    await record(c);
    await until(
      () => other.sessions.size === 1,
      "the take at the prompting computer",
    );
  });

  it("drops a frame type it does not know, as a phone without training support drops the prompt", async () => {
    const { c, mac } = await paired();
    await mac.toPhoneRaw(0x3f, utf8Encode('{"later":true}'));
    await mac.toPhone(prompt("s0001"));
    await until(() => c.getSnapshot().training !== null, "the prompt after it");
  });
});

describe("the training screen's words", () => {
  it("has a message for every check, and Hørte ikke noget for silence", () => {
    const checks: TrainingCheck[] = [
      "ok",
      "quiet",
      "clipped",
      "short",
      "silent",
      "gaps",
      "error",
    ];
    for (const check of checks) expect(checkMessage(check)).toBeTruthy();
    expect(checkMessage("silent")).toContain("Hørte ikke noget");
    for (const check of checks)
      expect(checkMessage(check)).not.toMatch(/[—–!]/);
  });
});
