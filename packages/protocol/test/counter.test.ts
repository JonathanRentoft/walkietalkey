import { describe, expect, it } from "vitest";
import { COUNTER_BLOCK, MemoryCounterStore, ReplayGuard, SendCounter, type CounterStore } from "../src/index.ts";

class RecordingStore extends MemoryCounterStore {
  log: string[] = [];
  failNext = false;
  override async saveSendReservation(key: string, end: bigint): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("disk full");
    }
    this.log.push(`reserve ${key} ${end}`);
    await super.saveSendReservation(key, end);
  }
}

describe("send counters", () => {
  it("start at 1 and reserve blocks of 1,000 before use", async () => {
    const store = new RecordingStore();
    const c = await SendCounter.open(store, "a>b");
    expect(store.log).toEqual([]);
    expect(await c.next()).toBe(1n);
    expect(store.log).toEqual(["reserve a>b 1000"]);
    for (let i = 2; i <= COUNTER_BLOCK; i++) expect(await c.next()).toBe(BigInt(i));
    expect(store.log.length).toBe(1);
    expect(await c.next()).toBe(1001n);
    expect(store.log).toEqual(["reserve a>b 1000", "reserve a>b 2000"]);
  });

  it("start a new block after a restart and never reuse a number", async () => {
    const store = new RecordingStore();
    const first = await SendCounter.open(store, "k");
    await first.next();
    await first.next();
    const second = await SendCounter.open(store, "k");
    expect(await second.next()).toBe(1001n);
    const third = await SendCounter.open(store, "k");
    expect(await third.next()).toBe(2001n);
  });

  it("do not hand out a number when the reservation cannot be written", async () => {
    const store = new RecordingStore();
    const c = await SendCounter.open(store, "k");
    store.failNext = true;
    await expect(c.next()).rejects.toThrow("disk full");
    expect(await c.next()).toBe(1n);
  });

  it("are unique under concurrent use", async () => {
    const store = new MemoryCounterStore();
    const c = await SendCounter.open(store, "k", 10);
    const values = await Promise.all(Array.from({ length: 95 }, () => c.next()));
    expect(new Set(values.map(String)).size).toBe(95);
    expect(values.map(Number).sort((x, y) => x - y)).toEqual(Array.from({ length: 95 }, (_, i) => i + 1));
  });

  it("keep keys apart", async () => {
    const store: CounterStore = new MemoryCounterStore();
    const a = await SendCounter.open(store, "a");
    const b = await SendCounter.open(store, "b");
    expect(await a.next()).toBe(1n);
    expect(await b.next()).toBe(1n);
  });
});

describe("replay guard", () => {
  it("accepts only increasing counters and persists the last one", async () => {
    const store = new MemoryCounterStore();
    const g = await ReplayGuard.open(store, "p");
    expect(g.wouldAccept(0n)).toBe(false);
    expect(g.wouldAccept(1n)).toBe(true);
    await g.accept(5n);
    expect(g.wouldAccept(5n)).toBe(false);
    expect(g.wouldAccept(4n)).toBe(false);
    expect(g.wouldAccept(6n)).toBe(true);
    await expect(g.accept(3n)).rejects.toMatchObject({ code: "replay" });
    const again = await ReplayGuard.open(store, "p");
    expect(again.wouldAccept(5n)).toBe(false);
    expect(again.wouldAccept(1000n)).toBe(true);
  });
});
