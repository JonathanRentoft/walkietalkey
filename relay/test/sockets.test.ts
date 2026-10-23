import { describe, expect, it } from "vitest";
import { Client, createRoom, inRoom, sleep } from "./helpers.ts";

/** Opens a socket that gets its challenge and never answers it. */
async function pending(roomB64: string): Promise<Client> {
  const c = await Client.open(roomB64, "auth");
  await c.control("challenge");
  return c;
}

async function shiftClock(roomB64: string, ms: number): Promise<void> {
  await inRoom(roomB64, (r) => {
    r.clockOffsetMs = ms;
  });
}

describe("unauthenticated sockets (RELAY-01, RELAY-11)", () => {
  it("a socket that has not authenticated within 30 s is closed when another socket connects", async () => {
    const { owner, client } = await createRoom();
    const idle = await pending(owner.roomB64);
    await shiftClock(owner.roomB64, 31_000);
    const next = await pending(owner.roomB64);
    expect((await idle.closed()).code).toBe(1001);
    // The new socket and the authenticated owner stay.
    await sleep(100);
    expect(next.closeInfo).toBeNull();
    expect(client.closeInfo).toBeNull();
  });

  it("is closed when a message arrives on another socket", async () => {
    const { owner, client } = await createRoom();
    const idle = await pending(owner.roomB64);
    await shiftClock(owner.roomB64, 31_000);
    // Reaches the object (only the exact ping is answered without waking it).
    client.sendControl({ t: "event_ack", eid: 999 });
    expect((await idle.closed()).code).toBe(1001);
    expect(client.closeInfo).toBeNull();
  });

  it("a socket younger than 30 s is left alone", async () => {
    const { owner } = await createRoom();
    const young = await pending(owner.roomB64);
    await shiftClock(owner.roomB64, 20_000);
    await pending(owner.roomB64);
    await sleep(200);
    expect(young.closeInfo).toBeNull();
  });

  it("caps the sockets per room at 32; a closed socket frees its place", async () => {
    const { owner, client } = await createRoom();
    const open: Client[] = [client];
    while (open.length < 32) open.push(await pending(owner.roomB64));
    const extra = await Client.open(owner.roomB64, "auth");
    expect((await extra.closed()).code).toBe(4429);
    expect(extra.queue.length).toBe(0);
    expect(open.every((c) => c.closeInfo === null)).toBe(true);

    open.pop()!.close();
    await sleep(200);
    const again = await pending(owner.roomB64);
    expect(again.closeInfo).toBeNull();
  });

  it("stale unauthenticated sockets are swept before the cap is checked", async () => {
    const { owner } = await createRoom();
    const idle: Client[] = [];
    while (idle.length < 31) idle.push(await pending(owner.roomB64));
    await shiftClock(owner.roomB64, 31_000);
    const next = await pending(owner.roomB64);
    expect(next.closeInfo).toBeNull();
    for (const c of idle) expect((await c.closed()).code).toBe(1001);
  });
});
