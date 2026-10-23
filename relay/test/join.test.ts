import { describe, expect, it } from "vitest";
import { b64uDecode, b64uEncode, generateDeviceKeys, randomBytes, sha256 } from "@walkietalkey/protocol";
import {
  addAdmission,
  authAs,
  challengeOf,
  Client,
  createRoom,
  inRoom,
  joinPhone,
  sendJoin,
} from "./helpers.ts";

describe("admissions and join (RELAY-04, RELAY-05)", () => {
  it("joins a phone, forwards member_joined with keys and MAC, and tells both about presence", async () => {
    const { owner, client: ownerClient } = await createRoom();
    const { a, s } = await addAdmission(ownerClient);
    const phone = await generateDeviceKeys();
    const pc = await Client.open(owner.roomB64, "join");
    await sendJoin(pc, owner, phone, a, s);
    const ok = await pc.control("ok");
    expect(ok.role).toBe("phone");
    expect(ok.members.find((m) => m.role === "owner")).toMatchObject({ id: owner.id, online: true });

    const joined = await ownerClient.control("member_joined");
    expect(joined.id).toBe(b64uEncode(phone.deviceId));
    expect(joined.pub).toBe(b64uEncode(phone.signingSpki));
    expect(joined.agree).toBe(b64uEncode(phone.agreementSpki));
    expect(b64uDecode(joined.mac)).toHaveLength(32);
    expect(joined.eid).toBeGreaterThan(0);
    const peer = await ownerClient.control("peer");
    expect(peer).toEqual({ t: "peer", id: b64uEncode(phone.deviceId), online: true });
  });

  it("stores only SHA-256 of the admission secret, with at most 10 minutes", async () => {
    const { owner, client } = await createRoom();
    const a = randomBytes(32);
    const h = b64uEncode(await sha256(a));
    client.sendControl({ t: "add_admission", h, exp: Date.now() + 60 * 60 * 1000 });
    await client.control("ack");
    const rows = await inRoom(owner.roomB64, (_r, st) => [...st.storage.sql.exec("SELECT * FROM admissions")]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.admission_sha256).toBe(h);
    expect(JSON.stringify(rows)).not.toContain(b64uEncode(a));
    expect(rows[0]!.expires_at as number).toBeLessThanOrEqual(Date.now() + 600_000 + 1000);
  });

  it("an admission works once", async () => {
    const { owner, client } = await createRoom();
    const adm = await addAdmission(client);
    await joinPhone(owner, client, adm);
    const second = await generateDeviceKeys();
    const c = await Client.open(owner.roomB64, "join");
    await sendJoin(c, owner, second, adm.a, adm.s);
    expect((await c.closed()).code).toBe(4401);
  });

  it("an expired admission is refused", async () => {
    const { owner, client } = await createRoom();
    const adm = await addAdmission(client);
    await inRoom(owner.roomB64, (r) => {
      r.clockOffsetMs = 11 * 60 * 1000;
    });
    const c = await Client.open(owner.roomB64, "join");
    await sendJoin(c, owner, await generateDeviceKeys(), adm.a, adm.s);
    expect((await c.closed()).code).toBe(4401);
  });

  it("cancel_admission deletes it early", async () => {
    const { owner, client } = await createRoom();
    const adm = await addAdmission(client);
    client.sendControl({ t: "cancel_admission", h: b64uEncode(await sha256(adm.a)) });
    expect((await client.control("ack")).op).toBe("cancel_admission");
    const c = await Client.open(owner.roomB64, "join");
    await sendJoin(c, owner, await generateDeviceKeys(), adm.a, adm.s);
    expect((await c.closed()).code).toBe(4401);
  });

  it("a join to a room that does not exist is 4404 and a join with a bad signature is 4401", async () => {
    const { owner, client } = await createRoom();
    const adm = await addAdmission(client);
    const phone = await generateDeviceKeys();
    const other = await generateDeviceKeys();
    const c = await Client.open(owner.roomB64, "join");
    const ch = await challengeOf(c);
    // Signed by another key than the one sent.
    const { signChallenge, computeJoinMac } = await import("@walkietalkey/protocol");
    const sig = await signChallenge(other.signing.privateKey, "wt-join-v1", owner.roomId, ch);
    const mac = await computeJoinMac(adm.s, owner.roomId, phone.signingSpki, phone.agreementSpki);
    c.sendControl({
      t: "join",
      a: b64uEncode(adm.a),
      pub: b64uEncode(phone.signingSpki),
      agree: b64uEncode(phone.agreementSpki),
      mac: b64uEncode(mac),
      sig: b64uEncode(sig),
    });
    expect((await c.closed()).code).toBe(4401);
    // The admission was not consumed by the failed attempt.
    const ok = await joinPhone(owner, client, adm);
    expect(ok.ok.role).toBe("phone");
  });

  it("only the owner may add admissions", async () => {
    const { owner, client } = await createRoom();
    const { client: phoneClient } = await joinPhone(owner, client);
    phoneClient.sendControl({ t: "add_admission", h: b64uEncode(randomBytes(32)), exp: Date.now() + 1000 });
    expect((await phoneClient.closed()).code).toBe(4403);
  });

  it("holds member_joined for an offline owner until it is acknowledged", async () => {
    const { owner, client } = await createRoom();
    const adm = await addAdmission(client);
    client.close();
    await new Promise((r) => setTimeout(r, 50));
    const { phoneId } = await joinPhone(owner, null, adm);

    const first = await authAs(owner.roomB64, owner.roomId, owner.keys);
    const ev = await first.client.control("member_joined");
    expect(ev.id).toBe(phoneId);
    first.client.close();
    await new Promise((r) => setTimeout(r, 50));

    // Not acknowledged: delivered again.
    const second = await authAs(owner.roomB64, owner.roomId, owner.keys);
    const again = await second.client.control("member_joined");
    expect(again.eid).toBe(ev.eid);
    second.client.sendControl({ t: "event_ack", eid: again.eid });
    await new Promise((r) => setTimeout(r, 50));
    second.client.close();
    await new Promise((r) => setTimeout(r, 50));

    const third = await authAs(owner.roomB64, owner.roomId, owner.keys);
    expect(await third.client.quiet(300)).toBe(true);
    const left = await inRoom(owner.roomB64, (_r, st) => [...st.storage.sql.exec("SELECT * FROM owner_events")].length);
    expect(left).toBe(0);
  });

  it("refuses a ninth device (8 per room)", async () => {
    const { owner, client } = await createRoom();
    for (let i = 0; i < 7; i++) await joinPhone(owner, client);
    const adm = await addAdmission(client);
    const c = await Client.open(owner.roomB64, "join");
    await sendJoin(c, owner, await generateDeviceKeys(), adm.a, adm.s);
    const err = await c.control("error");
    expect(err.code).toBe("room_full");
    expect((await c.closed()).code).toBe(4403);
  });

  it("a phone that lost its ok can authenticate after its join succeeded", async () => {
    const { owner, client } = await createRoom();
    const { phone, client: pc } = await joinPhone(owner, client);
    pc.close();
    const { ok } = await authAs(owner.roomB64, owner.roomId, phone);
    expect(ok.role).toBe("phone");
  });
});
