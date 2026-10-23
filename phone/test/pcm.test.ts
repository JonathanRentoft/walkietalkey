import { describe, expect, it } from "vitest";
import { BLOCK_BYTES, BLOCK_SAMPLES } from "@walkietalkey/protocol";
import {
  BlockFramer,
  Downsampler,
  PcmPipeline,
  floatToPcm16,
  int16ToLeBytes,
  meterLevel,
  pcm16Rms,
} from "../src/audio/pcm";

/** Splits `total` into pseudo-random chunk sizes, the way an AudioWorklet batches arrive. */
function chunks(total: number, seed = 1): number[] {
  const out: number[] = [];
  let left = total;
  let x = seed;
  while (left > 0) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    const n = Math.min(left, 1 + (x % 3000));
    out.push(n);
    left -= n;
  }
  return out;
}

function sine(
  freq: number,
  rate: number,
  samples: number,
  amp = 0.5,
): Float32Array {
  const out = new Float32Array(samples);
  for (let i = 0; i < samples; i++)
    out[i] = amp * Math.sin((2 * Math.PI * freq * i) / rate);
  return out;
}

function rms(x: ArrayLike<number>, from = 0, to = x.length): number {
  let s = 0;
  for (let i = from; i < to; i++) s += x[i]! * x[i]!;
  return Math.sqrt(s / Math.max(1, to - from));
}

function runChunked(
  ds: Downsampler,
  input: Float32Array,
  seed: number,
): Float32Array {
  const parts: Float32Array[] = [];
  let o = 0;
  for (const n of chunks(input.length, seed)) {
    parts.push(ds.process(input.subarray(o, o + n)));
    o += n;
  }
  parts.push(ds.flush());
  const total = parts.reduce((a, p) => a + p.length, 0);
  const out = new Float32Array(total);
  let w = 0;
  for (const p of parts) {
    out.set(p, w);
    w += p.length;
  }
  return out;
}

describe("PCM16 conversion (PHONE-30)", () => {
  it("round-trips every 16-bit value exactly and clamps out-of-range input", () => {
    const all = new Float32Array(65536);
    for (let i = 0; i < 65536; i++) all[i] = (i - 32768) / 32768;
    const back = floatToPcm16(all);
    for (let i = 0; i < 65536; i++) expect(back[i]).toBe(i - 32768);
    expect(
      Array.from(floatToPcm16(Float32Array.from([1.5, -1.5, 1, -1, 0]))),
    ).toEqual([32767, -32768, 32767, -32768, 0]);
  });

  it("writes little-endian bytes", () => {
    const bytes = int16ToLeBytes(Int16Array.from([0x0102, -2]));
    expect(Array.from(bytes)).toEqual([0x02, 0x01, 0xfe, 0xff]);
  });
});

describe("200 ms framing", () => {
  it("emits exactly 3,200 samples (6,400 bytes) per block, whatever the input chunking", () => {
    const blocks: Uint8Array[] = [];
    const framer = new BlockFramer((b) => blocks.push(b));
    const total = 16000 * 3; // 3 s
    let v = 0;
    for (const n of chunks(total, 7)) {
      const s = new Int16Array(n);
      for (let i = 0; i < n; i++) s[i] = v++ % 30000;
      framer.push(s);
    }
    framer.flush();
    expect(blocks.length).toBe(15);
    for (const b of blocks) expect(b.length).toBe(BLOCK_BYTES);
    expect(BLOCK_BYTES).toBe(BLOCK_SAMPLES * 2);
    // Samples stay in order across block boundaries.
    const view = new DataView(blocks[1]!.buffer, blocks[1]!.byteOffset);
    expect(view.getInt16(0, true)).toBe(3200);
  });

  it("makes only the last block shorter, and never an empty one", () => {
    const blocks: Uint8Array[] = [];
    const framer = new BlockFramer((b) => blocks.push(b));
    framer.push(new Int16Array(7000));
    expect(blocks.length).toBe(2);
    framer.flush();
    expect(blocks.map((b) => b.length)).toEqual([6400, 6400, 1200]);
    framer.flush();
    expect(blocks.length).toBe(3);
    expect(framer.samples).toBe(7000);
  });
});

