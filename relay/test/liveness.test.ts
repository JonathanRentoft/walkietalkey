import { describe, expect, it } from "vitest";
import { PING_MESSAGE, PONG_MESSAGE, bytesEqual } from "@walkietalkey/protocol";
import {
  authAs,
  createRoom,
  frameFrom,
  inRoom,
  joinPhone,
  sleep,
} from "./helpers.ts";

describe("liveness (RELAY-10)", () => {
  it("answers ping with pong automatically", async () => {
    const { client } = await createRoom();
    client.sendText(PING_MESSAGE);
    expect(await client.text()).toBe(PONG_MESSAGE);
  });

  it("treats a socket that has been quiet for over 75 s as offline: closes it, buffers, tells the others", async () => {
    const { owner, client: ownerClient } = await createRoom();
    const p = await joinPhone(owner, ownerClient);
    await ownerClient.control("member_joined");
    // The phone pings (fresh), the owner does not; then 80 s pass on the relay's clock.
    p.client.sendText(PING_MESSAGE);
    await p.client.take(
      (m) => m.kind === "text" && m.text === PONG_MESSAGE,
      "pong",
    );
    await inRoom(owner.roomB64, (r) => {
      r.clockOffsetMs = 80_000;
    });
    // Keep the phone fresh relative to the shifted clock.
    await inRoom(owner.roomB64, (r) => r.markAliveForTest(p.phoneId));
    const f = await frameFrom(
      p.phone.deviceId,
      owner.keys.deviceId,
      { type: "presence_query" },
      1n,
    );
    p.client.sendBinary(f);
    expect((await ownerClient.closed()).code).toBe(1001);
    expect(await p.client.control("peer")).toEqual({
      t: "peer",
      id: owner.id,
      online: false,
    });
    // The frame was buffered and arrives when the owner is back.
    const back = await authAs(owner.roomB64, owner.roomId, owner.keys);
    await back.client.control("member_joined");
    expect(bytesEqual(await back.client.binary(), f)).toBe(true);
  });

  it("a socket that pings stays online across the timeout", async () => {
    const { owner, client: ownerClient } = await createRoom();
    const p = await joinPhone(owner, ownerClient);
    await ownerClient.control("member_joined");
    await inRoom(owner.roomB64, (r) => {
      r.clockOffsetMs = 80_000;
    });
    // Pings answered after the clock shift count from the real time of the answer; shift the
    // clock back so the fresh pong is within 75 s.
    ownerClient.sendText(PING_MESSAGE);
    await ownerClient.take(
      (m) => m.kind === "text" && m.text === PONG_MESSAGE,
      "pong",
    );
    await inRoom(owner.roomB64, (r) => {
      r.clockOffsetMs = 1000;
    });
    const f = await frameFrom(
      p.phone.deviceId,
      owner.keys.deviceId,
      { type: "presence_query" },
      1n,
    );
    p.client.sendBinary(f);
    expect(bytesEqual(await ownerClient.binary(), f)).toBe(true);
    await sleep(10);
  });
});
