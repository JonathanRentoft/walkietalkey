/**
 * A scripted computer on @walkietalkey/protocol (the room owner): creates its room, shows a
 * pairing code, verifies the join MAC, decrypts the phone's frames, collects audio sessions,
 * answers with results and presence, revokes. Mirrors relay/scripts/smoke.ts's computer side.
 */
import {
  CloseCode,
  MemoryCounterStore,
  PairChannel,
  b64uDecode,
  b64uEncode,
  computeRoomId,
  derivePairKeys,
  encodePairingUrl,
  generateDeviceKeys,
  randomBytes,
  roomSocketUrl,
  sha256,
  signChallenge,
  verifyJoinMac,
  type ComputerOs,
  type DeviceKeys,
  type DevicePayload,
  type ResultReason,
} from "@walkietalkey/protocol";
import {
  RelaySocket,
  SocketClosedError,
  type Incoming,
} from "@walkietalkey/protocol/relay-socket";

export interface SessionLog {
  sid: string;
  id: Uint8Array;
  starts: number;
  blocks: Map<number, Uint8Array>;
  chunkFrames: number;
  /** Blocks that arrived again (resends), and how many of those differed from the first copy. */
  duplicates: number;
  mismatches: number;
  end: { chunks: number; durationMs: number } | null;
  cancelled: boolean;
  answered: number;
}

export interface PhoneLog {
  id: string;
  channel: PairChannel;
  name: string | null;
  platform: string | null;
}

