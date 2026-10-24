import { runDurableObjectAlarm } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { randomBytes } from "@walkietalkey/protocol";
import {
  addAdmission,
  Client,
  createRoom,
  frameFrom,
  inRoom,
  joinPhone,
  sleep,
  stub,
} from "./helpers.ts";

const DAY = 86_400_000;

describe("housekeeping with one alarm (RELAY-12)", () => {
  it("sets a single alarm at the earliest pending expiry", async () => {
    const { owner, client } = await createRoom();
    const afterCreate = await inRoom(owner.roomB64, (_r, st) =>
      st.storage.getAlarm(),
    );
    const today = Math.floor(Date.now() / DAY);
    // Owner expiry: 91 days after the day it was last seen.
    expect(afterCreate).toBe((today + 91) * DAY);
    await addAdmission(client);
    const withAdmission = await inRoom(owner.roomB64, (_r, st) =>
      st.storage.getAlarm(),
    );
    expect(withAdmission).toBeLessThanOrEqual(Date.now() + 600_000);
    expect(withAdmission).toBeGreaterThan(Date.now() + 590_000);
  });

  it("deletes expired admissions and buffers, then re-arms for the next expiry", async () => {
    const { owner, client } = await createRoom();
    const p = await joinPhone(owner, client);
    await addAdmission(client);
    client.close();
    await p.client.control("peer");
    const sessionId = randomBytes(16);
    p.client.sendBinary(
      await frameFrom(
        p.phone.deviceId,
        owner.keys.deviceId,
        { type: "audio_cancel", sessionId },
        1n,
      ),
    );
    await sleep(100);
    const before = await inRoom(owner.roomB64, (_r, st) => ({
      adm: [...st.storage.sql.exec("SELECT * FROM admissions")].length,
      buf: [...st.storage.sql.exec("SELECT id FROM buffered")].length,
    }));
    expect(before).toEqual({ adm: 1, buf: 1 });
    await inRoom(owner.roomB64, (r) => {
      r.clockOffsetMs = 11 * 60 * 1000;
    });
    expect(await runDurableObjectAlarm(stub(owner.roomB64))).toBe(true);
    const after = await inRoom(owner.roomB64, async (_r, st) => ({
      adm: [...st.storage.sql.exec("SELECT * FROM admissions")].length,
      buf: [...st.storage.sql.exec("SELECT id FROM buffered")].length,
      alarm: await st.storage.getAlarm(),
    }));
    expect(after.adm).toBe(0);
    expect(after.buf).toBe(0);
    const today = Math.floor(Date.now() / DAY);
    expect(after.alarm).toBe((today + 91) * DAY);
  });

  it("removes a phone not seen for 90 days and tells the owner", async () => {
    const { owner, client } = await createRoom();
    const p = await joinPhone(owner, client);
    const joined = await client.control("member_joined");
    client.sendControl({ t: "event_ack", eid: joined.eid });
    p.client.close();
    await client.control("peer");
    // The owner stays connected; 91 days pass.
    await inRoom(owner.roomB64, (r) => {
      r.clockOffsetMs = 91 * DAY;
    });
    await inRoom(owner.roomB64, (r) => r.markAliveForTest(owner.id));
    expect(await runDurableObjectAlarm(stub(owner.roomB64))).toBe(true);
    const left = await client.control("member_left");
    expect(left.id).toBe(p.phoneId);
    const devices = await inRoom(owner.roomB64, (_r, st) =>
      [...st.storage.sql.exec("SELECT device_id FROM devices")].map(
        (r) => r.device_id,
      ),
    );
    expect(devices).toEqual([owner.id]);
  });

  it("deletes the whole room when the owner has not been seen for 90 days", async () => {
    const { owner, client } = await createRoom();
    const p = await joinPhone(owner, client);
    client.close();
    await p.client.control("peer");
    p.client.close();
    await sleep(50);
    await inRoom(owner.roomB64, (r) => {
      r.clockOffsetMs = 92 * DAY;
    });
    expect(await runDurableObjectAlarm(stub(owner.roomB64))).toBe(true);
    const tables = await inRoom(
      owner.roomB64,
      (_r, st) =>
        [
          ...st.storage.sql.exec(
            "SELECT name FROM sqlite_master WHERE type = 'table'",
          ),
        ].length,
    );
    expect(tables).toBe(0);
    const again = await Client.open(owner.roomB64, "auth");
    expect((await again.closed()).code).toBe(4404);
  });

  it("a connected owner counts as seen when the alarm runs", async () => {
    const { owner, client } = await createRoom();
    await inRoom(owner.roomB64, (r) => {
      r.clockOffsetMs = 92 * DAY;
    });
    await inRoom(owner.roomB64, (r) => r.markAliveForTest(owner.id));
    expect(await runDurableObjectAlarm(stub(owner.roomB64))).toBe(true);
    expect(client.closeInfo).toBeNull();
    const day = await inRoom(
      owner.roomB64,
      (_r, st) =>
        [...st.storage.sql.exec("SELECT last_seen_day FROM devices")][0]!
          .last_seen_day,
    );
    expect(day).toBe(Math.floor((Date.now() + 92 * DAY) / DAY));
  });
});