describe("downsampling to 16 kHz mono", () => {
  it("passes 16 kHz through unchanged", () => {
    const ds = new Downsampler(16000);
    const x = sine(440, 16000, 5000);
    const y = runChunked(ds, x, 3);
    expect(y).toEqual(x);
  });

  it("produces exactly one output per three input samples at 48 kHz, independent of chunking", () => {
    const x = sine(1000, 48000, 48000);
    const a = runChunked(new Downsampler(48000), x, 1);
    const b = runChunked(new Downsampler(48000), x, 99);
    expect(a.length).toBe(16000);
    expect(b).toEqual(a);
  });

  it("produces 16,000 samples per second from 44.1 kHz", () => {
    const y = runChunked(
      new Downsampler(44100),
      sine(500, 44100, 44100 * 2),
      5,
    );
    expect(y.length).toBe(32000);
  });

  it("keeps speech-band tones with the right frequency and level", () => {
    const y = runChunked(new Downsampler(48000), sine(1000, 48000, 48000), 2);
    const ref = sine(1000, 16000, 16000);
    let err = 0;
    for (let i = 200; i < 15800; i++) err += (y[i]! - ref[i]!) ** 2;
    expect(Math.sqrt(err / 15600)).toBeLessThan(0.01);
    expect(rms(y, 200, 15800)).toBeCloseTo(0.5 / Math.SQRT2, 2);
  });

  it("filters out what would alias (tones above 8 kHz)", () => {
    const y = runChunked(new Downsampler(48000), sine(11000, 48000, 48000), 4);
    expect(rms(y, 200, 15800)).toBeLessThan(0.02);
    const z = runChunked(new Downsampler(44100), sine(12000, 44100, 44100), 4);
    expect(rms(z, 200, z.length - 200)).toBeLessThan(0.02);
  });

  it("refuses to upsample", () => {
    expect(() => new Downsampler(8000)).toThrow(RangeError);
  });
});

describe("PcmPipeline (capture rate to 200 ms PCM16 blocks)", () => {
  it("turns 2.1 s at 48 kHz into ten full blocks and a 100 ms last block", () => {
    const blocks: Uint8Array[] = [];
    const p = new PcmPipeline(48000, (b) => blocks.push(b));
    const x = sine(300, 48000, 48000 * 2.1);
    let o = 0;
    for (const n of chunks(x.length, 11)) {
      p.push(x.subarray(o, o + n));
      o += n;
    }
    expect(blocks.length).toBe(10);
    p.finish();
    expect(blocks.length).toBe(11);
    expect(blocks.slice(0, 10).every((b) => b.length === 6400)).toBe(true);
    expect(blocks[10]!.length).toBe(3200);
    expect(p.samples).toBe(33600);
    expect(p.durationMs).toBe(2100);
  });

  it("is bit-exact at 16 kHz for 16-bit input", () => {
    const pcm = new Int16Array(16000);
    for (let i = 0; i < pcm.length; i++) pcm[i] = ((i * 7919) % 65536) - 32768;
    const f = new Float32Array(pcm.length);
    for (let i = 0; i < pcm.length; i++) f[i] = pcm[i]! / 32768;
    const blocks: Uint8Array[] = [];
    const p = new PcmPipeline(16000, (b) => blocks.push(b));
    p.push(f);
    p.finish();
    const joined = new Uint8Array(blocks.reduce((a, b) => a + b.length, 0));
    let w = 0;
    for (const b of blocks) {
      joined.set(b, w);
      w += b.length;
    }
    expect(joined).toEqual(int16ToLeBytes(pcm));
  });
});

describe("the microphone level (PHONE-21)", () => {
  it("is the RMS of each 200 ms block, 0 to 1 of full scale", () => {
    expect(pcm16Rms(new Int16Array(BLOCK_SAMPLES))).toBe(0);
    const square = new Int16Array(BLOCK_SAMPLES);
    for (let i = 0; i < square.length; i++) square[i] = i % 2 ? 16384 : -16384;
    expect(pcm16Rms(square)).toBeCloseTo(0.5, 6);
    const full = new Int16Array(BLOCK_SAMPLES).fill(-32768);
    expect(pcm16Rms(full)).toBe(1);
  });

  it("comes with every block from the pipeline: silence, then a tone", () => {
    const levels: number[] = [];
    const p = new PcmPipeline(48000, (_b, level) => levels.push(level));
    p.push(new Float32Array(48000 * 0.4));
    p.push(sine(440, 48000, 48000 * 0.4, 0.5));
    p.finish();
    expect(levels.length).toBe(4);
    expect(levels[0]).toBe(0);
    // A sine of amplitude 0.5 has an RMS of 0.5 / sqrt(2).
    expect(levels[3]!).toBeCloseTo(0.5 / Math.SQRT2, 2);
  });

  it("maps to the meter on a decibel scale: -60 dBFS and below is flat, -12 dBFS is full", () => {
    const db = (d: number) => 10 ** (d / 20);
    expect(meterLevel(0)).toBe(0);
    expect(meterLevel(db(-80))).toBe(0);
    expect(meterLevel(db(-60))).toBeCloseTo(0, 6);
    expect(meterLevel(db(-36))).toBeCloseTo(0.5, 6);
    expect(meterLevel(db(-12))).toBeCloseTo(1, 6);
    expect(meterLevel(1)).toBe(1);
    expect(meterLevel(Number.NaN)).toBe(0);
  });
});