export type Answer = { ok: true } | { ok: false; reason: ResultReason } | null;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class ScriptedComputer {
  readonly keys: DeviceKeys;
  readonly salt = randomBytes(16);
  roomId!: Uint8Array;
  readonly relayUrl: string;
  readonly name: string;
  readonly os: ComputerOs;
  socket: RelaySocket | null = null;
  /** Sockets left open by goQuiet(). */
  private readonly quiet: RelaySocket[] = [];
  created = false;
  readonly phones = new Map<string, PhoneLog>();
  readonly sessions = new Map<string, SessionLog>();
  readonly left: string[] = [];
  readonly log: string[] = [];
  /** How to answer a finished session; null = no answer (the phone keeps waiting). */
  answer: (s: SessionLog) => Answer = () => ({ ok: true });
  /** Answer to presence_query; null = stay silent. */
  presence: { secondsSinceInput: number; locked: boolean } | null = null;
  private pending: { a: Uint8Array; s: Uint8Array; h: string } | null = null;
  private readonly store = new MemoryCounterStore();
  private recv: Promise<unknown> = Promise.resolve();

  private constructor(
    keys: DeviceKeys,
    relayUrl: string,
    name: string,
    os: ComputerOs,
  ) {
    this.keys = keys;
    this.relayUrl = relayUrl;
    this.name = name;
    this.os = os;
  }

  static async create(
    relayUrl: string,
    name = "Testcomputer",
    os: ComputerOs = "mac",
  ): Promise<ScriptedComputer> {
    const c = new ScriptedComputer(
      await generateDeviceKeys(),
      relayUrl,
      name,
      os,
    );
    c.roomId = await computeRoomId(c.keys.signingSpki, c.salt);
    return c;
  }

  get online(): boolean {
    return !!this.socket?.open;
  }

  /** Creates the room the first time, authenticates afterwards. */
  async connect(): Promise<void> {
    const intent = this.created ? "auth" : "create";
    const sock = await RelaySocket.open(
      roomSocketUrl(this.relayUrl, this.roomId, intent),
    );
    const ch = b64uDecode((await sock.control("challenge")).n, 32);
    if (this.created) {
      const sig = await signChallenge(
        this.keys.signing.privateKey,
        "wt-auth-v1",
        this.roomId,
        ch,
      );
      sock.sendControl({
        t: "auth",
        id: b64uEncode(this.keys.deviceId),
        sig: b64uEncode(sig),
      });
    } else {
      const sig = await signChallenge(
        this.keys.signing.privateKey,
        "wt-create-v1",
        this.roomId,
        ch,
      );
      sock.sendControl({
        t: "create",
        pub: b64uEncode(this.keys.signingSpki),
        salt: b64uEncode(this.salt),
        sig: b64uEncode(sig),
      });
    }
    await sock.control("ok");
    this.created = true;
    this.socket = sock;
    sock.onMessage = (m) => this.incoming(m);
    for (const m of sock.queue.splice(0))
      if (!this.incoming(m)) sock.queue.push(m);
    sock.startPing();
    this.log.push("connected");
  }

  disconnect(): void {
    this.socket?.close(1000, "bye");
    this.socket = null;
    this.log.push("disconnected");
  }

  /**
   * A laptop whose lid just closed: its socket stays open, and the relay counts it as live for up
   * to 75 s (RELAY-10), but no ping goes out and whatever arrives is lost. connect() later opens a
   * new socket, as the computer does when it wakes.
   */
  goQuiet(): void {
    const s = this.socket;
    if (!s) return;
    s.stopPing();
    s.onMessage = () => true;
    this.quiet.push(s);
    this.socket = null;
    this.log.push("quiet");
  }

  /** spec 5.3 step 1: register SHA-256(a) and make the QR's URL. */
  async pairingUrl(
    phoneAppUrl: string,
    relayUrlForPhone = this.relayUrl,
  ): Promise<string> {
    const a = randomBytes(32);
    const s = randomBytes(32);
    const h = b64uEncode(await sha256(a));
    this.socket!.sendControl({
      t: "add_admission",
      h,
      exp: Date.now() + 10 * 60 * 1000,
    });
    await this.socket!.control("ack");
    this.pending = { a, s, h };
    return encodePairingUrl(phoneAppUrl, {
      v: 1,
      r: this.roomId,
      a,
      s,
      e: this.keys.agreementSpki,
      u: relayUrlForPhone,
      n: this.name,
      o: this.os,
    });
  }

  async cancelAdmission(): Promise<void> {
    if (!this.pending) return;
    this.socket!.sendControl({ t: "cancel_admission", h: this.pending.h });
    await this.socket!.control("ack");
  }

  private incoming(m: Incoming): boolean {
    if (m.kind === "binary") {
      const bytes = m.bytes;
      this.recv = this.recv.then(() => this.frame(bytes));
      return true;
    }
    const msg = m.msg;
    if (!msg) return false;
    if (msg.t === "member_joined") {
      this.recv = this.recv.then(() =>
        this.joined(msg.id, msg.pub, msg.agree, msg.mac, msg.eid),
      );
      return true;
    }
    if (msg.t === "member_left") {
      this.left.push(msg.id);
      this.phones.delete(msg.id);
      this.socket?.sendControl({ t: "event_ack", eid: msg.eid });
      return true;
    }
    if (msg.t === "peer") {
      this.log.push(`peer ${msg.online}`);
      return true;
    }
    return false;
  }

  private async joined(
    id: string,
    pub: string,
    agree: string,
    mac: string,
    eid: number,
  ): Promise<void> {
    this.socket?.sendControl({ t: "event_ack", eid });
    const p = this.pending;
    if (!p) return;
    const agreeSpki = b64uDecode(agree);
    if (
      !(await verifyJoinMac(
        p.s,
        this.roomId,
        b64uDecode(pub),
        agreeSpki,
        b64uDecode(mac),
      ))
    ) {
      this.log.push("bad join MAC");
      return;
    }
    const phoneId = b64uDecode(id, 16);
    const keys = await derivePairKeys({
      agreementPrivateKey: this.keys.agreement.privateKey,
      peerAgreementSpki: agreeSpki,
      secret: p.s,
      roomId: this.roomId,
      computerId: this.keys.deviceId,
      phoneId,
    });
    this.pending = null;
    this.store.send.clear();
    this.store.recv.clear();
    const channel = await PairChannel.open({
      role: "computer",
      selfId: this.keys.deviceId,
      peerId: phoneId,
      keys,
      store: this.store,
    });
    this.phones.set(id, { id, channel, name: null, platform: null });
    this.log.push(`joined ${id}`);
  }

  private async frame(bytes: Uint8Array): Promise<void> {
    const sender = b64uEncode(bytes.subarray(2, 18));
    const phone = this.phones.get(sender);
    if (!phone) return;
    let p: DevicePayload;
    try {
      p = await phone.channel.open(bytes);
    } catch (e) {
      this.log.push(`dropped frame: ${e instanceof Error ? e.message : e}`);
      return;
    }
    await this.handle(phone, p);
  }

  private session(id: Uint8Array): SessionLog {
    const sid = b64uEncode(id);
    let s = this.sessions.get(sid);
    if (!s) {
      s = {
        sid,
        id,
        starts: 0,
        blocks: new Map(),
        chunkFrames: 0,
        duplicates: 0,
        mismatches: 0,
        end: null,
        cancelled: false,
        answered: 0,
      };
      this.sessions.set(sid, s);
    }
    return s;
  }

  private async handle(phone: PhoneLog, p: DevicePayload): Promise<void> {
    switch (p.type) {
      case "device_info":
        phone.name = p.name;
        phone.platform = p.platform;
        break;
      case "presence_query":
        if (this.presence)
          await this.send(phone, { type: "presence", ...this.presence });
        break;
      case "audio_start":
        this.session(p.sessionId).starts++;
        break;
      case "audio_chunk": {
        const s = this.session(p.sessionId);
        s.chunkFrames++;
        for (let o = 0, i = p.firstIndex; o < p.pcm.length; o += 6400, i++) {
          const block = p.pcm.slice(o, Math.min(o + 6400, p.pcm.length));
          const old = s.blocks.get(i);
          if (old) {
            s.duplicates++;
            if (Buffer.compare(Buffer.from(old), Buffer.from(block)) !== 0)
              s.mismatches++;
          } else s.blocks.set(i, block);
        }
        await this.maybeAnswer(phone, s);
        break;
      }
      case "audio_end": {
        const s = this.session(p.sessionId);
        s.end = { chunks: p.chunks, durationMs: p.durationMs };
        await this.maybeAnswer(phone, s);
        break;
      }
      case "audio_cancel":
        this.session(p.sessionId).cancelled = true;
        break;
    }
  }

  /** Answers once every block up to audio_end's count is here (DESK-61 waits for late blocks too). */
  private async maybeAnswer(phone: PhoneLog, s: SessionLog): Promise<void> {
    if (!s.end || s.cancelled) return;
    for (let i = 0; i < s.end.chunks; i++) if (!s.blocks.has(i)) return;
    if (s.answered > 0 && s.answered >= s.starts) return;
    const a = this.answer(s);
    if (!a) return;
    s.answered = s.starts;
    await this.send(
      phone,
      a.ok
        ? { type: "result", sessionId: s.id, ok: true }
        : { type: "result", sessionId: s.id, ok: false, reason: a.reason },
    );
  }

  async send(phone: PhoneLog, payload: DevicePayload): Promise<void> {
    if (!this.socket?.open) return;
    this.socket.sendBinary(await phone.channel.seal(payload));
  }

  async sendResult(sid: string, a: Exclude<Answer, null>): Promise<void> {
    const phone = [...this.phones.values()][0]!;
    const s = this.sessions.get(sid)!;
    s.answered = s.starts;
    await this.send(
      phone,
      a.ok
        ? { type: "result", sessionId: s.id, ok: true }
        : { type: "result", sessionId: s.id, ok: false, reason: a.reason },
    );
  }

  async revoke(phoneId: string): Promise<void> {
    this.socket!.sendControl({ t: "revoke", id: phoneId });
    await this.socket!.control("ack");
    this.phones.delete(phoneId);
  }

  async deleteRoom(): Promise<void> {
    for (const q of this.quiet.splice(0)) q.close();
    if (!this.socket?.open) {
      try {
        await this.connect();
      } catch (e) {
        if (e instanceof SocketClosedError && e.code === CloseCode.RoomNotFound)
          return;
        throw e;
      }
    }
    this.socket!.sendControl({ t: "delete_room" });
    await this.socket!.closed().catch(() => undefined);
    this.socket = null;
  }

  // ---------------------------------------------------------------- waiting

  async until<T>(
    get: () => T | undefined | null | false,
    what: string,
    timeoutMs = 15_000,
  ): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const v = get();
      if (v) return v;
      if (Date.now() > deadline)
        throw new Error(
          `computer timed out waiting for ${what}; log: ${this.log.slice(-8).join(" | ")}`,
        );
      await sleep(50);
    }
  }

  waitPhone(timeoutMs?: number): Promise<PhoneLog> {
    return this.until(
      () => [...this.phones.values()].find((p) => p.name !== null),
      "a paired phone with its name",
      timeoutMs,
    );
  }

  waitSession(
    pred: (s: SessionLog) => boolean,
    what: string,
    timeoutMs?: number,
  ): Promise<SessionLog> {
    return this.until(
      () => [...this.sessions.values()].find(pred),
      what,
      timeoutMs,
    );
  }

  waitEnded(timeoutMs?: number): Promise<SessionLog> {
    return this.waitSession(
      (s) =>
        !!s.end &&
        !s.cancelled &&
        [...Array(s.end.chunks).keys()].every((i) => s.blocks.has(i)),
      "a complete session",
      timeoutMs,
    );
  }

  /** PCM of a session, blocks in order. */
  static pcm(s: SessionLog): Uint8Array {
    const n = s.end?.chunks ?? s.blocks.size;
    const parts: Uint8Array[] = [];
    for (let i = 0; i < n; i++) parts.push(s.blocks.get(i)!);
    return Buffer.concat(parts);
  }
}
