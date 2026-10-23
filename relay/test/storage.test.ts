import { describe, expect, it } from "vitest";
import { randomBytes } from "@walkietalkey/protocol";
import { authAs, Client, createRoom, frameFrom, inRoom, joinPhone, paced, peerStatus, sleep, writesIn } from "./helpers.ts";

const DAY = 86_400_000;

async function dictation(sender: Uint8Array, recipient: Uint8Array) {
  const sessionId = randomBytes(16);
  const frames: Uint8Array[] = [];
  let c = 1n;
  frames.push(await frameFrom(sender, recipient, { type: "audio_start", sessionId, sampleRate: 16000, codec: "pcm16" }, c++));
  for (let i = 0; i < 75; i++) {
    frames.push(await frameFrom(sender, recipient, { type: "audio_chunk", sessionId, firstIndex: i, pcm: randomBytes(6400) }, c++));
  }
  frames.push(await frameFrom(sender, recipient, { type: "audio_end", sessionId, chunks: 75, durationMs: 15000 }, c++));
  return { frames, sessionId };
}

describe("storage writes per dictation (spec 8.3, 15.1)", () => {
  it("a live 15 s dictation writes at most one row (the daily last-seen)", async () => {
    const { owner, client: ownerClient } = await createRoom();
    const p = await joinPhone(owner, ownerClient);
    const joined = await ownerClient.control("member_joined");
    ownerClient.sendControl({ t: "event_ack", eid: joined.eid });
    p.client.close();
    await peerStatus(ownerClient, p.phoneId, false);
    // A new day: the phone connects for the dictation.
    await inRoom(owner.roomB64, (r) => {
      r.clockOffsetMs = DAY;
    });
    await inRoom(owner.roomB64, (r) => r.markAliveForTest(owner.id));
    const before = await writesIn(owner.roomB64);
    const phone = await authAs(owner.roomB64, owner.roomId, p.phone);
    const { frames, sessionId } = await dictation(p.phone.deviceId, owner.keys.deviceId);
    await paced(phone.client, frames);
    for (let i = 0; i < frames.length; i++) await ownerClient.binary();
    ownerClient.sendBinary(await frameFrom(owner.keys.deviceId, p.phone.deviceId, { type: "result", sessionId, ok: true }, 1n));
    await phone.client.binary();
    const written = (await writesIn(owner.roomB64)) - before;
    expect(written).toBeLessThanOrEqual(1);

    // The same day again: nothing at all.
    const before2 = await writesIn(owner.roomB64);
    const second = await dictation(p.phone.deviceId, owner.keys.deviceId);
    await paced(phone.client, second.frames);
    for (let i = 0; i < second.frames.length; i++) await ownerClient.binary();
    expect((await writesIn(owner.roomB64)) - before2).toBe(0);
  });

  it("a buffered 15 s dictation writes a handful of rows", async () => {
    const { owner, client: ownerClient } = await createRoom();
    const p = await joinPhone(owner, ownerClient);
    const joined = await ownerClient.control("member_joined");
    ownerClient.sendControl({ t: "event_ack", eid: joined.eid });
    await sleep(50);
    ownerClient.close();
    await peerStatus(p.client, owner.id, false);
    const before = await writesIn(owner.roomB64);
    const { frames } = await dictation(p.phone.deviceId, owner.keys.deviceId);
    await paced(p.client, frames);
    await sleep(100);
    const back = await authAs(owner.roomB64, owner.roomId, owner.keys);
    for (let i = 0; i < frames.length; i++) await back.client.binary();
    const written = (await writesIn(owner.roomB64)) - before;
    // 2 rows inserted, 2 deleted, at most 1 alarm.
    expect(written).toBeGreaterThan(0);
    expect(written).toBeLessThanOrEqual(6);
  });

  it("connecting to a random room and failing to join writes nothing", async () => {
    const { owner } = await createRoom();
    const before = await writesIn(owner.roomB64);
    const c = await Client.open(owner.roomB64, "join");
    await c.control("challenge");
    c.sendText("{}");
    await c.closed();
    expect((await writesIn(owner.roomB64)) - before).toBe(0);
  });
});

describe("socket attachments (RELAY-01)", () => {
  it("stay at or below 2,048 bytes, including the worst case", async () => {
    const { owner, client } = await createRoom();
    await joinPhone(owner, client);
    const pending = await Client.open(owner.roomB64, "join");
    await pending.control("challenge");
    const sizes = await inRoom(owner.roomB64, (r, st) => {
      const real = st.getWebSockets().map((ws) => JSON.stringify(ws.deserializeAttachment()).length);
      return { real, worst: r.worstCaseAttachmentSize() };
    });
    expect(sizes.real.length).toBe(3);
    for (const n of [...sizes.real, sizes.worst]) expect(n).toBeLessThanOrEqual(2048);
    expect(sizes.worst).toBeLessThan(400);
  });
});
