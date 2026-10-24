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
 */
import { PcmPipeline, type BlockSink } from "./pcm";

/** How much audio before the press a dictation starts with. */
export const PRE_ROLL_MS = 300;

/** A ring buffer of the newest capture-rate samples. */
export class PreRoll {
  readonly capacity: number;
  private readonly buf: Float32Array;
  /** Next write position. */
  private pos = 0;
  private filled = 0;

  constructor(
    sampleRate: number,
    capacity = Math.ceil((sampleRate * PRE_ROLL_MS) / 1000),
  ) {
    this.capacity = capacity;
    this.buf = new Float32Array(capacity);
  }

  get length(): number {
    return this.filled;
  }

  push(samples: Float32Array): void {
    const cap = this.capacity;
    let src = samples;
    if (src.length >= cap) {
      src = src.subarray(src.length - cap);
      this.buf.set(src, 0);
      this.pos = 0;
      this.filled = cap;
      return;
    }
    const first = Math.min(src.length, cap - this.pos);
    this.buf.set(src.subarray(0, first), this.pos);
    if (first < src.length) this.buf.set(src.subarray(first), 0);
    this.pos = (this.pos + src.length) % cap;
    this.filled = Math.min(cap, this.filled + src.length);
  }

  /** The kept samples, oldest first (a copy). */
  take(): Float32Array {
    const out = new Float32Array(this.filled);
    const start = (this.pos - this.filled + this.capacity) % this.capacity;
    const first = Math.min(this.filled, this.capacity - start);
    out.set(this.buf.subarray(start, start + first), 0);
    if (first < this.filled)
      out.set(this.buf.subarray(0, this.filled - first), first);
    return out;
  }

  clear(): void {
    this.buf.fill(0);
    this.pos = 0;
    this.filled = 0;
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
  private pipeline: PcmPipeline | null = null;

  constructor(sampleRate: number) {
    this.sampleRate = sampleRate;
    this.preRoll = new PreRoll(sampleRate);
  }

  get recording(): boolean {
    return this.pipeline !== null;
  }

  /** A batch of capture-rate mono samples from the worklet. */
  push(samples: Float32Array): void {
    if (this.pipeline) this.pipeline.push(samples);
    else this.preRoll.push(samples);
  }

  /** Button down: a new dictation that starts with the last 300 ms. */
  begin(onBlock: BlockSink): void {
    this.pipeline = new PcmPipeline(this.sampleRate, onBlock);
    const pre = this.preRoll.take();
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

  /** The microphone closed: forget the pre-roll. */
  clear(): void {
    this.preRoll.clear();
  }
}
