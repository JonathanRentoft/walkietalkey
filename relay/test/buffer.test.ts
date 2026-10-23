import { describe, expect, it } from "vitest";
import { bytesEqual, randomBytes } from "@walkietalkey/protocol";
import {
  authAs,
  createRoom,
  frameFrom,
  inRoom,
  joinPhone,
  peerStatus,
  sleep,
  unthrottle,
  until,
  writesIn,
} from "./helpers.ts";

async function dictationFrames(
  sender: Uint8Array,
  recipient: Uint8Array,
  chunks: number,
  start = 1n,
) {
  const sessionId = randomBytes(16);
  const frames: Uint8Array[] = [];
  let c = start;
  frames.push(
    await frameFrom(
      sender,
      recipient,
      { type: "audio_start", sessionId, sampleRate: 16000, codec: "pcm16" },
      c++,
    ),
  );
  for (let i = 0; i < chunks; i++) {
    frames.push(
      await frameFrom(
        sender,
        recipient,
        {
          type: "audio_chunk",
          sessionId,
          firstIndex: i,
          pcm: randomBytes(6400),
        },
        c++,
      ),
    );
  }
  frames.push(
    await frameFrom(
      sender,
      recipient,
      { type: "audio_end", sessionId, chunks, durationMs: chunks * 200 },
      c++,
    ),
  );
  return frames;
}

async function offlineOwnerRoom() {
  const { owner, client: ownerClient } = await createRoom();
  const p = await joinPhone(owner, ownerClient);
  await ownerClient.control("member_joined");
  ownerClient.close();
  await peerStatus(p.client, owner.id, false);
  await unthrottle(owner.roomB64);
  return { owner, p };
}

