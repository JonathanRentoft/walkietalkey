import { describe, expect, it } from "vitest";
import { CaptureSink, PRE_ROLL_MS, PreRoll } from "../src/audio/capture";

/** Float samples whose PCM16 value is their index (index / 32768), so order and gaps show. */
function ramp(from: number, n: number): Float32Array {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = ((from + i) % 30000) / 32768;
  return out;
}

/**
 * A CaptureSink on a fake clock that runs like the real microphone: each batch arrives the moment
 * its last sample was captured, so the clock moves on by the batch's length. Samples are followed
 * by their values, so the pipeline runs without gain (the gain has its own tests in pcm.test.ts).
 */
class RealtimeSink extends CaptureSink {
  readonly clock: { t: number };
  constructor(sampleRate: number) {
    const clock = { t: 10_000 };
    super(sampleRate, () => clock.t, 0);
    this.clock = clock;
  }
  override push(samples: Float32Array): void {
    this.clock.t += (samples.length * 1000) / this.sampleRate;
    super.push(samples);
  }
}

function feed(sink: CaptureSink, from: number, n: number, chunk = 1000) {
  for (let o = 0; o < n; o += chunk)
    sink.push(ramp(from + o, Math.min(chunk, n - o)));
}

/** Collects the PCM16 samples of every block, in order. */
function collector() {
  const samples: number[] = [];
  const sizes: number[] = [];
  const onBlock = (block: Uint8Array) => {
    const v = new DataView(block.buffer, block.byteOffset, block.byteLength);
    for (let i = 0; i < block.length; i += 2) samples.push(v.getInt16(i, true));
    sizes.push(block.length / 2);
  };
  return { samples, sizes, onBlock };
}

