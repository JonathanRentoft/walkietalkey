import { SELF, env, runInDurableObject } from "cloudflare:test";
import {
  FrameType,
  b64uDecode,
  b64uEncode,
  computeJoinMac,
  computeRoomId,
  encodePayload,
  generateDeviceKeys,
  parseControlMessage,
  randomBytes,
  sealFrame,
  serializeControlMessage,
  sha256,
  signChallenge,
  type ControlMessage,
  type ControlOf,
  type ControlType,
  type DeviceKeys,
  type DevicePayload,
  type Intent,
} from "@walkietalkey/protocol";
import type { Room } from "../src/room.ts";

export type Message = { kind: "text"; text: string; msg?: ControlMessage } | { kind: "binary"; bytes: Uint8Array };

let ipCounter = 1;
/** A fresh IP per call so per-IP limits do not leak between tests. */
export function freshIp(): string {
  ipCounter++;
  return `2001:db8::${(ipCounter >> 16).toString(16)}:${(ipCounter & 0xffff).toString(16)}`;
}

export class Client {
  readonly queue: Message[] = [];
  private waiters: Array<() => void> = [];
  closeInfo: { code: number; reason: string } | null = null;
  private closeWaiters: Array<() => void> = [];

  private constructor(readonly ws: WebSocket) {
    ws.addEventListener("message", (e: MessageEvent) => {
      if (typeof e.data === "string") {
        let msg: ControlMessage | undefined;
        try {
          msg = parseControlMessage(e.data);
        } catch {
          msg = undefined;
        }
        this.queue.push({ kind: "text", text: e.data, msg });
      } else {
        this.queue.push({ kind: "binary", bytes: new Uint8Array(e.data as ArrayBuffer) });
      }
      this.wake();
    });
    ws.addEventListener("close", (e: CloseEvent) => {
      this.closeInfo = { code: e.code, reason: e.reason };
      this.wake();
      for (const w of this.closeWaiters.splice(0)) w();
    });
  }

  private wake() {
    for (const w of this.waiters.splice(0)) w();
  }

  static async open(roomB64: string, intent: Intent | string | null, ip = freshIp()): Promise<Client> {
    const q = intent === null ? "" : `?intent=${intent}`;
    const res = await SELF.fetch(`https://relay.test/v1/rooms/${roomB64}/ws${q}`, {
      headers: { Upgrade: "websocket", "CF-Connecting-IP": ip },
    });
    if (res.status !== 101 || !res.webSocket) throw new Error(`upgrade failed: ${res.status}`);
    res.webSocket.accept();
    // The standard default is "blob"; frames are compared as bytes.
    res.webSocket.binaryType = "arraybuffer";
    return new Client(res.webSocket);
  }

