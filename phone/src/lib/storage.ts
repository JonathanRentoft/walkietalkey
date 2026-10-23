/**
 * Everything the phone keeps, in IndexedDB (PHONE-13): the device's key pairs and the pair keys
 * as non-extractable CryptoKeys (SEC-09), the rooms, the frame counters (spec 9.4) and settings.
 * Never audio (PHONE-33): recordings live in memory only.
 */
import {
  b64uDecode,
  counterKey,
  deviceKeysFromPairs,
  generateAgreementKeyPair,
  generateSigningKeyPair,
  type ComputerOs,
  type CounterStore,
  type DeviceKeys,
  type PairKeys,
} from "@walkietalkey/protocol";

export const STORE_NAMES = ["device", "rooms", "counters", "settings", "pendingLeaves"] as const;
const DB_VERSION = 1;

export interface RoomRecord {
  /** base64url room id, the key. */
  roomId: string;
  relayUrl: string;
  computerName: string;
  os: ComputerOs;
  /** base64url device id of the computer (the room's owner). */
  computerId: string;
  keys: PairKeys;
  /** The name this phone gave itself for this computer. */
  deviceName: string;
  pairedAt: number;
  lastUsedAt: number;
}

export interface Settings {
  mode: "hold" | "toggle";
  haptics: boolean;
  deviceName?: string;
  /** Room id of the computer picked last. */
  target?: string;
}

export interface PendingLeave {
  roomId: string;
  relayUrl: string;
}

const DEFAULT_SETTINGS: Settings = { mode: "hold", haptics: true };

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error("transaction aborted"));
    tx.onerror = () => reject(tx.error);
  });
}

export class PhoneStorage implements CounterStore {
  private readonly db: IDBDatabase;

  private constructor(db: IDBDatabase) {
    this.db = db;
  }

  static open(name = "walkietalkey"): Promise<PhoneStorage> {
    return new Promise((resolve, reject) => {
      const r = indexedDB.open(name, DB_VERSION);
      r.onupgradeneeded = () => {
        const db = r.result;
        for (const store of STORE_NAMES) {
          if (db.objectStoreNames.contains(store)) continue;
          if (store === "rooms" || store === "pendingLeaves") db.createObjectStore(store, { keyPath: "roomId" });
          else db.createObjectStore(store);
        }
      };
      r.onsuccess = () => resolve(new PhoneStorage(r.result));
      r.onerror = () => reject(r.error);
      r.onblocked = () => reject(new Error("IndexedDB is blocked by another tab"));
    });
  }

  close(): void {
    this.db.close();
  }

  storeNames(): string[] {
    return Array.from(this.db.objectStoreNames);
  }

  private async get<T>(store: string, key: IDBValidKey): Promise<T | undefined> {
    return (await req(this.db.transaction(store, "readonly").objectStore(store).get(key))) as T | undefined;
  }

  private async write(stores: string | string[], fn: (tx: IDBTransaction) => void, strict = false): Promise<void> {
    // "strict" asks the browser to flush to disk before completing (counter reservations).
    const tx = strict
      ? this.db.transaction(stores, "readwrite", { durability: "strict" } as IDBTransactionOptions)
      : this.db.transaction(stores, "readwrite");
    fn(tx);
    await done(tx);
  }

  /** The device's two key pairs, created on first use with non-extractable private keys. */
  async loadOrCreateDeviceKeys(): Promise<DeviceKeys> {
    const stored = await this.get<{ signing: CryptoKeyPair; agreement: CryptoKeyPair }>("device", "keys");
    if (stored) return deviceKeysFromPairs(stored.signing, stored.agreement);
    const signing = await generateSigningKeyPair(false);
    const agreement = await generateAgreementKeyPair(false);
    // Another tab may have created keys meanwhile: keep whichever was written first.
    const tx = this.db.transaction("device", "readwrite");
    const store = tx.objectStore("device");
    let result = { signing, agreement };
    const existing = store.get("keys");
    existing.onsuccess = () => {
      if (existing.result) result = existing.result as typeof result;
      else store.put({ signing, agreement }, "keys");
    };
    await done(tx);
    return deviceKeysFromPairs(result.signing, result.agreement);
  }

  async listRooms(): Promise<RoomRecord[]> {
    return (await req(this.db.transaction("rooms", "readonly").objectStore("rooms").getAll())) as RoomRecord[];
  }

  async putRoom(room: RoomRecord): Promise<void> {
    await this.write("rooms", (tx) => tx.objectStore("rooms").put(room));
  }

  async touchRoom(roomId: string, lastUsedAt: number): Promise<void> {
    const room = await this.get<RoomRecord>("rooms", roomId);
    if (room) await this.putRoom({ ...room, lastUsedAt });
  }

  /** Drops a room with its pair keys and the counters of that pair. */
  async deleteRoom(roomId: string): Promise<void> {
    const room = await this.get<RoomRecord>("rooms", roomId);
    const device = await this.get<{ signing: CryptoKeyPair; agreement: CryptoKeyPair }>("device", "keys");
    const counterKeys: string[] = [];
    if (room && device) {
      const self = (await deviceKeysFromPairs(device.signing, device.agreement)).deviceId;
      const peer = b64uDecode(room.computerId);
      counterKeys.push(counterKey(self, peer), counterKey(peer, self));
    }
    await this.write(["rooms", "counters"], (tx) => {
      tx.objectStore("rooms").delete(roomId);
      for (const k of counterKeys) {
        tx.objectStore("counters").delete(`send:${k}`);
        tx.objectStore("counters").delete(`recv:${k}`);
      }
    });
  }

  /** A new pairing derives new keys, so its counters start at 1 again (PROTOCOL.md 9). */
  async resetCounters(keys: string[]): Promise<void> {
    await this.write("counters", (tx) => {
      for (const k of keys) {
        tx.objectStore("counters").delete(`send:${k}`);
        tx.objectStore("counters").delete(`recv:${k}`);
      }
    });
  }

  async getSettings(): Promise<Settings> {
    return { ...DEFAULT_SETTINGS, ...((await this.get<Settings>("settings", "settings")) ?? {}) };
  }

  async putSettings(settings: Settings): Promise<void> {
    await this.write("settings", (tx) => tx.objectStore("settings").put(settings, "settings"));
  }

  async addPendingLeave(p: PendingLeave): Promise<void> {
    await this.write("pendingLeaves", (tx) => tx.objectStore("pendingLeaves").put(p));
  }

  async listPendingLeaves(): Promise<PendingLeave[]> {
    return (await req(this.db.transaction("pendingLeaves", "readonly").objectStore("pendingLeaves").getAll())) as PendingLeave[];
  }

  async deletePendingLeave(roomId: string): Promise<void> {
    await this.write("pendingLeaves", (tx) => tx.objectStore("pendingLeaves").delete(roomId));
  }

  // CounterStore (spec 9.4). Values are decimal strings, so no engine has to clone a BigInt.

  async loadSendReservation(key: string): Promise<bigint> {
    return BigInt((await this.get<string>("counters", `send:${key}`)) ?? "0");
  }

  async saveSendReservation(key: string, end: bigint): Promise<void> {
    await this.write("counters", (tx) => tx.objectStore("counters").put(end.toString(), `send:${key}`), true);
  }

  async loadLastAccepted(key: string): Promise<bigint> {
    return BigInt((await this.get<string>("counters", `recv:${key}`)) ?? "0");
  }

  async saveLastAccepted(key: string, value: bigint): Promise<void> {
    await this.write("counters", (tx) => tx.objectStore("counters").put(value.toString(), `recv:${key}`));
  }
}
