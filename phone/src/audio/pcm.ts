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
  for (let i = 0; i < samples.length; i++)
    view.setInt16(i * 2, samples[i]!, true);
  return out;
}

/** RMS of PCM16 samples as a fraction of full scale (0 silence, 1 a full-scale square wave). */
export function pcm16Rms(samples: Int16Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i]! / 32768;
    sum += v * v;
  }
  return Math.sqrt(sum / samples.length);
}

/** Below this the meter lies flat (room noise, a muted microphone). */
const METER_FLOOR_DB = -60;
/** At and above this the meter is full (loud speech close to the phone). */
const METER_TOP_DB = -12;

/** PHONE-21: a block's RMS on the level meter, 0 to 1 on a decibel scale. */
export function meterLevel(rms: number): number {
  if (!(rms > 0)) return 0;
  const db = 20 * Math.log10(rms);
  const l = (db - METER_FLOOR_DB) / (METER_TOP_DB - METER_FLOOR_DB);
  return Math.min(1, Math.max(0, l));
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
    if (!(inRate > 0) || !(outRate > 0))
      throw new RangeError("sample rates must be positive");
    if (outRate > inRate)
      throw new RangeError(
        `cannot upsample from ${inRate} Hz to ${outRate} Hz`,
      );
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
      const win =
        0.42 + 0.5 * Math.cos(Math.PI * x) + 0.08 * Math.cos(2 * Math.PI * x);
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
    const keepFrom = Math.max(
      0,
      Math.floor(this.nextOut * this.ratio) - this.half + 1,
    );
    if (keepFrom > this.bufStart) {
      this.buf = this.buf.slice(
        Math.min(this.buf.length, keepFrom - this.bufStart),
      );
      this.bufStart = keepFrom;
    }
    return Float32Array.from(out);
  }
}

/**
 * Run 4: the raw microphone (no voice processing, run 2) gives the owner's iPhone speech at about
 * -46 dBFS RMS, 17-18 dB below the Mac's microphone. Edda copes, but turned down that far the Mac's
 * own takes went from 9.2 % to 18.4 % WER, so the phone adds a fixed 15 dB.
 */
export const PHONE_GAIN_DB = 15;
/** The limiter's ceiling, -1 dBFS: no sample after the gain goes past it, so PCM16 never clips. */
export const LIMITER_CEILING = 10 ** (-1 / 20);
/** How far ahead the limiter looks: the gain is down before a peak arrives. Delays the audio this much. */
const LOOKAHEAD_MS = 5;
/** How quickly the gain comes back after a peak (time constant); slow enough to keep speech's shape. */
const RELEASE_MS = 120;

/**
 * A fixed gain with a look-ahead peak limiter, at 16 kHz. Each sample's allowed gain is the
 * smallest one any sample in the next 5 ms allows; the gain falls to it at once, comes back over
 * about 120 ms, and is then averaged over the look-ahead, so it glides down before a peak instead
 * of stepping. Every sample within 5 ms after a moment counts toward that moment's average, so
 * no sample ever goes past the ceiling. Samples are held back by the look-ahead (in order, none
 * added or dropped) and depend only on the input samples, never on how the input was chunked;
 * `flush` returns the rest.
 */
export class Limiter {
  private readonly gain: number;
  private readonly look: number;
  private readonly release: number;
  /** Gained samples not yet sent out, oldest first. */
  private pending: number[] = [];
  /** The released gain of the newest sample sent out. */
  private released = 1;
  /** The released gains of the last look + 1 samples sent out, and their sum. */
  private recent: number[] = [];
  private recentSum = 0;

  constructor(gainDb: number, rate = SAMPLE_RATE) {
    this.gain = 10 ** (gainDb / 20);
    this.look = Math.round((rate * LOOKAHEAD_MS) / 1000);
    this.release = 1 - Math.exp(-1000 / (RELEASE_MS * rate));
  }

  process(input: Float32Array): Float32Array {
    if (this.gain === 1) return input;
    for (let i = 0; i < input.length; i++)
      this.pending.push(input[i]! * this.gain);
    return this.drain(this.look);
  }

  /** The samples still held back by the look-ahead. */
  flush(): Float32Array {
    return this.gain === 1 ? new Float32Array(0) : this.drain(0);
  }

  private drain(keep: number): Float32Array {
    const out = new Float32Array(Math.max(0, this.pending.length - keep));
    for (let o = 0; o < out.length; o++) {
      let allowed = 1;
      const end = Math.min(this.pending.length, this.look + 1);
      for (let k = 0; k < end; k++) {
        const a = Math.abs(this.pending[k]!);
        if (a * allowed > LIMITER_CEILING) allowed = LIMITER_CEILING / a;
      }
      this.released = Math.min(
        allowed,
        this.released + (1 - this.released) * this.release,
      );
      this.recent.push(this.released);
      this.recentSum += this.released;
      if (this.recent.length > this.look + 1)
        this.recentSum -= this.recent.shift()!;
      out[o] = this.pending.shift()! * (this.recentSum / this.recent.length);
    }
    return out;
  }
}

/** A finished 200 ms block (PCM16 little-endian) and its RMS (pcm16Rms, for the level meter). */
export type BlockSink = (block: Uint8Array, rms: number) => void;

/** Cuts PCM16 into 200 ms blocks of exactly 3,200 samples; only the final flush may be shorter. */
export class BlockFramer {
  private cur = new Int16Array(BLOCK_SAMPLES);
  private n = 0;
  private count = 0;
  private readonly onBlock: BlockSink;

  constructor(onBlock: BlockSink) {
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
        this.onBlock(int16ToLeBytes(this.cur), pcm16Rms(this.cur));
        this.n = 0;
      }
    }
  }

  /** Emits the partial last block, if any samples are left. */
  flush(): void {
    if (this.n === 0) return;
    const last = this.cur.subarray(0, this.n);
    this.onBlock(int16ToLeBytes(last), pcm16Rms(last));
    this.n = 0;
  }
}

/**
 * Capture-rate float mono in, 200 ms PCM16 blocks out, each with its RMS: resampled to 16 kHz,
 * raised by `gainDb` (PHONE_GAIN_DB) under the limiter, then PCM16.
 */
export class PcmPipeline {
  private readonly ds: Downsampler;
  private readonly limiter: Limiter;
  private readonly framer: BlockFramer;

  constructor(inRate: number, onBlock: BlockSink, gainDb = PHONE_GAIN_DB) {
    this.ds = new Downsampler(inRate);
    this.limiter = new Limiter(gainDb);
    this.framer = new BlockFramer(onBlock);
  }

  push(input: Float32Array): void {
    const y = this.limiter.process(this.ds.process(input));
    if (y.length) this.framer.push(floatToPcm16(y));
  }

  finish(): void {
    for (const y of [
      this.limiter.process(this.ds.flush()),
      this.limiter.flush(),
    ])
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
