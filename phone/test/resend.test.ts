import { describe, expect, it } from "vitest";
import {
  BLOCK_BYTES,
  MAX_PLAINTEXT_LEN,
  AUDIO_CHUNK_HEADER_LEN,
  b64uEncode,
  encodePayload,
  type DevicePayload,
} from "@walkietalkey/protocol";
import { Pacer, packBlocks, type Clock } from "../src/core/resend";
import {
  SessionStreamer,
  newSession,
  type AudioSession,
  type StreamLink,
} from "../src/core/streamer";

function fakeClock(): Clock & { t: number; sleeps: number[] } {
  const c = {
    t: 0,
    sleeps: [] as number[],
    now: () => c.t,
    sleep: async (ms: number) => {
      c.sleeps.push(ms);
      c.t += ms;
    },
  };
  return c;
}

function blocks(n: number, last = BLOCK_BYTES): Uint8Array[] {
  return Array.from({ length: n }, (_, i) =>
    new Uint8Array(i === n - 1 ? last : BLOCK_BYTES).fill(i % 251),
  );
}

describe("resend packing (PHONE-32)", () => {
  it("packs up to 10 blocks (2 s) per frame, in order, with the right first index", () => {
    const b = blocks(23, 1200);
    const frames = packBlocks(b);
    expect(frames.map((f) => f.firstIndex)).toEqual([0, 10, 20]);
    expect(frames.map((f) => f.pcm.length)).toEqual([
      64000,
      64000,
      2 * 6400 + 1200,
    ]);
    expect(frames[1]!.pcm[0]).toBe(10);
    expect(frames[2]!.pcm[2 * 6400]).toBe(22);
  });

  it("keeps every packed frame under the frame size limit", () => {
    const [f] = packBlocks(blocks(10));
    const sid = new Uint8Array(16);
    const { bytes } = encodePayload({
      type: "audio_chunk",
      sessionId: sid,
      firstIndex: 0,
      pcm: f!.pcm,
    });
    expect(bytes.length).toBe(AUDIO_CHUNK_HEADER_LEN + 64000);
    expect(bytes.length).toBeLessThanOrEqual(MAX_PLAINTEXT_LEN);
  });

  it("can start from a later block", () => {
    expect(
      packBlocks(blocks(15), 12).map((f) => [f.firstIndex, f.pcm.length]),
    ).toEqual([[12, 3 * 6400]]);
  });
});

describe("resend pacing (at most 25 frames per second, RELAY-11)", () => {
  it("never lets more than 25 frames into any one-second window", async () => {
    const clock = fakeClock();
    const pacer = new Pacer(25, clock);
    const times: number[] = [];
    for (let i = 0; i < 80; i++) {
      await pacer.next();
      times.push(clock.now());
    }
    for (const start of times) {
      expect(
        times.filter((t) => t >= start && t < start + 1000).length,
      ).toBeLessThanOrEqual(25);
    }
    // And it does not dawdle: 80 frames in about 3.2 s.
    expect(times[79]!).toBeLessThanOrEqual(79 * 40 + 1);
  });

  it("does not wait when frames are already spaced out", async () => {
    const clock = fakeClock();
    const pacer = new Pacer(25, clock);
    await pacer.next();
    clock.t += 500;
    await pacer.next();
    expect(clock.sleeps).toEqual([]);
  });
});

class FakeLink implements StreamLink {
  connId = 1;
  connected = true;
  sent: { conn: number; p: DevicePayload; t: number }[] = [];
  constructor(private clock: { now: () => number }) {}
  async send(p: DevicePayload): Promise<boolean> {
    if (!this.connected) return false;
    this.sent.push({ conn: this.connId, p, t: this.clock.now() });
    return true;
  }
  drop() {
    this.connected = false;
  }
  reconnect() {
    this.connId++;
    this.connected = true;
  }
  types(conn?: number) {
    return this.sent
      .filter((s) => conn === undefined || s.conn === conn)
      .map((s) => s.p.type);
  }
}

function chunkIndices(link: FakeLink, conn: number): number[] {
  const out: number[] = [];
  for (const s of link.sent) {
    if (s.conn !== conn || s.p.type !== "audio_chunk") continue;
    const n = Math.ceil(s.p.pcm.length / BLOCK_BYTES);
    for (let i = 0; i < n; i++) out.push(s.p.firstIndex + i);
  }
  return out;
}

