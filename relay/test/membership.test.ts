import { describe, expect, it } from "vitest";
import {
  authAs,
  Client,
  challengeOf,
  createRoom,
  frameFrom,
  inRoom,
  joinPhone,
  sleep,
} from "./helpers.ts";
import { b64uEncode, signChallenge } from "@walkietalkey/protocol";

describe("leave, revoke and delete_room (RELAY-06)", () => {
  it("leave removes the phone and tells the owner with member_left", async () => {
    const { owner, client: ownerClient } = await createRoom();
    const p = await joinPhone(owner, ownerClient);
    await ownerClient.control("member_joined");
    p.client.sendControl({ t: "leave" });
    expect((await p.client.closed()).code).toBe(1000);
    const left = await ownerClient.control("member_left");
    expect(left.id).toBe(p.phoneId);
    ownerClient.sendControl({ t: "event_ack", eid: left.eid });

    const c = await Client.open(owner.roomB64, "auth");
    const ch = await challengeOf(c);
    const sig = await signChallenge(
      p.phone.signing.privateKey,
      "wt-auth-v1",
      owner.roomId,
      ch,
    );
    c.sendControl({ t: "auth", id: p.phoneId, sig: b64uEncode(sig) });
    expect((await c.closed()).code).toBe(4401);
  });

  it("member_left waits for an offline owner", async () => {
    const { owner, client: ownerClient } = await createRoom();
    const p = await joinPhone(owner, ownerClient);
    await ownerClient.control("member_joined");
    ownerClient.close();
    await sleep(50);
    p.client.sendControl({ t: "leave" });
    await p.client.closed();
    const back = await authAs(owner.roomB64, owner.roomId, owner.keys);
    // member_joined was never acknowledged, so it comes again first, then member_left.
    await back.client.control("member_joined");
    expect((await back.client.control("member_left")).id).toBe(p.phoneId);
  });

  it("only phones may leave", async () => {
    const { client } = await createRoom();
    client.sendControl({ t: "leave" });
    expect((await client.closed()).code).toBe(4403);
  });

  it("revoke closes the phone's sockets at once and keeps it out (4401)", async () => {
    const { owner, client: ownerClient } = await createRoom();
    const p = await joinPhone(owner, ownerClient);
    const second = await authAs(owner.roomB64, owner.roomId, p.phone);
    ownerClient.sendControl({ t: "revoke", id: p.phoneId });
    expect((await p.client.closed()).code).toBe(4401);
    expect((await second.client.closed()).code).toBe(4401);
    const ack = await ownerClient.control("ack");
    expect(ack).toEqual({ t: "ack", op: "revoke", id: p.phoneId });
    const c = await Client.open(owner.roomB64, "auth");
    const ch = await challengeOf(c);
    const sig = await signChallenge(
      p.phone.signing.privateKey,
      "wt-auth-v1",
      owner.roomId,
      ch,
    );
    c.sendControl({ t: "auth", id: p.phoneId, sig: b64uEncode(sig) });
    expect((await c.closed()).code).toBe(4401);
  });

  it("revoke drops frames buffered for that phone", async () => {
    const { owner, client: ownerClient } = await createRoom();
    const p = await joinPhone(owner, ownerClient);
    p.client.close();
    await sleep(50);
    const f = await frameFrom(
      owner.keys.deviceId,
      p.phone.deviceId,
      { type: "result", sessionId: new Uint8Array(16), ok: true },
      1n,
    );
    ownerClient.sendBinary(f);
    await sleep(50);
    ownerClient.sendControl({ t: "revoke", id: p.phoneId });
    await ownerClient.control("ack");
    const rows = await inRoom(owner.roomB64, (r, st) => ({
      rows: [...st.storage.sql.exec("SELECT id FROM buffered")].length,
      batches: r.pendingBatchCount(),
    }));
    expect(rows).toEqual({ rows: 0, batches: 0 });
  });

  it("only the owner may revoke", async () => {
    const { owner, client: ownerClient } = await createRoom();
    const p = await joinPhone(owner, ownerClient);
    p.client.sendControl({ t: "revoke", id: owner.id });
    expect((await p.client.closed()).code).toBe(4403);
  });

  it("delete_room removes everything; phones get 4404", async () => {
    const { owner, client: ownerClient } = await createRoom();
    const p = await joinPhone(owner, ownerClient);
    ownerClient.sendControl({ t: "delete_room" });
    expect((await p.client.closed()).code).toBe(4404);
    expect((await ownerClient.closed()).code).toBe(1000);
    const again = await Client.open(owner.roomB64, "auth");
    expect((await again.closed()).code).toBe(4404);
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
    // The same id can be created again by its owner.
    const re = await createRoom(owner);
    expect(re.ok.role).toBe("owner");
  });
});