  /** Removes and returns the first queued message that matches, waiting for one. */
  async take(match: (m: Message) => boolean, what: string, timeoutMs = 3000): Promise<Message> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const i = this.queue.findIndex(match);
      if (i >= 0) return this.queue.splice(i, 1)[0]!;
      if (this.closeInfo) throw new Error(`socket closed (${this.closeInfo.code} ${this.closeInfo.reason}) waiting for ${what}`);
      const left = deadline - Date.now();
      if (left <= 0) {
        throw new Error(`timed out waiting for ${what}; queued: ${this.queue.map((m) => (m.kind === "text" ? m.text.slice(0, 60) : `<${m.bytes.length} bytes>`)).join(", ")}`);
      }
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, left);
        this.waiters.push(() => {
          clearTimeout(t);
          resolve();
        });
      });
    }
  }

  /** Next message of any kind. */
  async next(timeoutMs = 3000): Promise<Message> {
    return this.take(() => true, "any message", timeoutMs);
  }

  /** First queued control message of type `t` (others stay queued). */
  async control<T extends ControlType>(t: T, timeoutMs = 3000): Promise<ControlOf<T>> {
    const m = await this.take((x) => x.kind === "text" && x.msg?.t === t, t, timeoutMs);
    return (m as { msg: ControlMessage }).msg as ControlOf<T>;
  }

  /** First queued binary frame, in arrival order among binary frames. */
  async binary(timeoutMs = 3000): Promise<Uint8Array> {
    const m = await this.take((x) => x.kind === "binary", "a binary frame", timeoutMs);
    return (m as { bytes: Uint8Array }).bytes;
  }

  /** First queued text message, whatever it is. */
  async text(timeoutMs = 3000): Promise<string> {
    const m = await this.take((x) => x.kind === "text", "a text message", timeoutMs);
    return (m as { text: string }).text;
  }

  /** Resolves with the close code (and fails the test if the socket stays open). */
  async closed(timeoutMs = 3000): Promise<{ code: number; reason: string }> {
    if (!this.closeInfo) {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("socket did not close")), timeoutMs);
        this.closeWaiters.push(() => {
          clearTimeout(t);
          resolve();
        });
      });
    }
    return this.closeInfo!;
  }

  /** True if no message arrives within the time. */
  async quiet(ms = 300): Promise<boolean> {
    const before = this.queue.filter((m) => !(m.kind === "text" && m.msg?.t === "peer")).length;
    await new Promise((r) => setTimeout(r, ms));
    return this.queue.filter((m) => !(m.kind === "text" && m.msg?.t === "peer")).length === before;
  }

  sendControl(msg: ControlMessage): void {
    this.ws.send(serializeControlMessage(msg));
  }

  sendText(text: string): void {
    this.ws.send(text);
  }

  sendBinary(bytes: Uint8Array): void {
    this.ws.send(bytes);
  }

  close(code = 1000): void {
    try {
      this.ws.close(code, "bye");
    } catch {
      /* already closed */
    }
  }
}

export interface Owner {
  keys: DeviceKeys;
  salt: Uint8Array;
  roomId: Uint8Array;
  roomB64: string;
  id: string;
}

export async function newOwner(): Promise<Owner> {
  const keys = await generateDeviceKeys();
  const salt = randomBytes(16);
  const roomId = await computeRoomId(keys.signingSpki, salt);
  return { keys, salt, roomId, roomB64: b64uEncode(roomId), id: b64uEncode(keys.deviceId) };
}

export async function challengeOf(c: Client): Promise<Uint8Array> {
  const ch = await c.control("challenge");
  return b64uDecode(ch.n, 32);
}

export async function createRoom(owner?: Owner): Promise<{ owner: Owner; client: Client; ok: ControlOf<"ok"> }> {
  const o = owner ?? (await newOwner());
  const client = await Client.open(o.roomB64, "create");
  const challenge = await challengeOf(client);
  const sig = await signChallenge(o.keys.signing.privateKey, "wt-create-v1", o.roomId, challenge);
  client.sendControl({ t: "create", pub: b64uEncode(o.keys.signingSpki), salt: b64uEncode(o.salt), sig: b64uEncode(sig) });
  const ok = await client.control("ok");
  return { owner: o, client, ok };
}

export async function authAs(
  roomB64: string,
  roomId: Uint8Array,
  keys: DeviceKeys,
  ip?: string,
): Promise<{ client: Client; ok: ControlOf<"ok"> }> {
  const client = await Client.open(roomB64, "auth", ip);
  const challenge = await challengeOf(client);
  const sig = await signChallenge(keys.signing.privateKey, "wt-auth-v1", roomId, challenge);
  client.sendControl({ t: "auth", id: b64uEncode(keys.deviceId), sig: b64uEncode(sig) });
  const ok = await client.control("ok");
  return { client, ok };
}

export async function addAdmission(ownerClient: Client, ttlMs = 600_000): Promise<{ a: Uint8Array; s: Uint8Array }> {
  const a = randomBytes(32);
  const s = randomBytes(32);
  const h = b64uEncode(await sha256(a));
  ownerClient.sendControl({ t: "add_admission", h, exp: Date.now() + ttlMs });
  const ack = await ownerClient.control("ack");
  if (ack.op !== "add_admission" || ack.h !== h) throw new Error("bad ack");
  return { a, s };
}