describe("SessionStreamer (PHONE-31, PHONE-32)", () => {
  function setup() {
    const clock = fakeClock();
    const link = new FakeLink(clock);
    const streamer = new SessionStreamer(link, new Pacer(25, clock));
    const s: AudioSession = newSession("room", 0);
    return { clock, link, streamer, s };
  }

  it("streams live: audio_start, one chunk per 200 ms block, audio_end", async () => {
    const { link, streamer, s } = setup();
    await streamer.start(s);
    for (const b of blocks(4, 640)) await streamer.addBlock(s, b);
    await streamer.end(s);
    expect(link.types()).toEqual([
      "audio_start",
      "audio_chunk",
      "audio_chunk",
      "audio_chunk",
      "audio_chunk",
      "audio_end",
    ]);
    const end = link.sent.at(-1)!.p;
    expect(end).toMatchObject({
      type: "audio_end",
      chunks: 4,
      durationMs: 620,
    });
    const sid = (link.sent[0]!.p as { sessionId: Uint8Array }).sessionId;
    expect(b64uEncode(sid)).toBe(s.sid);
    expect(
      link.sent
        .slice(1, 5)
        .map((x) => (x.p as { firstIndex: number }).firstIndex),
    ).toEqual([0, 1, 2, 3]);
  });

  it("keeps blocks in memory while offline and resends the whole session after the reconnect", async () => {
    const { link, streamer, s } = setup();
    await streamer.start(s);
    for (const b of blocks(3)) await streamer.addBlock(s, b);
    link.drop();
    for (const b of blocks(12)) await streamer.addBlock(s, b);
    expect(s.blocks.length).toBe(15);
    link.reconnect();
    await streamer.resendOpen([s]);
    // Live again on the new connection.
    await streamer.addBlock(s, new Uint8Array(BLOCK_BYTES));
    await streamer.end(s);
    expect(link.types(2)).toEqual([
      "audio_start",
      "audio_chunk",
      "audio_chunk",
      "audio_chunk",
      "audio_end",
    ]);
    expect(chunkIndices(link, 2)).toEqual(
      Array.from({ length: 16 }, (_, i) => i),
    );
    const end = link.sent.at(-1)!.p;
    expect(end).toMatchObject({ chunks: 16 });
  });

  it("resends an ended session in full, paced, with audio_end last", async () => {
    const { clock, link, streamer, s } = setup();
    await streamer.start(s);
    link.drop();
    for (const b of blocks(95, 400)) await streamer.addBlock(s, b);
    await streamer.end(s);
    link.reconnect();
    await streamer.resendOpen([s]);
    const resent = link.sent.filter((x) => x.conn === 2);
    expect(resent.map((x) => x.p.type)).toEqual([
      "audio_start",
      ...Array(10).fill("audio_chunk"),
      "audio_end",
    ]);
    expect(chunkIndices(link, 2)).toEqual(
      Array.from({ length: 95 }, (_, i) => i),
    );
    const times = resent.map((x) => x.t);
    for (const t0 of times)
      expect(
        times.filter((t) => t >= t0 && t < t0 + 1000).length,
      ).toBeLessThanOrEqual(25);
    expect(clock.now()).toBeGreaterThan(0);
  });

  it("does not resend sessions that have a result, were cancelled or failed", async () => {
    const { link, streamer } = setup();
    const done = newSession("room", 0);
    const cancelled = newSession("room", 0);
    const failed = newSession("room", 0);
    for (const x of [done, cancelled, failed]) {
      await streamer.start(x);
      await streamer.addBlock(x, new Uint8Array(BLOCK_BYTES));
      await streamer.end(x);
    }
    done.result = { ok: true };
    await streamer.cancel(cancelled);
    failed.failed = true;
    link.reconnect();
    await streamer.resendOpen([done, cancelled, failed]);
    expect(link.types(2)).toEqual([]);
    expect(cancelled.blocks.length).toBe(0);
  });

  it("Prøv igen resends a failed session on the current connection", async () => {
    const { link, streamer, s } = setup();
    await streamer.start(s);
    for (const b of blocks(3)) await streamer.addBlock(s, b);
    await streamer.end(s);
    s.failed = true;
    await streamer.retry(s);
    expect(s.failed).toBe(false);
    expect(link.types(1)).toEqual([
      "audio_start",
      "audio_chunk",
      "audio_chunk",
      "audio_chunk",
      "audio_end",
      "audio_start",
      "audio_chunk",
      "audio_end",
    ]);
  });

  it("sends audio_cancel when cancelled and forgets the audio", async () => {
    const { link, streamer, s } = setup();
    await streamer.start(s);
    await streamer.addBlock(s, new Uint8Array(BLOCK_BYTES));
    await streamer.cancel(s);
    expect(link.types()).toEqual([
      "audio_start",
      "audio_chunk",
      "audio_cancel",
    ]);
    expect(s.blocks).toEqual([]);
    expect(s.cancelled).toBe(true);
  });

  it("the computer comes back (peer online): an ended session goes again on the same connection", async () => {
    const { link, streamer, s } = setup();
    await streamer.start(s);
    for (const b of blocks(3)) await streamer.addBlock(s, b);
    await streamer.end(s);
    // Everything went to the computer's quiet old socket and was lost; the phone's socket is fine.
    const before = link.sent.length;
    await streamer.peerReturned([s]);
    expect(link.sent.slice(before).map((x) => x.p.type)).toEqual([
      "audio_start",
      "audio_chunk",
      "audio_end",
    ]);
    expect(link.sent.slice(before).every((x) => x.conn === 1)).toBe(true);
    expect(link.sent.at(-1)!.p).toMatchObject({ chunks: 3 });
    expect(s.endSent).toBe(true);
  });

  it("a session still being recorded goes again and then stays live", async () => {
    const { link, streamer, s } = setup();
    await streamer.start(s);
    for (const b of blocks(4)) await streamer.addBlock(s, b);
    const before = link.sent.length;
    await streamer.peerReturned([s]);
    await streamer.addBlock(s, new Uint8Array(BLOCK_BYTES));
    await streamer.end(s);
    const again = link.sent.slice(before);
    expect(again.map((x) => x.p.type)).toEqual([
      "audio_start",
      "audio_chunk",
      "audio_chunk",
      "audio_end",
    ]);
    const firsts = again
      .filter((x) => x.p.type === "audio_chunk")
      .map((x) => (x.p as { firstIndex: number }).firstIndex);
    expect(firsts).toEqual([0, 4]);
    expect(again.at(-1)!.p).toMatchObject({ chunks: 5 });
  });

  it("skips sessions that failed, were cancelled or have a result", async () => {
    const { link, streamer } = setup();
    const done = newSession("room", 0);
    const cancelled = newSession("room", 0);
    const failed = newSession("room", 0);
    for (const x of [done, cancelled, failed]) {
      await streamer.start(x);
      await streamer.addBlock(x, new Uint8Array(BLOCK_BYTES));
      await streamer.end(x);
    }
    done.result = { ok: true };
    await streamer.cancel(cancelled);
    failed.failed = true;
    const before = link.sent.length;
    await streamer.peerReturned([done, cancelled, failed]);
    expect(link.sent.length).toBe(before);
    expect(failed.conn).toBe(1);
  });

  it("a resend in flight when the computer comes back runs once more afterwards", async () => {
    const { link, streamer, s } = setup();
    await streamer.start(s);
    link.drop();
    for (const b of blocks(12)) await streamer.addBlock(s, b);
    await streamer.end(s);
    link.reconnect();
    const first = streamer.resendOpen([s]);
    expect(s.resending).toBe(true);
    const second = streamer.peerReturned([s]);
    await Promise.all([first, second]);
    expect(link.types(2)).toEqual([
      "audio_start",
      "audio_chunk",
      "audio_chunk",
      "audio_end",
      "audio_start",
      "audio_chunk",
      "audio_chunk",
      "audio_end",
    ]);
    expect(s.resending).toBe(false);
  });

  it("a reconnect during a resend sends the whole session on the new connection", async () => {
    const { link, streamer, s } = setup();
    await streamer.start(s);
    link.drop();
    for (const b of blocks(25)) await streamer.addBlock(s, b);
    await streamer.end(s);
    link.reconnect();
    const first = streamer.resendOpen([s]);
    // The new socket dies at once and the next one authenticates while the first resend runs.
    link.drop();
    link.reconnect();
    const second = streamer.resendOpen([s]);
    await Promise.all([first, second]);
    expect(link.types(3)).toEqual([
      "audio_start",
      "audio_chunk",
      "audio_chunk",
      "audio_chunk",
      "audio_end",
    ]);
    expect(chunkIndices(link, 3)).toEqual(
      Array.from({ length: 25 }, (_, i) => i),
    );
    expect(s.conn).toBe(3);
  });

  it("starts nothing on the wire while disconnected, then sends it all after the reconnect", async () => {
    const { link, streamer, s } = setup();
    link.drop();
    await streamer.start(s);
    for (const b of blocks(2, 100)) await streamer.addBlock(s, b);
    await streamer.end(s);
    expect(link.sent).toEqual([]);
    link.reconnect();
    await streamer.resendOpen([s]);
    expect(link.types(2)).toEqual(["audio_start", "audio_chunk", "audio_end"]);
    expect(link.sent.at(-1)!.p).toMatchObject({
      chunks: 2,
      durationMs: Math.round((3200 + 50) / 16),
    });
  });
});
