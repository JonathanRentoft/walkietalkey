import { describe, expect, it } from "vitest";
import { b64uDecode, bytesEqual, randomBytes } from "@walkietalkey/protocol";
import { createRoom, frameFrom, joinPhone, rawFrame } from "./helpers.ts";

async function roomWithPhones(n = 1) {
  const { owner, client: ownerClient } = await createRoom();
  const phones = [];
  for (let i = 0; i < n; i++) phones.push(await joinPhone(owner, ownerClient));
  // Drain member_joined/peer messages on the owner.
  for (let i = 0; i < n; i++) {
    await ownerClient.control("member_joined");
    await ownerClient.control("peer");
  }
  return { owner, ownerClient, phones };
}

describe("routing (RELAY-07)", () => {
  it("delivers phone → owner and owner → phone unchanged", async () => {
    const { owner, ownerClient, phones } = await roomWithPhones();
    const p = phones[0]!;
    const up = await frameFrom(p.phone.deviceId, owner.keys.deviceId, { type: "presence_query" }, 1n);
    p.client.sendBinary(up);
    expect(bytesEqual(await ownerClient.binary(), up)).toBe(true);
    const down = await frameFrom(owner.keys.deviceId, p.phone.deviceId, { type: "presence", secondsSinceInput: 3, locked: false }, 1n);
    ownerClient.sendBinary(down);
    expect(bytesEqual(await p.client.binary(), down)).toBe(true);
  });

  it("closes a socket that sends with another sender id (4403)", async () => {
    const { owner, phones } = await roomWithPhones();
    const p = phones[0]!;
    p.client.sendBinary(rawFrame(0x12, randomBytes(16), owner.keys.deviceId, 2));
    expect((await p.client.closed()).code).toBe(4403);
  });

  it("phones may only address the owner (4403)", async () => {
    const { phones } = await roomWithPhones(2);
    const [a, b] = phones;
    a!.client.sendBinary(rawFrame(0x12, a!.phone.deviceId, b!.phone.deviceId, 2));
    expect((await a!.client.closed()).code).toBe(4403);
  });

  it("the owner may not address itself (4403)", async () => {
    const { owner, ownerClient } = await roomWithPhones();
    ownerClient.sendBinary(rawFrame(0x30, owner.keys.deviceId, owner.keys.deviceId, 2));
    expect((await ownerClient.closed()).code).toBe(4403);
  });

  it("drops frames for non-members without closing", async () => {
    const { owner, ownerClient, phones } = await roomWithPhones();
    ownerClient.sendBinary(rawFrame(0x30, owner.keys.deviceId, randomBytes(16), 2));
    expect(await phones[0]!.client.quiet(200)).toBe(true);
    // The owner's socket still works.
    const down = await frameFrom(owner.keys.deviceId, phones[0]!.phone.deviceId, { type: "presence", secondsSinceInput: 1, locked: true }, 2n);
    ownerClient.sendBinary(down);
    expect(bytesEqual(await phones[0]!.client.binary(), down)).toBe(true);
  });

  it("closes malformed frames with 1008", async () => {
    const { phones } = await roomWithPhones();
    phones[0]!.client.sendBinary(new Uint8Array(20));
    expect((await phones[0]!.client.closed()).code).toBe(1008);
  });

  it("sends peer messages when members come and go (RELAY-10)", async () => {
    const { owner, ownerClient, phones } = await roomWithPhones();
    const p = phones[0]!;
    p.client.close();
    const off = await ownerClient.control("peer");
    expect(off).toEqual({ t: "peer", id: p.phoneId, online: false });
    ownerClient.close();
    // The phone hears about the owner going offline only if it is connected; reconnect it first.
    const { authAs } = await import("./helpers.ts");
    const again = await authAs(owner.roomB64, owner.roomId, p.phone);
    expect(again.ok.members.find((m) => m.role === "owner")?.online).toBe(false);
    const ownerBack = await authAs(owner.roomB64, owner.roomId, owner.keys);
    const on = await again.client.control("peer");
    expect(on).toEqual({ t: "peer", id: owner.id, online: true });
    expect(ownerBack.ok.members.find((m) => m.id === p.phoneId)?.online).toBe(true);
    expect(b64uDecode(owner.id)).toHaveLength(16);
  });
});
