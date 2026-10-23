/**
 * Capture-rate float audio to 16 kHz mono PCM16 in 200 ms blocks (PHONE-30).
 * Pure code: the AudioWorklet only batches samples; everything here is unit tested.
 */
import { BLOCK_SAMPLES, SAMPLE_RATE } from "@walkietalkey/protocol";

/** Float [-1, 1] to signed 16-bit, rounding, so that i / 32768 maps back to exactly i. */
export function floatToPcm16(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const v = Math.round(input[i]! * 32768);
    out[i] = v > 32767 ? 32767 : v < -32768 ? -32768 : v;
  }
  return out;
}

/** PCM16 little-endian bytes, as the wire format wants (PROTOCOL.md 8.2). */
export function int16ToLeBytes(samples: Int16Array): Uint8Array {
  const out = new Uint8Array(samples.length * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < samples.length; i++) view.setInt16(i * 2, samples[i]!, true);
  return out;
}

const KERNEL_RES = 256;

/**
 * Streaming band-limited resampler from the capture rate down to 16 kHz: a Blackman-windowed
 * sinc low-pass evaluated at each output instant (no phase delay), normalised to unit DC gain.
 * Outputs depend only on the input samples, never on how the input was chunked.
 */
export class Downsampler {
  readonly inRate: number;
  readonly outRate: number;
  readonly ratio: number;
  private readonly identity: boolean;
  private readonly half: number;
  private readonly table: Float32Array;
  private buf = new Float32Array(0);
  private bufStart = 0;
  private total = 0;
  private nextOut = 0;

  constructor(inRate: number, outRate = SAMPLE_RATE, halfTaps = 16) {
    if (!(inRate > 0) || !(outRate > 0)) throw new RangeError("sample rates must be positive");
    if (outRate > inRate) throw new RangeError(`cannot upsample from ${inRate} Hz to ${outRate} Hz`);
    this.inRate = inRate;
    this.outRate = outRate;
    this.ratio = inRate / outRate;
    this.identity = inRate === outRate;
    this.half = Math.ceil(halfTaps * this.ratio);
    // Cutoff at 85 % of the output Nyquist frequency, in cycles per input sample.
    const fc = (0.5 / this.ratio) * 0.85;
    const n = 2 * this.half * KERNEL_RES + 1;
    this.table = new Float32Array(n + 1);
    for (let i = 0; i < n; i++) {
      const d = i / KERNEL_RES - this.half;
      const x = d / this.half;
      const arg = 2 * fc * d;
      const sinc = arg === 0 ? 1 : Math.sin(Math.PI * arg) / (Math.PI * arg);
      const win = 0.42 + 0.5 * Math.cos(Math.PI * x) + 0.08 * Math.cos(2 * Math.PI * x);
      this.table[i] = Math.abs(x) >= 1 ? 0 : 2 * fc * sinc * win;
    }
  }

  /** Feeds input; returns every output sample that is now fully determined. */
  process(input: Float32Array): Float32Array {
    if (this.identity) {
      this.total += input.length;
      return input.slice();
    }
    const merged = new Float32Array(this.buf.length + input.length);
    merged.set(this.buf, 0);
    merged.set(input, this.buf.length);
    this.buf = merged;
    this.total += input.length;
    return this.drain(false);
  }

  /** End of stream: the remaining outputs, with silence after the last input sample. */
  flush(): Float32Array {
    if (this.identity) return new Float32Array(0);
    return this.drain(true);
  }

  private kernel(d: number): number {
    const pos = (d + this.half) * KERNEL_RES;
    if (pos <= 0 || pos >= this.table.length - 2) return 0;
    const i = Math.floor(pos);
    const f = pos - i;
    return this.table[i]! * (1 - f) + this.table[i + 1]! * f;
  }

  private drain(final: boolean): Float32Array {
    const out: number[] = [];
    for (;;) {
      const t = this.nextOut * this.ratio;
      // Output n exists when n * ratio < total input samples.
      if (t >= this.total) break;
      const center = Math.floor(t);
      const hi = center + this.half;
      if (!final && hi >= this.total) break;
      let acc = 0;
      let wsum = 0;
      for (let k = center - this.half + 1; k <= hi; k++) {
        const w = this.kernel(t - k);
        wsum += w;
        if (k >= 0 && k < this.total) acc += this.buf[k - this.bufStart]! * w;
      }
      out.push(wsum !== 0 ? acc / wsum : 0);
      this.nextOut++;
    }
    const keepFrom = Math.max(0, Math.floor(this.nextOut * this.ratio) - this.half + 1);
    if (keepFrom > this.bufStart) {
      this.buf = this.buf.slice(Math.min(this.buf.length, keepFrom - this.bufStart));
      this.bufStart = keepFrom;
    }
    return Float32Array.from(out);
  }
}

/** Cuts PCM16 into 200 ms blocks of exactly 3,200 samples; only the final flush may be shorter. */
export class BlockFramer {
  private cur = new Int16Array(BLOCK_SAMPLES);
  private n = 0;
  private count = 0;
  private readonly onBlock: (block: Uint8Array) => void;

  constructor(onBlock: (block: Uint8Array) => void) {
    this.onBlock = onBlock;
  }

  /** Total samples pushed. */
  get samples(): number {
    return this.count;
  }

  push(samples: Int16Array): void {
    let o = 0;
    this.count += samples.length;
    while (o < samples.length) {
      const take = Math.min(BLOCK_SAMPLES - this.n, samples.length - o);
      this.cur.set(samples.subarray(o, o + take), this.n);
      this.n += take;
      o += take;
      if (this.n === BLOCK_SAMPLES) {
        this.onBlock(int16ToLeBytes(this.cur));
        this.n = 0;
      }
    }
  }

  /** Emits the partial last block, if any samples are left. */
  flush(): void {
    if (this.n === 0) return;
    this.onBlock(int16ToLeBytes(this.cur.subarray(0, this.n)));
    this.n = 0;
  }
}

/** Capture-rate float mono in, 200 ms PCM16 blocks out. */
export class PcmPipeline {
  private readonly ds: Downsampler;
  private readonly framer: BlockFramer;

  constructor(inRate: number, onBlock: (block: Uint8Array) => void) {
    this.ds = new Downsampler(inRate);
    this.framer = new BlockFramer(onBlock);
  }

  push(input: Float32Array): void {
    const y = this.ds.process(input);
    if (y.length) this.framer.push(floatToPcm16(y));
  }

  finish(): void {
    const y = this.ds.flush();
    if (y.length) this.framer.push(floatToPcm16(y));
    this.framer.flush();
  }

  /** 16 kHz samples produced so far. */
  get samples(): number {
    return this.framer.samples;
  }

  /** durationMs as audio_end wants it: samples / 16. */
  get durationMs(): number {
    return Math.round(this.framer.samples / 16);
  }
}
