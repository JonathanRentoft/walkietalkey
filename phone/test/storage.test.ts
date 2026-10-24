import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import {
  ReplayGuard,
  SendCounter,
  b64uEncode,
  counterKey,
  derivePairKeys,
  generateDeviceKeys,
  randomBytes,
} from "@walkietalkey/protocol";
import { PhoneStorage, STORE_NAMES, type RoomRecord } from "../src/lib/storage";

let n = 0;
let open: PhoneStorage[] = [];
const dbName = () => `wt-test-${++n}`;

async function openStorage(name: string): Promise<PhoneStorage> {
  const s = await PhoneStorage.open(name);
  open.push(s);
  return s;
}

afterEach(() => {
  for (const s of open) s.close();
  open = [];
});

async function room(
  storage: PhoneStorage,
  name = "MacBook",
): Promise<RoomRecord> {
  const device = await storage.loadOrCreateDeviceKeys();
  const computer = await generateDeviceKeys();
  const roomId = randomBytes(16);
  const keys = await derivePairKeys({
    agreementPrivateKey: device.agreement.privateKey,
    peerAgreementSpki: computer.agreementSpki,
    secret: randomBytes(32),
    roomId,
    computerId: computer.deviceId,
    phoneId: device.deviceId,
  });
  return {
    roomId: b64uEncode(roomId),
    relayUrl: "wss://relay.example.com",
    computerName: name,
    os: "mac",
    computerId: b64uEncode(computer.deviceId),
    keys,
    deviceName: "iPhone",
    pairedAt: 1,
    lastUsedAt: 1,
  };
}

describe("device keys (PHONE-13, SEC-09)", () => {
  it("creates the device's keys once and keeps them across restarts", async () => {
    const name = dbName();
    const a = await openStorage(name);
    const k1 = await a.loadOrCreateDeviceKeys();
    a.close();
    const b = await openStorage(name);
    const k2 = await b.loadOrCreateDeviceKeys();
    expect(k2.deviceId).toEqual(k1.deviceId);
    expect(k2.signingSpki).toEqual(k1.signingSpki);
  });

  it("stores the private keys as non-extractable CryptoKeys", async () => {
    const name = dbName();
    (await openStorage(name)).close();
    const s = await openStorage(name);
    const k = await s.loadOrCreateDeviceKeys();
    s.close();
    const reloaded = await (await openStorage(name)).loadOrCreateDeviceKeys();
    for (const key of [
      k.signing.privateKey,
      k.agreement.privateKey,
      reloaded.signing.privateKey,
      reloaded.agreement.privateKey,
    ]) {
      expect(key).toBeInstanceOf(CryptoKey);
      expect(key.extractable).toBe(false);
      await expect(crypto.subtle.exportKey("pkcs8", key)).rejects.toThrow();
    }
  });
});

describe("rooms and pair keys", () => {
  it("keeps several computers, one room each, with non-extractable pair keys", async () => {
    const name = dbName();
    const s = await openStorage(name);
    const r1 = await room(s, "MacBook");
    const r2 = await room(s, "ThinkPad");
    await s.putRoom(r1);
    await s.putRoom(r2);
    s.close();
    const t = await openStorage(name);
    const rooms = await t.listRooms();
    expect(rooms.map((r) => r.computerName).sort()).toEqual([
      "MacBook",
      "ThinkPad",
    ]);
    for (const r of rooms) {
      expect(r.keys.p2c.extractable).toBe(false);
      expect(r.keys.c2p.extractable).toBe(false);
      await expect(
        crypto.subtle.exportKey("raw", r.keys.p2c),
      ).rejects.toThrow();
    }
  });

  it("dropping a room deletes its keys and its counters (PHONE-14)", async () => {
    const s = await openStorage(dbName());
    const device = await s.loadOrCreateDeviceKeys();
    const r = await room(s);
    await s.putRoom(r);
    const computerId = new Uint8Array(Buffer.from(r.computerId, "base64url"));
    const sendKey = counterKey(device.deviceId, computerId);
    const recvKey = counterKey(computerId, device.deviceId);
    await s.saveSendReservation(sendKey, 1000n);
    await s.saveLastAccepted(recvKey, 7n);
    await s.deleteRoom(r.roomId);
    expect(await s.listRooms()).toEqual([]);
    expect(await s.loadSendReservation(sendKey)).toBe(0n);
    expect(await s.loadLastAccepted(recvKey)).toBe(0n);
  });
});

