/** Resend packing and pacing (PHONE-32): up to 10 blocks per frame, at most 25 frames per second. */
import { MAX_BLOCKS_PER_FRAME, MAX_RESEND_FRAMES_PER_SECOND, concatBytes } from "@walkietalkey/protocol";

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const realClock: Clock = {
  now: () => (typeof performance !== "undefined" ? performance.now() : Date.now()),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** Consecutive blocks from `from`, grouped by up to 10 (2 s of audio) per audio_chunk. */
export function packBlocks(blocks: readonly Uint8Array[], from = 0): { firstIndex: number; pcm: Uint8Array }[] {
  const out: { firstIndex: number; pcm: Uint8Array }[] = [];
  for (let i = from; i < blocks.length; i += MAX_BLOCKS_PER_FRAME) {
    out.push({ firstIndex: i, pcm: concatBytes(...blocks.slice(i, i + MAX_BLOCKS_PER_FRAME)) });
  }
  return out;
}

/**
 * Spaces frames at least 1000 / maxPerSecond ms apart, so no one-second window holds more than
 * maxPerSecond frames. One pacer per socket, shared by every resend on it.
 */
export class Pacer {
  private readonly gap: number;
  private readonly clock: Clock;
  private last = Number.NEGATIVE_INFINITY;
  private chain: Promise<void> = Promise.resolve();

  constructor(maxPerSecond = MAX_RESEND_FRAMES_PER_SECOND, clock: Clock = realClock) {
    this.gap = 1000 / maxPerSecond;
    this.clock = clock;
  }

  /** Resolves when the next frame may go out. Safe to call concurrently. */
  next(): Promise<void> {
    const p = this.chain.then(async () => {
      const wait = this.last + this.gap - this.clock.now();
      if (wait > 0) await this.clock.sleep(wait);
      this.last = Math.max(this.clock.now(), this.last + this.gap);
    });
    this.chain = p.catch(() => undefined);
    return p;
  }
}
