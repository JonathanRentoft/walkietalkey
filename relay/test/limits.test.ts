import { describe, expect, it } from "vitest";
import { b64uEncode, randomBytes } from "@walkietalkey/protocol";
import {
  Client,
  createRoom,
  frameFrom,
  inOneRateLimitWindow,
  joinPhone,
  newOwner,
  rawFrame,
} from "./helpers.ts";

describe("limits (RELAY-11)", () => {
  it("frames over 64 kB close with 4413", async () => {
    const { owner, client: ownerClient } = await createRoom();
    const p = await joinPhone(owner, ownerClient);
    p.client.sendBinary(
      rawFrame(0x21, p.phone.deviceId, owner.keys.deviceId, 65536 - 70 + 1),
    );
    expect((await p.client.closed()).code).toBe(4413);
  });

  it("a frame of exactly 65,536 bytes passes", async () => {
    const { owner, client: ownerClient } = await createRoom();
    const p = await joinPhone(owner, ownerClient);
    await ownerClient.control("member_joined");
    const f = rawFrame(0x21, p.phone.deviceId, owner.keys.deviceId, 65536 - 70);
    expect(f.length).toBe(65536);
    p.client.sendBinary(f);
    expect((await ownerClient.binary()).length).toBe(65536);
  });

  it("oversized control messages close with 4413", async () => {
    const { client } = await createRoom();
    client.sendText(
      JSON.stringify({ t: "event_ack", eid: 1, pad: "x".repeat(5000) }),
    );
    expect((await client.closed()).code).toBe(4413);
  });

  it("more than 50 frames per second on one socket close with 4429", async () => {
    const { owner, client: ownerClient } = await createRoom();
    const p = await joinPhone(owner, ownerClient);
    const f = await frameFrom(
      p.phone.deviceId,
      owner.keys.deviceId,
      { type: "presence_query" },
      1n,
    );
    for (let i = 0; i < 200; i++) p.client.sendBinary(f);
    expect((await p.client.closed()).code).toBe(4429);
  });

  it("25 frames per second (a PHONE-32 resend) is fine", async () => {
    const { owner, client: ownerClient } = await createRoom();
    const p = await joinPhone(owner, ownerClient);
    await ownerClient.control("member_joined");
    for (let i = 0; i < 50; i++) {
      p.client.sendBinary(
        await frameFrom(
          p.phone.deviceId,
          owner.keys.deviceId,
          { type: "presence_query" },
          BigInt(i + 1),
        ),
      );
      await new Promise((r) => setTimeout(r, 40));
    }
    for (let i = 0; i < 50; i++) await ownerClient.binary();
    expect(p.client.closeInfo).toBeNull();
  });

  it("per IP: the 11th create in a minute is refused in the Worker with 4429", async () => {
    const ip = "203.0.113.77";
    const owner = await newOwner();
    // All eleven creates are counted in one limiter window (see inOneRateLimitWindow).
    const eleventh = await inOneRateLimitWindow(async () => {
      for (let i = 0; i < 10; i++) {
        const ok = await Client.open(b64uEncode(randomBytes(16)), "create", ip);
        await ok.control("challenge");
        ok.close();
      }
      return Client.open(owner.roomB64, "create", ip);
    });
    expect((await eleventh.closed()).code).toBe(4429);
    // Another IP is not affected.
    const other = await Client.open(owner.roomB64, "create", "203.0.113.78");
    await other.control("challenge");
  });

  it("per IP: the 11th join in a minute is refused, auth is not limited", async () => {
    const ip = "203.0.113.90";
    const { owner } = await createRoom();
    // All eleven joins are counted in one limiter window (see inOneRateLimitWindow).
    const eleventh = await inOneRateLimitWindow(async () => {
      for (let i = 0; i < 10; i++) {
        const ok = await Client.open(owner.roomB64, "join", ip);
        await ok.control("challenge");
        ok.close();
      }
      return Client.open(owner.roomB64, "join", ip);
    });
    expect((await eleventh.closed()).code).toBe(4429);
    for (let i = 0; i < 12; i++) {
      const a = await Client.open(owner.roomB64, "auth", ip);
      await a.control("challenge");
      a.close();
    }
  });
});
