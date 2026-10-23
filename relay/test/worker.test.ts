import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { b64uEncode, randomBytes } from "@walkietalkey/protocol";
import { Client, inRoom } from "./helpers.ts";

describe("Worker endpoints", () => {
  it("GET /v1/health answers", async () => {
    const res = await SELF.fetch("https://relay.test/v1/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, protocol: 1 });
  });

  it("unknown paths are 404 and plain GET on the socket path is 426", async () => {
    expect((await SELF.fetch("https://relay.test/")).status).toBe(404);
    expect((await SELF.fetch("https://relay.test/v2/rooms/x/ws")).status).toBe(404);
    const room = b64uEncode(randomBytes(16));
    expect((await SELF.fetch(`https://relay.test/v1/rooms/${room}/ws`)).status).toBe(426);
  });

  it("an unknown intent is refused with 400", async () => {
    const room = b64uEncode(randomBytes(16));
    const res = await SELF.fetch(`https://relay.test/v1/rooms/${room}/ws?intent=admin`, {
      headers: { Upgrade: "websocket" },
    });
    expect(res.status).toBe(400);
  });

  it("a malformed room id closes with 4404 without touching a Durable Object", async () => {
    const c = await Client.open("not-a-room-id", "auth");
    expect((await c.closed()).code).toBe(4404);
  });

  it("an unknown room answers 4404 and writes nothing (RELAY-01)", async () => {
    const room = b64uEncode(randomBytes(16));
    const auth = await Client.open(room, "auth");
    expect((await auth.closed()).code).toBe(4404);
    const join = await Client.open(room, "join");
    expect((await join.closed()).code).toBe(4404);
    const noIntent = await Client.open(room, null);
    expect((await noIntent.closed()).code).toBe(4404);
    const { writes, tables } = await inRoom(room, (r, state) => ({
      writes: r.store.writes,
      tables: [...state.storage.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table'")].length,
    }));
    expect(writes).toBe(0);
    expect(tables).toBe(0);
  });
});
