/**
 * Where the microphone's samples go (PHONE-20, PHONE-21, PHONE-30, PHONE-33). Pure code; the
 * Recorder feeds it from the AudioWorklet.
 *
 * While the app is open and paired the microphone stays open ("warm"), so a dictation starts the
 * moment the button goes down instead of 50 to 90 ms later, and iOS's start-up delay no longer
 * eats the first syllable. Between dictations only the newest 300 ms are kept, in memory, and
 * overwritten all the time; at button-down they become the start of the dictation (the pre-roll),
 * followed by every sample after it. Nothing is ever written to disk, and nothing leaves the phone
 * unless a dictation is sent.
 *
 * The 300 ms are measured on the clock, not only by count: every batch carries the time it
 * arrived, and at button-down only what was captured in the last 300 ms is used. An audio
 * interruption that suspends the AudioContext without ending the track (Siri, a call, another
 * app's sound) stops the batches; without the time stamps the ring would still hold the audio from
 * before it, however old, and the next press would send it (review finding, run 2).
 */
import { PcmPipeline, type BlockSink } from "./pcm";

/** How much audio before the press a dictation starts with. */
export const PRE_ROLL_MS = 300;

/** One batch from the worklet, as far as the ring still holds it. */
interface Batch {
  /** When it arrived: the capture time of its newest sample, in ms. */
  at: number;
  /** How many of its samples the ring still holds (its newest ones). */
  n: number;
}

/** A ring buffer of the newest capture-rate samples, with the time each batch arrived. */
export class PreRoll {
  readonly capacity: number;
  readonly sampleRate: number;
  private readonly buf: Float32Array;
  /** Next write position. */
  private pos = 0;
  private filled = 0;
  /** The batches behind the kept samples, oldest first; their `n` add up to `filled`. */
  private batches: Batch[] = [];

  constructor(
    sampleRate: number,
    capacity = Math.ceil((sampleRate * PRE_ROLL_MS) / 1000),
  ) {
    this.sampleRate = sampleRate;
    this.capacity = capacity;
    this.buf = new Float32Array(capacity);
  }

  get length(): number {
    return this.filled;
  }

  /** Adds a batch that arrived at `at` (ms); its last sample was captured then. */
  push(samples: Float32Array, at = 0): void {
    const cap = this.capacity;
    if (samples.length === 0) return;
    let src = samples;
    if (src.length >= cap) {
      src = src.subarray(src.length - cap);
      this.buf.set(src, 0);
      this.pos = 0;
      this.filled = cap;
    } else {
      const first = Math.min(src.length, cap - this.pos);
      this.buf.set(src.subarray(0, first), this.pos);
      if (first < src.length) this.buf.set(src.subarray(first), 0);
      this.pos = (this.pos + src.length) % cap;
      this.filled = Math.min(cap, this.filled + src.length);
    }
    this.batches.push({ at, n: src.length });
    // Overwritten samples leave with the oldest batches.
    let extra = this.batches.reduce((sum, b) => sum + b.n, 0) - this.filled;
    while (extra > 0) {
      const oldest = this.batches[0];
      const d = Math.min(oldest.n, extra);
      oldest.n -= d;
      extra -= d;
      if (oldest.n === 0) this.batches.shift();
    }
  }

  /**
   * The kept samples, oldest first (a copy). With `now`, only those captured in the last
   * PRE_ROLL_MS before it (PHONE-33).
   */
  take(now?: number): Float32Array {
    let skip = 0;
    if (now !== undefined) {
      const cutoff = now - PRE_ROLL_MS;
      const ms = 1000 / this.sampleRate;
      for (const b of this.batches) {
        const oldest = b.at - (b.n - 1) * ms;
        if (oldest >= cutoff) break;
        if (b.at < cutoff) {
          skip += b.n;
          continue;
        }
        skip += Math.ceil((cutoff - oldest) / ms - 1e-9);
        break;
      }
    }
    const keep = this.filled - skip;
    const out = new Float32Array(keep);
    const start = (this.pos - keep + this.capacity) % this.capacity;
    const first = Math.min(keep, this.capacity - start);
    out.set(this.buf.subarray(start, start + first), 0);
    if (first < keep) out.set(this.buf.subarray(0, keep - first), first);
    return out;
  }

  clear(): void {
    this.buf.fill(0);
    this.pos = 0;
    this.filled = 0;
    this.batches = [];
  }
}

/**
 * Between dictations samples go into the pre-roll; during one, into a PcmPipeline that starts
 * with the pre-roll. begin() and push() run on the main thread, so no sample can fall between
 * the pre-roll and the live audio.
 */
export class CaptureSink {
  readonly sampleRate: number;
  private readonly preRoll: PreRoll;
  private readonly now: () => number;
  private pipeline: PcmPipeline | null = null;
  /** When the last batch arrived. */
  private lastAt: number | null = null;

  constructor(sampleRate: number, now: () => number = () => performance.now()) {
    this.sampleRate = sampleRate;
    this.now = now;
    this.preRoll = new PreRoll(sampleRate);
  }

  get recording(): boolean {
    return this.pipeline !== null;
  }

  /** A batch of capture-rate mono samples from the worklet. */
  push(samples: Float32Array): void {
    const at = this.now();
    const last = this.lastAt;
    this.lastAt = at;
    if (this.pipeline) {
      this.pipeline.push(samples);
      return;
    }
    // A batch that arrives more than 300 ms later than its own length after the one before
    // follows a pause in the audio (an interruption). Its first samples may be ones the worklet
    // held from before the pause, so it is left out, and so is everything older.
    const length = (samples.length * 1000) / this.sampleRate;
    if (last !== null && at - last > length + PRE_ROLL_MS) {
      this.preRoll.clear();
      return;
    }
    this.preRoll.push(samples, at);
  }

  /** Button down: a new dictation that starts with what was captured in the last 300 ms. */
  begin(onBlock: BlockSink): void {
    this.pipeline = new PcmPipeline(this.sampleRate, onBlock);
    const pre = this.preRoll.take(this.now());
    this.preRoll.clear();
    if (pre.length) this.pipeline.push(pre);
  }

  /** The dictation is over (after the worklet flushed): deliver the last, shorter block. */
  end(): void {
    const p = this.pipeline;
    this.pipeline = null;
    this.preRoll.clear();
    p?.finish();
  }

  /** Cancelled or failed: forget the dictation and the pre-roll. */
  drop(): void {
    this.pipeline = null;
    this.preRoll.clear();
  }

  /** The microphone closed, or the audio stopped (an interruption): forget the pre-roll. */
  clear(): void {
    this.preRoll.clear();
  }
}
