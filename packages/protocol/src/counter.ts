import { b64uEncode } from "./bytes.ts";
import { COUNTER_BLOCK } from "./constants.ts";
import { ProtocolError } from "./errors.ts";

/**
 * Persistence for frame counters (spec 9.4). Keys are opaque strings (see counterKey).
 * A missing value reads as 0n. `save*` must not resolve before the value is durable.
 */
export interface CounterStore {
  /** End of the last reserved send block, 0n if none. */
  loadSendReservation(key: string): Promise<bigint>;
  saveSendReservation(key: string, end: bigint): Promise<void>;
  /** Last accepted counter from a sender, 0n if none. */
  loadLastAccepted(key: string): Promise<bigint>;
  saveLastAccepted(key: string, value: bigint): Promise<void>;
}

/** `<sender b64u>><recipient b64u>`: counters are per (sender, recipient). */
export function counterKey(sender: Uint8Array, recipient: Uint8Array): string {
  return `${b64uEncode(sender)}>${b64uEncode(recipient)}`;
}

export class MemoryCounterStore implements CounterStore {
  readonly send = new Map<string, bigint>();
  readonly recv = new Map<string, bigint>();

  async loadSendReservation(key: string): Promise<bigint> {
    return this.send.get(key) ?? 0n;
  }
  async saveSendReservation(key: string, end: bigint): Promise<void> {
    this.send.set(key, end);
  }
  async loadLastAccepted(key: string): Promise<bigint> {
    return this.recv.get(key) ?? 0n;
  }
  async saveLastAccepted(key: string, value: bigint): Promise<void> {
    this.recv.set(key, value);
  }
}

/**
 * Hands out frame counters. Numbers are reserved in blocks: the block end is written before
 * any number of the block is used, and a restart begins a new block, so a crash can skip
 * numbers but never reuse one.
 */
export class SendCounter {
  private nextValue: bigint;
  private reservedEnd: bigint;
  private chain: Promise<unknown> = Promise.resolve();
  private readonly store: CounterStore;
  private readonly key: string;
  private readonly blockSize: bigint;

  private constructor(
    store: CounterStore,
    key: string,
    blockSize: bigint,
    storedEnd: bigint,
  ) {
    this.store = store;
    this.key = key;
    this.blockSize = blockSize;
    this.nextValue = storedEnd + 1n;
    // Nothing of the new block is reserved yet in this run.
    this.reservedEnd = storedEnd;
  }

  static async open(
    store: CounterStore,
    key: string,
    blockSize = COUNTER_BLOCK,
  ): Promise<SendCounter> {
    if (!Number.isInteger(blockSize) || blockSize < 1)
      throw new RangeError("blockSize");
    return new SendCounter(
      store,
      key,
      BigInt(blockSize),
      await store.loadSendReservation(key),
    );
  }

  /** The next counter; resolves only after its block is durable. Safe to call concurrently. */
  next(): Promise<bigint> {
    const result = this.chain.then(() => this.take());
    this.chain = result.catch(() => undefined);
    return result;
  }

  private async take(): Promise<bigint> {
    if (this.nextValue > this.reservedEnd) {
      const end = this.nextValue + this.blockSize - 1n;
      await this.store.saveSendReservation(this.key, end);
      this.reservedEnd = end;
    }
    return this.nextValue++;
  }
}

/** Rejects any counter not higher than the last accepted one from that sender, across restarts. */
export class ReplayGuard {
  private readonly store: CounterStore;
  private readonly key: string;
  private last: bigint;

  private constructor(store: CounterStore, key: string, last: bigint) {
    this.store = store;
    this.key = key;
    this.last = last;
  }

  static async open(store: CounterStore, key: string): Promise<ReplayGuard> {
    return new ReplayGuard(store, key, await store.loadLastAccepted(key));
  }

  get lastAccepted(): bigint {
    return this.last;
  }

  wouldAccept(counter: bigint): boolean {
    return counter > this.last;
  }

  /** Records an authenticated frame's counter. Throws ProtocolError("replay") if not higher. */
  async accept(counter: bigint): Promise<void> {
    if (!this.wouldAccept(counter))
      throw new ProtocolError("replay", `counter ${counter} <= ${this.last}`);
    this.last = counter;
    await this.store.saveLastAccepted(this.key, counter);
  }
}
