import { describe, expect, it } from "vitest";
import {
  b64uEncode,
  computeRoomId,
  generateDeviceKeys,
  randomBytes,
  signChallenge,
} from "@walkietalkey/protocol";
import { authAs, challengeOf, Client, createRoom, inRoom, newOwner, rawFrame } from "./helpers.ts";

describe("create (RELAY-03)", () => {
  it("creates a room bound to the owner's key and answers ok", async () => {
    const { owner, ok } = await createRoom();
    expect(ok.role).toBe("owner");
    expect(ok.members).toHaveLength(1);
    expect(ok.members[0]).toMatchObject({ id: owner.id, role: "owner", online: true });
    expect(ok.members[0]!.lastSeenDay).toBe(Math.floor(Date.now() / 86_400_000));
    const rows = await inRoom(owner.roomB64, (_r, s) => [...s.storage.sql.exec("SELECT * FROM room")]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.owner_device_id).toBe(owner.id);
    expect(rows[0]!.salt).toBe(b64uEncode(owner.salt));
  });

  it("refuses a room id that is not bound to the key and salt", async () => {
    const owner = await newOwner();
    const c = await Client.open(owner.roomB64, "create");
    const ch = await challengeOf(c);
    const sig = await signChallenge(owner.keys.signing.privateKey, "wt-create-v1", owner.roomId, ch);
    c.sendControl({ t: "create", pub: b64uEncode(owner.keys.signingSpki), salt: b64uEncode(randomBytes(16)), sig: b64uEncode(sig) });
    expect((await c.closed()).code).toBe(4401);
  });

  it("refuses someone else's key for a bound id", async () => {
    const owner = await newOwner();
    const thief = await generateDeviceKeys();
    const c = await Client.open(owner.roomB64, "create");
    const ch = await challengeOf(c);
    const sig = await signChallenge(thief.signing.privateKey, "wt-create-v1", owner.roomId, ch);
    c.sendControl({ t: "create", pub: b64uEncode(thief.signingSpki), salt: b64uEncode(owner.salt), sig: b64uEncode(sig) });
    expect((await c.closed()).code).toBe(4401);
  });

  it("refuses a signature with the wrong label", async () => {
    const owner = await newOwner();
    const c = await Client.open(owner.roomB64, "create");
    const ch = await challengeOf(c);
    const sig = await signChallenge(owner.keys.signing.privateKey, "wt-auth-v1", owner.roomId, ch);
    c.sendControl({ t: "create", pub: b64uEncode(owner.keys.signingSpki), salt: b64uEncode(owner.salt), sig: b64uEncode(sig) });
    expect((await c.closed()).code).toBe(4401);
  });

  it("an existing room cannot be created again (4409)", async () => {
    const { owner } = await createRoom();
    const again = await Client.open(owner.roomB64, "create");
    expect((await again.closed()).code).toBe(4409);
  });

  it("refuses a create message on a socket that declared another intent (4403)", async () => {
    const owner = await newOwner();
    // Room does not exist, so intent=auth closes 4404 at once; use join intent on a real room.
    const { owner: o2 } = await createRoom();
    const c = await Client.open(o2.roomB64, "auth");
    const ch = await challengeOf(c);
    const sig = await signChallenge(owner.keys.signing.privateKey, "wt-create-v1", o2.roomId, ch);
    c.sendControl({ t: "create", pub: b64uEncode(owner.keys.signingSpki), salt: b64uEncode(owner.salt), sig: b64uEncode(sig) });
    expect((await c.closed()).code).toBe(4403);
  });
});

describe("auth (RELAY-02)", () => {
  it("lets the owner back in and lists members", async () => {
    const { owner, client } = await createRoom();
    client.close();
    const { ok } = await authAs(owner.roomB64, owner.roomId, owner.keys);
    expect(ok.role).toBe("owner");
    expect(ok.members.map((m) => m.id)).toEqual([owner.id]);
  });

  it("closes unknown devices and bad signatures with 4401", async () => {
    const { owner } = await createRoom();
    const stranger = await generateDeviceKeys();
    const c1 = await Client.open(owner.roomB64, "auth");
    const ch1 = await challengeOf(c1);
    const sig1 = await signChallenge(stranger.signing.privateKey, "wt-auth-v1", owner.roomId, ch1);
    c1.sendControl({ t: "auth", id: b64uEncode(stranger.deviceId), sig: b64uEncode(sig1) });
    expect((await c1.closed()).code).toBe(4401);

    const c2 = await Client.open(owner.roomB64, "auth");
    const ch2 = await challengeOf(c2);
    const sig2 = await signChallenge(stranger.signing.privateKey, "wt-auth-v1", owner.roomId, ch2);
    c2.sendControl({ t: "auth", id: owner.id, sig: b64uEncode(sig2) });
    expect((await c2.closed()).code).toBe(4401);

    // A signature over an old challenge does not work on a new socket.
    const c3 = await Client.open(owner.roomB64, "auth");
    await challengeOf(c3);
    const old = await signChallenge(owner.keys.signing.privateKey, "wt-auth-v1", owner.roomId, ch1);
    c3.sendControl({ t: "auth", id: owner.id, sig: b64uEncode(old) });
    expect((await c3.closed()).code).toBe(4401);
  });

  it("refuses a create-label signature for auth", async () => {
    const { owner } = await createRoom();
    const c = await Client.open(owner.roomB64, "auth");
    const ch = await challengeOf(c);
    const sig = await signChallenge(owner.keys.signing.privateKey, "wt-create-v1", owner.roomId, ch);
    c.sendControl({ t: "auth", id: owner.id, sig: b64uEncode(sig) });
    expect((await c.closed()).code).toBe(4401);
  });

  it("closes frames and commands sent before authentication with 4401", async () => {
    const { owner } = await createRoom();
    const c1 = await Client.open(owner.roomB64, "auth");
    await challengeOf(c1);
    c1.sendBinary(rawFrame(0x21, owner.keys.deviceId, owner.keys.deviceId, 10));
    expect((await c1.closed()).code).toBe(4401);
    const c2 = await Client.open(owner.roomB64, "auth");
    await challengeOf(c2);
    c2.sendControl({ t: "delete_room" });
    expect((await c2.closed()).code).toBe(4401);
  });

  it("closes malformed control messages with 1008", async () => {
    const { owner } = await createRoom();
    const c = await Client.open(owner.roomB64, "auth");
    await challengeOf(c);
    c.sendText("{not json");
    expect((await c.closed()).code).toBe(1008);
  });

  it("a room id from another key never authenticates", async () => {
    const { owner } = await createRoom();
    const other = await generateDeviceKeys();
    const otherRoom = await computeRoomId(other.signingSpki, owner.salt);
    expect(b64uEncode(otherRoom)).not.toBe(owner.roomB64);
  });
});