describe("PreRoll: the last 300 ms in memory (PHONE-30, PHONE-33)", () => {
  it("is 300 ms", () => {
    expect(PRE_ROLL_MS).toBe(300);
    expect(new PreRoll(48000).capacity).toBe(14400);
    expect(new PreRoll(16000).capacity).toBe(4800);
  });

  it("keeps exactly the newest samples, oldest first, across wrap-around", () => {
    const r = new PreRoll(1000, 10); // 10 samples
    r.push(Float32Array.from([1, 2, 3]));
    expect(Array.from(r.take())).toEqual([1, 2, 3]);
    r.push(Float32Array.from([4, 5, 6, 7, 8, 9]));
    r.push(Float32Array.from([10, 11, 12, 13]));
    expect(Array.from(r.take())).toEqual([4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
    // A chunk larger than the ring keeps only its tail.
    r.push(Float32Array.from(Array.from({ length: 25 }, (_, i) => 100 + i)));
    expect(Array.from(r.take())).toEqual([
      115, 116, 117, 118, 119, 120, 121, 122, 123, 124,
    ]);
    expect(r.length).toBe(10);
  });

  it("forgets everything on clear", () => {
    const r = new PreRoll(1000, 10);
    r.push(Float32Array.from([1, 2, 3]));
    r.clear();
    expect(r.length).toBe(0);
    expect(r.take().length).toBe(0);
    r.push(Float32Array.from([7]));
    expect(Array.from(r.take())).toEqual([7]);
  });

  it("at button-down keeps only the samples captured in the last 300 ms (PHONE-33)", () => {
    // 1,000 samples per second: one sample per millisecond, a 10 sample ring.
    const r = new PreRoll(1000, 10);
    r.push(Float32Array.from([1, 2, 3]), 100); // captured at 98, 99 and 100 ms
    r.push(Float32Array.from([4, 5, 6]), 500); // at 498, 499 and 500 ms, after a pause
    expect(Array.from(r.take())).toEqual([1, 2, 3, 4, 5, 6]);
    expect(Array.from(r.take(503))).toEqual([4, 5, 6]);
    expect(Array.from(r.take(799))).toEqual([5, 6]);
    expect(Array.from(r.take(800))).toEqual([6]);
    expect(r.take(900).length).toBe(0);
    // Samples that the ring overwrote take their time stamps with them.
    r.push(Float32Array.from([7, 8, 9, 10, 11, 12, 13, 14, 15]), 510);
    expect(Array.from(r.take(510))).toEqual([
      6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
    ]);
    expect(Array.from(r.take(805))).toEqual([10, 11, 12, 13, 14, 15]);
  });
});

/* Review finding (run 2): an audio interruption that suspends the AudioContext without ending the
   track (Siri, a call that was declined, another app's sound) left the ring full of audio from
   before it, and the next press sent that audio, however old, in front of the dictation. */
describe("CaptureSink: never audio older than 300 ms in front of a dictation (PHONE-30, PHONE-33)", () => {
  it("pressed during a pause, the dictation starts at the press", () => {
    const sink = new RealtimeSink(16000);
    feed(sink, 0, 16000, 320);
    // Two minutes without a sample: the AudioContext was interrupted, the track did not end.
    sink.clock.t += 120_000;
    const c = collector();
    sink.begin(c.onBlock);
    feed(sink, 20_000, 3200, 320);
    sink.end();
    expect(c.samples.length).toBe(3200);
    expect(c.samples[0]).toBe(20_000);
  });

  it("after the audio comes back, the pre-roll holds only what came after the pause", () => {
    const sink = new RealtimeSink(16000);
    feed(sink, 0, 16000, 320);
    sink.clock.t += 120_000;
    // 200 ms of new audio. Its first batch may start with samples the worklet held from before
    // the pause, so it is left out.
    feed(sink, 20_000, 3200, 320);
    const c = collector();
    sink.begin(c.onBlock);
    sink.end();
    expect(c.samples.length).toBe(3200 - 320);
    expect(c.samples[0]).toBe(20_320);
    expect(c.samples.at(-1)).toBe(23_199);
  });

  it("a press 200 ms after the last sample keeps only the newest 100 ms", () => {
    const sink = new RealtimeSink(16000);
    feed(sink, 0, 16000, 320);
    sink.clock.t += 200;
    const c = collector();
    sink.begin(c.onBlock);
    sink.end();
    // 100 ms at 16 kHz, give or take the sample on the edge.
    expect(c.samples.length).toBeGreaterThanOrEqual(1600);
    expect(c.samples.length).toBeLessThanOrEqual(1601);
    expect(c.samples.at(-1)).toBe(15_999);
  });

  it("delivery that comes in bursts (a large iOS audio buffer) keeps the whole 300 ms", () => {
    const sink = new RealtimeSink(48000);
    // Four 1,024 sample batches at a time, every 85 ms, as a 4,096 frame hardware buffer does.
    for (let burst = 0; burst < 20; burst++) {
      sink.clock.t += 85.33;
      for (let i = 0; i < 4; i++)
        CaptureSink.prototype.push.call(
          sink,
          ramp(burst * 4096 + i * 1024, 1024),
        );
    }
    const c = collector();
    sink.begin(c.onBlock);
    sink.end();
    // 14,400 samples at 48 kHz are 4,800 at 16 kHz.
    expect(Math.abs(c.samples.length - 4800)).toBeLessThan(2);
  });
});

describe("CaptureSink: nothing lost at button-down (PHONE-20, PHONE-21, PHONE-30)", () => {
  it("prepends the 300 ms before the press, then every sample after it, with no gap", () => {
    const sink = new RealtimeSink(16000);
    const c = collector();
    // The warm microphone has run for 2 s before the press.
    feed(sink, 0, 32000, 512);
    sink.begin(c.onBlock);
    // The first samples after button-down, and the rest of the dictation.
    feed(sink, 32000, 16000, 700);
    sink.end();
    const pre = 4800;
    expect(c.samples.length).toBe(pre + 16000);
    for (let i = 0; i < c.samples.length; i++)
      expect(c.samples[i]).toBe((32000 - pre + i) % 30000);
    // 200 ms blocks of 3,200 samples; only the last one may be shorter.
    expect(c.sizes.slice(0, -1).every((n) => n === 3200)).toBe(true);
    expect(sink.recording).toBe(false);
  });

  it("keeps the very first samples after the press even when they arrive in tiny batches", () => {
    const sink = new RealtimeSink(16000);
    const c = collector();
    feed(sink, 0, 8000, 128);
    sink.begin(c.onBlock);
    sink.push(ramp(8000, 1));
    sink.push(ramp(8001, 127));
    sink.end();
    expect(c.samples.slice(4800, 4802)).toEqual([8000, 8001]);
    expect(c.samples.length).toBe(4800 + 128);
  });

  it("right after the microphone opened, the pre-roll is what there is", () => {
    const sink = new RealtimeSink(16000);
    const c = collector();
    feed(sink, 0, 1000);
    sink.begin(c.onBlock);
    feed(sink, 1000, 3200);
    sink.end();
    expect(c.samples).toEqual(Array.from({ length: 4200 }, (_, i) => i));
  });

  it("at 48 kHz: 300 ms before plus everything after, resampled to 16 kHz", () => {
    const sink = new RealtimeSink(48000);
    const c = collector();
    for (let i = 0; i < 100; i++) sink.push(new Float32Array(1024).fill(0.25));
    sink.begin(c.onBlock);
    for (let i = 0; i < 47; i++) sink.push(new Float32Array(1024).fill(0.25));
    sink.end();
    // 14,400 + 48,128 input samples at 48 kHz -> 20,842.67 at 16 kHz.
    expect(Math.abs(c.samples.length - (14400 + 47 * 1024) / 3)).toBeLessThan(
      2,
    );
    // A constant signal stays constant (no ramp-in, no gap at the join).
    const mid = c.samples.slice(40, -40);
    expect(Math.min(...mid)).toBe(8192);
    expect(Math.max(...mid)).toBe(8192);
  });

  it("the next dictation's pre-roll never holds audio from the one before", () => {
    const sink = new RealtimeSink(16000);
    const first = collector();
    feed(sink, 0, 8000);
    sink.begin(first.onBlock);
    feed(sink, 8000, 3200);
    sink.end();
    // Pressed again 100 ms later.
    feed(sink, 11200, 1600);
    const second = collector();
    sink.begin(second.onBlock);
    feed(sink, 12800, 3200);
    sink.end();
    expect(second.samples[0]).toBe(11200);
    expect(second.samples.length).toBe(1600 + 3200);
  });

  it("drop() forgets the recording and the pre-roll; nothing more is delivered", () => {
    const sink = new RealtimeSink(16000);
    const c = collector();
    feed(sink, 0, 8000);
    sink.begin(c.onBlock);
    feed(sink, 8000, 1000);
    const before = c.samples.length;
    sink.drop();
    feed(sink, 9000, 8000);
    expect(c.samples.length).toBe(before);
    expect(sink.recording).toBe(false);
    const next = collector();
    sink.begin(next.onBlock);
    sink.end();
    // Only what came after the drop, at most 300 ms of it.
    expect(next.samples[0]).toBe(17000 - 4800);
  });

  it("clear() empties the pre-roll (microphone closed)", () => {
    const sink = new RealtimeSink(16000);
    feed(sink, 0, 8000);
    sink.clear();
    const c = collector();
    sink.begin(c.onBlock);
    sink.end();
    expect(c.samples.length).toBe(0);
  });
});
