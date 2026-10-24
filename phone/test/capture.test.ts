import { describe, expect, it } from "vitest";
import { CaptureSink, PRE_ROLL_MS, PreRoll } from "../src/audio/capture";

/** Float samples whose PCM16 value is their index (index / 32768), so order and gaps show. */
function ramp(from: number, n: number): Float32Array {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = ((from + i) % 30000) / 32768;
  return out;
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
});

describe("CaptureSink: nothing lost at button-down (PHONE-20, PHONE-21, PHONE-30)", () => {
  it("prepends the 300 ms before the press, then every sample after it, with no gap", () => {
    const sink = new CaptureSink(16000);
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
    const sink = new CaptureSink(16000);
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
    const sink = new CaptureSink(16000);
    const c = collector();
    feed(sink, 0, 1000);
    sink.begin(c.onBlock);
    feed(sink, 1000, 3200);
    sink.end();
    expect(c.samples).toEqual(Array.from({ length: 4200 }, (_, i) => i));
  });

  it("at 48 kHz: 300 ms before plus everything after, resampled to 16 kHz", () => {
    const sink = new CaptureSink(48000);
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
    const sink = new CaptureSink(16000);
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
    const sink = new CaptureSink(16000);
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
    const sink = new CaptureSink(16000);
    feed(sink, 0, 8000);
    sink.clear();
    const c = collector();
    sink.begin(c.onBlock);
    sink.end();
    expect(c.samples.length).toBe(0);
  });
});