export async function sendJoin(
  client: Client,
  owner: Owner,
  phone: DeviceKeys,
  a: Uint8Array,
  s: Uint8Array,
  challenge?: Uint8Array,
): Promise<void> {
  const ch = challenge ?? (await challengeOf(client));
  const sig = await signChallenge(phone.signing.privateKey, "wt-join-v1", owner.roomId, ch);
  const mac = await computeJoinMac(s, owner.roomId, phone.signingSpki, phone.agreementSpki);
  client.sendControl({
    t: "join",
    a: b64uEncode(a),
    pub: b64uEncode(phone.signingSpki),
    agree: b64uEncode(phone.agreementSpki),
    mac: b64uEncode(mac),
    sig: b64uEncode(sig),
  });
}

export async function joinPhone(
  owner: Owner,
  ownerClient: Client | null,
  admission?: { a: Uint8Array; s: Uint8Array },
): Promise<{ phone: DeviceKeys; client: Client; ok: ControlOf<"ok">; phoneId: string }> {
  const adm = admission ?? (await addAdmission(ownerClient!));
  const phone = await generateDeviceKeys();
  const client = await Client.open(owner.roomB64, "join");
  await sendJoin(client, owner, phone, adm.a, adm.s);
  const ok = await client.control("ok");
  return { phone, client, ok, phoneId: b64uEncode(phone.deviceId) };
}

/** A frame with a correct header; the payload key does not matter to the relay. */
export async function frameFrom(
  sender: Uint8Array,
  recipient: Uint8Array,
  payload: DevicePayload,
  counter: bigint,
  key?: CryptoKey,
): Promise<Uint8Array> {
  const k =
    key ??
    (await crypto.subtle.importKey("raw", new Uint8Array(32) as BufferSource, "AES-GCM", false, ["encrypt"]));
  const { frameType, bytes } = encodePayload(payload);
  return sealFrame(k, { type: frameType, sender, recipient, counter }, bytes);
}

export function rawFrame(type: number, sender: Uint8Array, recipient: Uint8Array, bodyLen: number): Uint8Array {
  const f = new Uint8Array(54 + bodyLen + 16);
  f[0] = 1;
  f[1] = type;
  f.set(sender, 2);
  f.set(recipient, 18);
  f[41] = 1;
  return f;
}

export const AUDIO = FrameType;

export function stub(roomB64: string): DurableObjectStub<Room> {
  return env.ROOMS.get(env.ROOMS.idFromName(roomB64)) as DurableObjectStub<Room>;
}

export async function inRoom<R>(roomB64: string, fn: (room: Room, state: DurableObjectState) => R | Promise<R>): Promise<R> {
  return runInDurableObject(stub(roomB64), fn);
}

export async function writesIn(roomB64: string): Promise<number> {
  return inRoom(roomB64, (room) => room.store.writes);
}

/** Lifts the per-socket rate limit so a test can send a whole dictation at once. */
export async function unthrottle(roomB64: string): Promise<void> {
  await inRoom(roomB64, (room) => {
    room.maxFramesPerSecond = 100_000;
  });
}

/** Polls a condition inside the room until it holds. */
export async function until(roomB64: string, cond: (room: Room, state: DurableObjectState) => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await inRoom(roomB64, cond))) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** Sends frames at a steady rate (25 per second is the PHONE-32 resend rate). */
export async function paced(client: Client, frames: Uint8Array[], perSecond = 25): Promise<void> {
  for (const f of frames) {
    client.sendBinary(f);
    await new Promise((r) => setTimeout(r, 1000 / perSecond));
  }
}

export async function peerStatus(client: Client, id: string, online: boolean): Promise<void> {
  await client.take((m) => m.kind === "text" && m.msg?.t === "peer" && m.msg.id === id && m.msg.online === online, `peer ${online}`);
}

export async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}
