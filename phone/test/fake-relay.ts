/**
 * An in-memory relay with one scripted computer per room, for controller tests. Sockets answer
 * the challenge, `auth`, the exact ping and the computer's side of device frames (presence,
 * results) after a small delay, like the real relay on a fast network. Tests can drop a socket
 * (the browser notices) or freeze it (it looks open but nothing comes back, a socket that died
 * while the app was in the background), and make a computer deaf (its socket at the relay
 * still counts as live, but frames are lost: a laptop that just went to sleep).
 */
import {
  MemoryCounterStore,
  PING_MESSAGE,
  PONG_MESSAGE,
  PairChannel,
  b64uEncode,
  derivePairKeys,
  generateDeviceKeys,
  parseControlMessage,
  randomBytes,
  serializeControlMessage,
  type ControlMessage,
  type DeviceKeys,
  type DevicePayload,
  type PairKeys,
} from "@walkietalkey/protocol";
import type { WebSocketCtor } from "../src/core/link";
import type { PhoneStorage, RoomRecord } from "../src/lib/storage";

export interface ComputerSession {
  starts: number;
  blocks: Set<number>;
  end: number | null;
  answered: number;
}

export class FakeComputer {
  readonly roomId = randomBytes(16);
  readonly roomB64 = b64uEncode(this.roomId);
  readonly sockets: FakeSocket[] = [];
  readonly sessions = new Map<string, ComputerSession>();
  /** The relay counts the computer as online (sent in `ok` and `peer`). */
  online = true;
  /** Frames for the computer are lost (its socket at the relay still looks live). */
  deaf = false;
  /** Answer to presence_query; null = no answer. */
  presence: { secondsSinceInput: number; locked: boolean } | null = null;
  /** Answer finished sessions with ok. */
  answer = true;
  /** presence_query frames received. */
  presenceQueries = 0;
  private channel!: PairChannel;
  private recv: Promise<unknown> = Promise.resolve();

  private constructor(
    readonly name: string,
    readonly keys: DeviceKeys,
  ) {}

  static async pairedWith(
    storage: PhoneStorage,
    name: string,
    lastUsedAt: number,
  ): Promise<FakeComputer> {
    const device = await storage.loadOrCreateDeviceKeys();
    const c = new FakeComputer(name, await generateDeviceKeys());
    const secret = randomBytes(32);
    const phoneKeys: PairKeys = await derivePairKeys({
      agreementPrivateKey: device.agreement.privateKey,
      peerAgreementSpki: c.keys.agreementSpki,
      secret,
      roomId: c.roomId,
      computerId: c.keys.deviceId,
      phoneId: device.deviceId,
    });
    const computerKeys = await derivePairKeys({
      agreementPrivateKey: c.keys.agreement.privateKey,
      peerAgreementSpki: device.agreementSpki,
      secret,
      roomId: c.roomId,
      computerId: c.keys.deviceId,
      phoneId: device.deviceId,
    });
    c.channel = await PairChannel.open({
      role: "computer",
      selfId: c.keys.deviceId,
      peerId: device.deviceId,
      keys: computerKeys,
      store: new MemoryCounterStore(),
    });
    const record: RoomRecord = {
      roomId: c.roomB64,
      relayUrl: "wss://relay.example.com",
      computerName: name,
      os: "mac",
      computerId: b64uEncode(c.keys.deviceId),
      keys: phoneKeys,
      deviceName: "iPhone",
      pairedAt: 1,
      lastUsedAt,
    };
    await storage.putRoom(record);
    return c;
  }

  get id(): string {
    return b64uEncode(this.keys.deviceId);
  }

  /** Sockets the phone still has open to this room. */
  get openSockets(): FakeSocket[] {
    return this.sockets.filter((s) => s.readyState === 1);
  }

  /** The computer comes back with a new socket: the relay tells the phone with `peer`. */
  reconnect(): void {
    this.deaf = false;
    this.online = true;
    for (const s of this.openSockets)
      s.control({ t: "peer", id: this.id, online: true });
  }

  frame(socket: FakeSocket, bytes: Uint8Array): void {
    if (this.deaf || !this.online) return;
    this.recv = this.recv.then(async () => {
      let p: DevicePayload;
      try {
        p = await this.channel.open(bytes);
      } catch {
        return;
      }
      await this.handle(socket, p);
    });
  }

  private session(id: Uint8Array): ComputerSession {
    const sid = b64uEncode(id);
    let s = this.sessions.get(sid);
    if (!s) {
      s = { starts: 0, blocks: new Set(), end: null, answered: 0 };
      this.sessions.set(sid, s);
    }
    return s;
  }