describe("frame counters (spec 9.4)", () => {
  it("reserves counters in blocks of 1,000 and starts a new block after a restart", async () => {
    const name = dbName();
    const s = await openStorage(name);
    const key = "phone>computer";
    const c = await SendCounter.open(s, key);
    expect(await c.next()).toBe(1n);
    expect(await s.loadSendReservation(key)).toBe(1000n);
    for (let i = 2; i <= 1000; i++) await c.next();
    expect(await s.loadSendReservation(key)).toBe(1000n);
    expect(await c.next()).toBe(1001n);
    expect(await s.loadSendReservation(key)).toBe(2000n);
    s.close();
    const t = await openStorage(name);
    const c2 = await SendCounter.open(t, key);
    expect(await c2.next()).toBe(2001n);
    expect(await t.loadSendReservation(key)).toBe(3000n);
  });

  it("persists the last accepted counter, so a replay is refused after a restart", async () => {
    const name = dbName();
    const s = await openStorage(name);
    const g = await ReplayGuard.open(s, "computer>phone");
    await g.accept(5n);
    s.close();
    const t = await openStorage(name);
    const g2 = await ReplayGuard.open(t, "computer>phone");
    expect(g2.wouldAccept(5n)).toBe(false);
    expect(g2.wouldAccept(6n)).toBe(true);
  });

  it("resetting a pair's counters (re-pairing) starts them at 1 again", async () => {
    const s = await openStorage(dbName());
    await s.saveSendReservation("a>b", 5000n);
    await s.saveLastAccepted("b>a", 42n);
    await s.resetCounters(["a>b", "b>a"]);
    expect(await s.loadSendReservation("a>b")).toBe(0n);
    expect(await s.loadLastAccepted("b>a")).toBe(0n);
  });
});

describe("the home-screen app's first launch (Phase 5)", () => {
  it("remembers the pairing links it has seen, so a start URL that keeps one pairs once", async () => {
    const s = await openStorage(dbName());
    expect(await s.hasSeenLink("abc")).toBe(false);
    await s.markLinkSeen("abc");
    expect(await s.hasSeenLink("abc")).toBe(true);
    // Only the newest 20 are kept.
    for (let i = 0; i < 20; i++) await s.markLinkSeen(`id${i}`);
    expect(await s.hasSeenLink("abc")).toBe(false);
    expect(await s.hasSeenLink("id19")).toBe(true);
    expect(await s.hasSeenLink("id0")).toBe(true);
    // Settings are untouched.
    expect(await s.getSettings()).toEqual({ haptics: true });
  });

  it("knows whether the app has run before", async () => {
    const s = await openStorage(dbName());
    expect(await s.firstRun()).toBe(true);
    expect(await s.firstRun()).toBe(false);
  });
});

describe("settings and pending leaves", () => {
  it("defaults to haptics on", async () => {
    const s = await openStorage(dbName());
    expect(await s.getSettings()).toEqual({ haptics: true });
    await s.putSettings({
      haptics: false,
      deviceName: "Jonathans iPhone",
      target: "x",
    });
    expect(await s.getSettings()).toEqual({
      haptics: false,
      deviceName: "Jonathans iPhone",
      target: "x",
    });
  });

  it("forgets the old hold-or-tap setting (PHONE-26: tap or hold is no longer a setting)", async () => {
    const s = await openStorage(dbName());
    await s.putSettings({ mode: "toggle", haptics: true } as never);
    expect(await s.getSettings()).toEqual({ haptics: true });
  });

  it("remembers a leave that could not be sent", async () => {
    const s = await openStorage(dbName());
    await s.addPendingLeave({ roomId: "r1", relayUrl: "wss://x" });
    expect(await s.listPendingLeaves()).toEqual([
      { roomId: "r1", relayUrl: "wss://x" },
    ]);
    await s.deletePendingLeave("r1");
    expect(await s.listPendingLeaves()).toEqual([]);
  });
});

describe("never audio on disk (PHONE-33)", () => {
  it("has no store for audio", async () => {
    const s = await openStorage(dbName());
    expect(s.storeNames().sort()).toEqual([...STORE_NAMES].sort());
    expect(STORE_NAMES).toEqual([
      "device",
      "rooms",
      "counters",
      "settings",
      "pendingLeaves",
    ]);
  });
});