describe("buffering for an offline recipient (RELAY-08)", () => {
  it("batches a dictation into rows of at most 256 kB and delivers it in order", async () => {
    const { owner, p } = await offlineOwnerRoom();
    const frames = await dictationFrames(
      p.phone.deviceId,
      owner.keys.deviceId,
      75,
    );
    for (const f of frames) p.client.sendBinary(f);
    await until(
      owner.roomB64,
      (r, st) =>
        r.pendingBatchCount() === 0 &&
        [...st.storage.sql.exec("SELECT id FROM buffered")].length === 2,
    );
    const rows = await inRoom(owner.roomB64, (r, st) => ({
      rows: [
        ...st.storage.sql.exec(
          "SELECT length(frames) AS n FROM buffered ORDER BY id",
        ),
      ].map((x) => x.n as number),
      batches: r.pendingBatchCount(),
    }));
    // 77 frames of ~6.5 kB: one full row and the rest flushed by audio_end.
    expect(rows.batches).toBe(0);
    expect(rows.rows.length).toBe(2);
    for (const n of rows.rows) expect(n).toBeLessThanOrEqual(256 * 1024);

    const back = await authAs(owner.roomB64, owner.roomId, owner.keys);
    await back.client.control("member_joined");
    for (const f of frames)
      expect(bytesEqual(await back.client.binary(), f)).toBe(true);
    const left = await inRoom(
      owner.roomB64,
      (_r, st) => [...st.storage.sql.exec("SELECT id FROM buffered")].length,
    );
    expect(left).toBe(0);
  });

  it("delivers an unflushed in-memory batch without writing it", async () => {
    const { owner, p } = await offlineOwnerRoom();
    const sessionId = randomBytes(16);
    const f1 = await frameFrom(
      p.phone.deviceId,
      owner.keys.deviceId,
      { type: "audio_start", sessionId, sampleRate: 16000, codec: "pcm16" },
      1n,
    );
    p.client.sendBinary(f1);
    await sleep(50);
    const before = await writesIn(owner.roomB64);
    const back = await authAs(owner.roomB64, owner.roomId, owner.keys);
    await back.client.control("member_joined");
    expect(bytesEqual(await back.client.binary(), f1)).toBe(true);
    // Only the owner's daily last-seen could have been written by this auth (it was already today).
    expect((await writesIn(owner.roomB64)) - before).toBe(0);
  });

  it("flushes 2 s after the last frame", async () => {
    const { owner, p } = await offlineOwnerRoom();
    const sessionId = randomBytes(16);
    p.client.sendBinary(
      await frameFrom(
        p.phone.deviceId,
        owner.keys.deviceId,
        { type: "audio_start", sessionId, sampleRate: 16000, codec: "pcm16" },
        1n,
      ),
    );
    await sleep(300);
    const early = await inRoom(
      owner.roomB64,
      (_r, st) => [...st.storage.sql.exec("SELECT id FROM buffered")].length,
    );
    expect(early).toBe(0);
    await sleep(2200);
    const late = await inRoom(owner.roomB64, (r, st) => ({
      rows: [...st.storage.sql.exec("SELECT id FROM buffered")].length,
      batches: r.pendingBatchCount(),
    }));
    expect(late).toEqual({ rows: 1, batches: 0 });
  });

  it("flushes when the sender disconnects", async () => {
    const { owner, p } = await offlineOwnerRoom();
    const sessionId = randomBytes(16);
    p.client.sendBinary(
      await frameFrom(
        p.phone.deviceId,
        owner.keys.deviceId,
        { type: "audio_start", sessionId, sampleRate: 16000, codec: "pcm16" },
        1n,
      ),
    );
    await sleep(50);
    p.client.close();
    await sleep(200);
    const rows = await inRoom(
      owner.roomB64,
      (_r, st) => [...st.storage.sql.exec("SELECT id FROM buffered")].length,
    );
    expect(rows).toBe(1);
  });

  it("drops the oldest dictation above the room limit and tells the sender buffer_full", async () => {
    const { owner, p } = await offlineOwnerRoom();
    await inRoom(owner.roomB64, (r) => {
      r.bufferLimitBytes = 200 * 1024;
    });
    const first = await dictationFrames(
      p.phone.deviceId,
      owner.keys.deviceId,
      20,
      1n,
    );
    for (const f of first) p.client.sendBinary(f);
    await sleep(100);
    const second = await dictationFrames(
      p.phone.deviceId,
      owner.keys.deviceId,
      20,
      100n,
    );
    for (const f of second) p.client.sendBinary(f);
    const err = await p.client.control("error");
    expect(err.code).toBe("buffer_full");
    await sleep(100);
    const back = await authAs(owner.roomB64, owner.roomId, owner.keys);
    await back.client.control("member_joined");
    // Only the second dictation is left, complete and in order.
    for (const f of second)
      expect(bytesEqual(await back.client.binary(), f)).toBe(true);
    expect(await back.client.quiet(200)).toBe(true);
  });

  it("drops a dictation that spans several rows as a whole and tells the phone whose dictation it was", async () => {
    const { owner, client: ownerClient } = await createRoom();
    const a = await joinPhone(owner, ownerClient);
    await ownerClient.control("member_joined");
    const b = await joinPhone(owner, ownerClient);
    await ownerClient.control("member_joined");
    ownerClient.close();
    await peerStatus(a.client, owner.id, false);
    await peerStatus(b.client, owner.id, false);
    await unthrottle(owner.roomB64);
    await inRoom(owner.roomB64, (r) => {
      r.bufferLimitBytes = 380 * 1024;
    });
    // Phone A: 50 blocks, about 340 kB, so two rows (a full one and the rest with audio_end).
    const first = await dictationFrames(
      a.phone.deviceId,
      owner.keys.deviceId,
      50,
    );
    for (const f of first) a.client.sendBinary(f);
    await until(
      owner.roomB64,
      (r, st) =>
        r.pendingBatchCount() === 0 &&
        [...st.storage.sql.exec("SELECT id FROM buffered")].length === 2,
    );
    // Phone B: 10 blocks; with A's rows it would pass the limit.
    const second = await dictationFrames(
      b.phone.deviceId,
      owner.keys.deviceId,
      10,
    );
    for (const f of second) b.client.sendBinary(f);
    const err = await a.client.control("error");
    expect(err.code).toBe("buffer_full");
    await until(
      owner.roomB64,
      (r, st) =>
        r.pendingBatchCount() === 0 &&
        [...st.storage.sql.exec("SELECT id FROM buffered")].length === 1,
    );
    // B's dictation was not dropped, so B hears nothing.
    expect(
      b.client.queue.some((m) => m.kind === "text" && m.msg?.t === "error"),
    ).toBe(false);
    const back = await authAs(owner.roomB64, owner.roomId, owner.keys);
    // Nothing of A's dictation is left, not even its tail; B's arrives complete and in order.
    for (const f of second)
      expect(bytesEqual(await back.client.binary(), f)).toBe(true);
    expect(await back.client.quiet(200)).toBe(true);
  });

  it("keeps the 25 MB default limit", async () => {
    const { owner } = await createRoom();
    expect(await inRoom(owner.roomB64, (r) => r.bufferLimitBytes)).toBe(
      25 * 1024 * 1024,
    );
  });

  it("does not deliver frames older than 10 minutes", async () => {
    const { owner, p } = await offlineOwnerRoom();
    const frames = await dictationFrames(
      p.phone.deviceId,
      owner.keys.deviceId,
      2,
    );
    for (const f of frames) p.client.sendBinary(f);
    await sleep(100);
    await inRoom(owner.roomB64, (r) => {
      r.clockOffsetMs = 10 * 60 * 1000 + 1000;
    });
    const back = await authAs(owner.roomB64, owner.roomId, owner.keys);
    await back.client.control("member_joined");
    expect(await back.client.quiet(300)).toBe(true);
  });

  it("buffers owner → phone results for an offline phone", async () => {
    const { owner, client: ownerClient } = await createRoom();
    const p = await joinPhone(owner, ownerClient);
    await ownerClient.control("member_joined");
    p.client.close();
    await peerStatus(ownerClient, p.phoneId, false);
    const result = await frameFrom(
      owner.keys.deviceId,
      p.phone.deviceId,
      { type: "result", sessionId: randomBytes(16), ok: true },
      1n,
    );
    ownerClient.sendBinary(result);
    const back = await authAs(owner.roomB64, owner.roomId, p.phone);
    expect(bytesEqual(await back.client.binary(), result)).toBe(true);
  });
});