  private async handle(socket: FakeSocket, p: DevicePayload): Promise<void> {
    switch (p.type) {
      case "presence_query":
        this.presenceQueries++;
        if (this.presence)
          await this.send(socket, { type: "presence", ...this.presence });
        return;
      case "audio_start":
        this.session(p.sessionId).starts++;
        return;
      case "audio_chunk": {
        const s = this.session(p.sessionId);
        const n = Math.ceil(p.pcm.length / 6400);
        for (let i = 0; i < n; i++) s.blocks.add(p.firstIndex + i);
        return this.maybeAnswer(socket, p.sessionId, s);
      }
      case "audio_end": {
        const s = this.session(p.sessionId);
        s.end = p.chunks;
        return this.maybeAnswer(socket, p.sessionId, s);
      }
      default:
        return;
    }
  }

  /** Answers once every block up to audio_end's count is here. */
  private async maybeAnswer(
    socket: FakeSocket,
    id: Uint8Array,
    s: ComputerSession,
  ): Promise<void> {
    if (s.end === null || !this.answer) return;
    for (let i = 0; i < s.end; i++) if (!s.blocks.has(i)) return;
    if (s.answered >= s.starts) return;
    s.answered = s.starts;
    await this.send(socket, { type: "result", sessionId: id, ok: true });
  }

  private async send(socket: FakeSocket, p: DevicePayload): Promise<void> {
    socket.binary(await this.channel.seal(p));
  }
}

export class FakeRelay {
  readonly computers = new Map<string, FakeComputer>();
  /** Delay of every relay answer. */
  latencyMs = 15;
  phoneId = "";

  add(c: FakeComputer): void {
    this.computers.set(c.roomB64, c);
  }

  /** The WebSocket constructor the controller gets. */
  get WebSocket(): WebSocketCtor {
    const relay = this;
    return class extends FakeSocket {
      constructor(url: string) {
        super(relay, url);
      }
    } as unknown as WebSocketCtor;
  }
}

export class FakeSocket {
  readyState = 0;
  binaryType = "arraybuffer";
  onmessage: ((ev: { data: string | ArrayBuffer }) => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  /** Looks open, but nothing goes out or comes back, and it never closes by itself. */
  frozen = false;
  private readonly relay: FakeRelay;
  private readonly computer: FakeComputer | undefined;

  constructor(relay: FakeRelay, url: string) {
    this.relay = relay;
    const m = /\/v1\/rooms\/([A-Za-z0-9_-]{22})\/ws/.exec(url);
    this.computer = m ? relay.computers.get(m[1]!) : undefined;
    this.computer?.sockets.push(this);
    this.later(() => {
      if (!this.computer) return this.drop(4404);
      this.readyState = 1;
      this.control({ t: "challenge", n: b64uEncode(randomBytes(32)) });
    });
  }

  private later(fn: () => void): void {
    setTimeout(() => {
      if (!this.frozen) fn();
    }, this.relay.latencyMs);
  }

  control(msg: ControlMessage): void {
    this.text(serializeControlMessage(msg));
  }

  text(data: string): void {
    this.later(() => {
      if (this.readyState === 1) this.onmessage?.({ data });
    });
  }

  binary(bytes: Uint8Array): void {
    const data = bytes.slice().buffer;
    this.later(() => {
      if (this.readyState === 1) this.onmessage?.({ data });
    });
  }

  send(data: string | Uint8Array): void {
    if (this.readyState !== 1) throw new Error("not open");
    if (this.frozen || !this.computer) return;
    if (typeof data !== "string") {
      this.computer.frame(this, new Uint8Array(data));
      return;
    }
    if (data === PING_MESSAGE) return this.text(PONG_MESSAGE);
    const msg = parseControlMessage(data);
    if (msg.t === "auth") {
      this.relay.phoneId = msg.id;
      const c = this.computer;
      this.control({
        t: "ok",
        role: "phone",
        members: [
          { id: msg.id, role: "phone", online: true, lastSeenDay: 0 },
          { id: c.id, role: "owner", online: c.online, lastSeenDay: 0 },
        ],
      });
    }
  }

  close(code = 1000): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    setTimeout(() => this.onclose?.({ code }), 0);
  }

  /** The connection is lost and the browser notices. */
  drop(code = 1006): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({ code });
  }

  /** The connection is lost and the browser does not notice. */
  freeze(): void {
    this.frozen = true;
  }
}
