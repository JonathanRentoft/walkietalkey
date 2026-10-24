/**
 * One SQLite-backed Durable Object per room (spec section 8). Accepts sockets with the
 * WebSocket Hibernation API; all per-socket state that must survive hibernation lives in the
 * socket attachment. Byte-level protocol: docs/PROTOCOL.md.
 */
import { DurableObject } from "cloudflare:workers";
import {
  CloseCode,
  ExtraCloseCode,
  FrameType,
  PING_MESSAGE,
  PONG_MESSAGE,
  ProtocolError,
  b64uDecode,
  b64uEncode,
  bytesEqual,
  computeRoomId,
  deviceIdFromSpki,
  importAgreementPublicKey,
  parseControlMessage,
  parseFrame,
  randomBytes,
  serializeControlMessage,
  sha256,
  verifyChallenge,
  type ControlMessage,
  type ControlOf,
  type Intent,
  type MemberInfo,
  type Role,
} from "@walkietalkey/protocol";
import { decodeBatch, encodeBatch, frameListEndsDictation } from "./batch.ts";
import {
  BUFFER_ROW_BYTES,
  BUFFER_TTL_MS,
  DAY_MS,
  DEVICE_TTL_DAYS,
  FLUSH_DELAY_MS,
  LIVENESS_TIMEOUT_MS,
  MAX_ADMISSIONS,
  MAX_CONTROL_CHARS,
  MAX_DEVICES_PER_ROOM,
  MAX_FRAMES_PER_SECOND,
  MAX_SOCKETS_PER_ROOM,
  PENDING_TIMEOUT_MS,
  ROOM_BUFFER_BYTES,
} from "./limits.ts";
import { logLine, roomTag, type LogFields } from "./log.ts";
import { RoomStore } from "./store.ts";

/** Per-socket state kept in serializeAttachment (at most 2,048 bytes; see worstCaseAttachmentSize). */
export interface Attachment {
  v: 1;
  /** pending (challenge sent) or authed */
  st: "p" | "a";
  /** room id, base64url */
  rm: string;
  /** declared intent */
  in: Intent;
  /** challenge, base64url (pending only) */
  ch?: string;
  /** connected at, relay clock ms */
  at: number;
  /** device id, base64url (authed only) */
  id?: string;
  /** role (authed only) */
  ro?: Role;
}

interface Member {
  id: string;
  role: Role;
  pub: string;
  lastSeenDay: number;
}

interface Batch {
  frames: Uint8Array[];
  bytes: number;
  firstAt: number;
  lastAtReal: number;
  senders: Set<string>;
}

/** Ephemeral per-socket state; losing it on hibernation is harmless (see PROTOCOL.md). */
interface Live {
  tokens: number;
  refillAtReal: number;
  lastMsgAt: number;
}

const ROOM_PATH = /^\/v1\/rooms\/([A-Za-z0-9_-]{22})\/ws$/;
const INTENTS: readonly string[] = ["auth", "create", "join"];

export class Room extends DurableObject<Env> {
  readonly store: RoomStore;
  /** Test hook: shifts the relay clock. Always 0 in production. */
  clockOffsetMs = 0;
  /** RELAY-08 limit; a field so tests can lower it. */
  bufferLimitBytes = ROOM_BUFFER_BYTES;
  /** RELAY-11 per-socket limit; a field so buffering tests can send a dictation in one burst. */
  maxFramesPerSecond = MAX_FRAMES_PER_SECOND;
  /** Test hook: the clock the RELAY-11 token bucket refills by. Always Date.now in production. */
  tokenClock: () => number = () => Date.now();

  private exists: boolean | null = null;
  private membersCache: Map<string, Member> | null = null;
  private batches = new Map<string, Batch>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private alarmAt: number | null | undefined = undefined;
  private tag: Promise<string> | null = null;
  private live = new WeakMap<WebSocket, Live>();
  private closing = new WeakSet<WebSocket>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.store = new RoomStore(ctx.storage.sql);
    // RELAY-10: answered by the runtime without waking the object.
    ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair(PING_MESSAGE, PONG_MESSAGE),
    );
  }

  // ---------------------------------------------------------------- clock, logging

  now(): number {
    return Date.now() + this.clockOffsetMs;
  }

  private today(): number {
    return Math.floor(this.now() / DAY_MS);
  }

  private log(roomB64: string | undefined, fields: LogFields): void {
    if (!roomB64) return logLine(fields);
    if (!this.tag) this.tag = roomTag(roomB64);
    void this.tag.then((room) => logLine({ room, ...fields }));
  }

  // ---------------------------------------------------------------- room state

  private roomExists(): boolean {
    if (this.exists === null) this.exists = this.store.roomExists();
    return this.exists;
  }

  private members(): Map<string, Member> {
    if (!this.roomExists()) return new Map();
    if (!this.membersCache) {
      const rows = this.store.exec<{
        device_id: string;
        role: string;
        signing_public_key: string;
        last_seen_day: number;
      }>(
        "SELECT device_id, role, signing_public_key, last_seen_day FROM devices",
      );
      this.membersCache = new Map(
        rows.map((r) => [
          r.device_id,
          {
            id: r.device_id,
            role: r.role as Role,
            pub: r.signing_public_key,
            lastSeenDay: r.last_seen_day,
          },
        ]),
      );
    }
    return this.membersCache;
  }

  private ownerId(): string | undefined {
    for (const m of this.members().values())
      if (m.role === "owner") return m.id;
    return undefined;
  }

  // ---------------------------------------------------------------- sockets

  private att(ws: WebSocket): Attachment {
    return ws.deserializeAttachment() as Attachment;
  }

  private liveOf(ws: WebSocket): Live {
    let l = this.live.get(ws);
    if (!l) {
      l = {
        tokens: this.maxFramesPerSecond,
        refillAtReal: this.tokenClock(),
        lastMsgAt: 0,
      };
      this.live.set(ws, l);
    }
    return l;
  }

  /** Token bucket: 50 messages per second per socket (RELAY-11). In memory only. */
  private takeToken(ws: WebSocket): boolean {
    const l = this.liveOf(ws);
    const t = this.tokenClock();
    const rate = this.maxFramesPerSecond;
    l.tokens = Math.min(rate, l.tokens + ((t - l.refillAtReal) / 1000) * rate);
    l.refillAtReal = t;
    if (l.tokens < 1) return false;
    l.tokens -= 1;
    return true;
  }

  private lastAlive(ws: WebSocket, att: Attachment): number {
    const auto = this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime() ?? 0;
    return Math.max(auto, att.at, this.live.get(ws)?.lastMsgAt ?? 0);
  }

  private isFresh(ws: WebSocket, att: Attachment): boolean {
    return this.now() - this.lastAlive(ws, att) <= LIVENESS_TIMEOUT_MS;
  }

  /** Authenticated sockets of a device that are not closing. */
  private socketsOf(deviceId: string): WebSocket[] {
    return this.ctx.getWebSockets().filter((ws) => {
      if (this.closing.has(ws)) return false;
      const a = this.att(ws);
      return a.st === "a" && a.id === deviceId;
    });
  }

  /**
   * Closes sockets that connected more than 30 s ago and never authenticated (RELAY-11), and
   * returns how many sockets remain open. Runs when a socket connects and when a message arrives.
   */
  private sweepPending(): number {
    const now = this.now();
    let open = 0;
    for (const ws of this.ctx.getWebSockets()) {
      if (this.closing.has(ws)) continue;
      const a = this.att(ws);
      if (a.st === "p" && now - a.at > PENDING_TIMEOUT_MS) {
        this.closeSocket(ws, ExtraCloseCode.GoingAway, "handshake timeout");
        continue;
      }
      open++;
    }
    return open;
  }

  private isOnline(deviceId: string): boolean {
    return this.socketsOf(deviceId).some((ws) =>
      this.isFresh(ws, this.att(ws)),
    );
  }

  private send(ws: WebSocket, msg: ControlMessage): void {
    try {
      ws.send(serializeControlMessage(msg));
    } catch {
      /* socket already gone */
    }
  }

  private closeSocket(ws: WebSocket, code: number, reason: string): void {
    if (this.closing.has(ws)) return;
    this.closing.add(ws);
    const a = this.att(ws);
    this.log(a?.rm, { evt: "close", code });
    try {
      ws.close(code, reason);
    } catch {
      /* already closed */
    }
  }

  /** Sends `error` (when a code is given) and closes. */
  private fail(
    ws: WebSocket,
    code: number,
    errorCode: string,
    msg = errorCode,
  ): void {
    this.send(ws, { t: "error", code: errorCode, msg });
    this.closeSocket(ws, code, errorCode);
  }

  /** Tells the other side whether a device is online: phones learn about the owner, the owner about phones. */
  private announce(deviceId: string, online: boolean): void {
    const m = this.members().get(deviceId);
    if (!m) return;
    const targets =
      m.role === "owner"
        ? [...this.members().values()]
            .filter((x) => x.role === "phone")
            .flatMap((x) => this.socketsOf(x.id))
        : this.socketsOf(this.ownerId() ?? "");
    for (const ws of targets)
      this.send(ws, { t: "peer", id: deviceId, online });
  }

  // ---------------------------------------------------------------- entry points

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const match = ROOM_PATH.exec(url.pathname);
    if (!match) return new Response("not found", { status: 404 });
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("expected a WebSocket upgrade", { status: 426 });
    }
    const roomB64 = match[1]!;
    const intentParam = url.searchParams.get("intent") ?? "auth";
    if (!INTENTS.includes(intentParam))
      return new Response("unknown intent", { status: 400 });
    const intent = intentParam as Intent;
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];

    const exists = this.roomExists();
    if ((intent !== "create" && !exists) || (intent === "create" && exists)) {
      // Nothing is written for a room that does not exist (RELAY-01).
      const code = exists ? CloseCode.RoomExists : CloseCode.RoomNotFound;
      server.accept();
      server.close(code, exists ? "room exists" : "room not found");
      this.log(roomB64, { evt: "close", code });
      return new Response(null, { status: 101, webSocket: client });
    }
    if (this.sweepPending() >= MAX_SOCKETS_PER_ROOM) {
      // RELAY-11: every route and announce scans the room's sockets, so their number is bounded.
      server.accept();
      server.close(CloseCode.RateLimited, "too many sockets");
      this.log(roomB64, { evt: "close", code: CloseCode.RateLimited });
      return new Response(null, { status: 101, webSocket: client });
    }

    this.ctx.acceptWebSocket(server);
    const att: Attachment = {
      v: 1,
      st: "p",
      rm: roomB64,
      in: intent,
      ch: b64uEncode(randomBytes(32)),
      at: this.now(),
    };
    server.serializeAttachment(att);
    this.send(server, { t: "challenge", n: att.ch! });
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(
    ws: WebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> {
    if (this.closing.has(ws)) return;
    this.sweepPending();
    if (this.closing.has(ws)) return;
    if (!this.takeToken(ws))
      return this.fail(ws, CloseCode.RateLimited, "rate_limited");
    const att = this.att(ws);
    this.liveOf(ws).lastMsgAt = this.now();

    if (typeof message === "string") {
      if (message.length > MAX_CONTROL_CHARS)
        return this.fail(ws, CloseCode.FrameTooLarge, "frame_too_large");
      let msg: ControlMessage;
      try {
        msg = parseControlMessage(message);
      } catch {
        return this.fail(ws, 1008, "bad_message");
      }
      if (att.st === "p") return this.handshake(ws, att, msg);
      return this.command(ws, att, msg);
    }

    if (message.byteLength > 65536)
      return this.fail(ws, CloseCode.FrameTooLarge, "frame_too_large");
    if (att.st !== "a")
      return this.fail(ws, CloseCode.NotAuthorised, "not_authenticated");
    this.route(ws, att, new Uint8Array(message));
  }

  async webSocketClose(
    ws: WebSocket,
    code: number,
    reason: string,
  ): Promise<void> {
    await this.socketGone(
      ws,
      code === 1005 || code === 1006 ? 1000 : code,
      reason,
    );
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.socketGone(ws, 1011, "error");
  }

  private async socketGone(
    ws: WebSocket,
    code: number,
    reason: string,
  ): Promise<void> {
    const wasClosing = this.closing.has(ws);
    this.closing.add(ws);
    if (!wasClosing) {
      try {
        ws.close(code, reason);
      } catch {
        /* already closed */
      }
    }
    const att = this.att(ws);
    if (att.st !== "a" || !att.id) return;
    // RELAY-08: flush what this sender left in memory.
    for (const [recipient, b] of [...this.batches]) {
      if (b.senders.has(att.id)) await this.flush(recipient);
    }
    if (
      this.roomExists() &&
      this.members().has(att.id) &&
      !this.isOnline(att.id)
    )
      this.announce(att.id, false);
  }

  // ---------------------------------------------------------------- handshake

  private isPending(ws: WebSocket): boolean {
    return !this.closing.has(ws) && this.att(ws).st === "p";
  }

  private async handshake(
    ws: WebSocket,
    att: Attachment,
    msg: ControlMessage,
  ): Promise<void> {
    if (msg.t !== "auth" && msg.t !== "create" && msg.t !== "join") {
      return this.fail(ws, CloseCode.NotAuthorised, "not_authenticated");
    }
    if (msg.t !== att.in)
      return this.fail(ws, CloseCode.NotAllowed, "intent_mismatch");
    const roomId = b64uDecode(att.rm, 16);
    const challenge = b64uDecode(att.ch!, 32);
    if (msg.t === "auth") return this.auth(ws, att, msg, roomId, challenge);
    if (msg.t === "create") return this.create(ws, att, msg, roomId, challenge);
    return this.join(ws, att, msg, roomId, challenge);
  }

  private async auth(
    ws: WebSocket,
    att: Attachment,
    msg: ControlOf<"auth">,
    roomId: Uint8Array,
    challenge: Uint8Array,
  ) {
    if (!this.roomExists())
      return this.fail(ws, CloseCode.RoomNotFound, "room_not_found");
    const member = this.members().get(msg.id);
    if (!member) return this.fail(ws, CloseCode.NotAuthorised, "not_member");
    const ok = await verifyChallenge(
      b64uDecode(member.pub),
      "wt-auth-v1",
      roomId,
      challenge,
      b64uDecode(msg.sig),
    );
    if (!this.isPending(ws)) return;
    if (!this.roomExists())
      return this.fail(ws, CloseCode.RoomNotFound, "room_not_found");
    if (!ok || !this.members().has(msg.id))
      return this.fail(ws, CloseCode.NotAuthorised, "bad_signature");
    await this.complete(ws, att, msg.id);
  }

  private async create(
    ws: WebSocket,
    att: Attachment,
    msg: ControlOf<"create">,
    roomId: Uint8Array,
    challenge: Uint8Array,
  ) {
    const pub = b64uDecode(msg.pub);
    const salt = b64uDecode(msg.salt, 16);
    const bound = bytesEqual(await computeRoomId(pub, salt), roomId);
    if (!bound) return this.fail(ws, CloseCode.NotAuthorised, "room_binding");
    let ok = false;
    try {
      ok = await verifyChallenge(
        pub,
        "wt-create-v1",
        roomId,
        challenge,
        b64uDecode(msg.sig),
      );
    } catch (e) {
      if (!(e instanceof ProtocolError)) throw e;
    }
    if (!ok) return this.fail(ws, CloseCode.NotAuthorised, "bad_signature");
    const id = b64uEncode(await deviceIdFromSpki(pub));
    if (!this.isPending(ws)) return;
    // Synchronous from here: no other event can run in between.
    if (this.roomExists())
      return this.fail(ws, CloseCode.RoomExists, "room_exists");
    const now = this.now();
    const today = this.today();
    this.store.createSchema();
    this.store.exec(
      "INSERT INTO room (owner_device_id, salt, created_at) VALUES (?, ?, ?)",
      id,
      msg.salt,
      now,
    );
    this.store.exec(
      "INSERT INTO devices (device_id, signing_public_key, role, added_at, last_seen_day) VALUES (?, ?, 'owner', ?, ?)",
      id,
      msg.pub,
      now,
      today,
    );
    this.exists = true;
    this.membersCache = null;
    this.log(att.rm, { evt: "created" });
    await this.ensureAlarm(this.deviceExpiry(today));
    await this.complete(ws, att, id);
  }

  private async join(
    ws: WebSocket,
    att: Attachment,
    msg: ControlOf<"join">,
    roomId: Uint8Array,
    challenge: Uint8Array,
  ) {
    if (!this.roomExists())
      return this.fail(ws, CloseCode.RoomNotFound, "room_not_found");
    const pub = b64uDecode(msg.pub);
    try {
      await importAgreementPublicKey(b64uDecode(msg.agree));
    } catch {
      return this.fail(ws, 1008, "bad_key");
    }
    let ok = false;
    try {
      ok = await verifyChallenge(
        pub,
        "wt-join-v1",
        roomId,
        challenge,
        b64uDecode(msg.sig),
      );
    } catch (e) {
      if (!(e instanceof ProtocolError)) throw e;
    }
    if (!ok) return this.fail(ws, CloseCode.NotAuthorised, "bad_signature");
    const hash = b64uEncode(await sha256(b64uDecode(msg.a, 32)));
    const id = b64uEncode(await deviceIdFromSpki(pub));
    if (!this.isPending(ws)) return;
    // Synchronous from here.
    if (!this.roomExists())
      return this.fail(ws, CloseCode.RoomNotFound, "room_not_found");
    const members = this.members();
    if (id === this.ownerId())
      return this.fail(ws, CloseCode.NotAllowed, "not_allowed");
    const existing = members.get(id);
    if (!existing && members.size >= MAX_DEVICES_PER_ROOM)
      return this.fail(ws, CloseCode.NotAllowed, "room_full");
    const now = this.now();
    const adm = this.store.one<{ expires_at: number }>(
      "SELECT expires_at FROM admissions WHERE admission_sha256 = ?",
      hash,
    );
    if (!adm || adm.expires_at <= now)
      return this.fail(ws, CloseCode.NotAuthorised, "admission_invalid");
    this.store.exec("DELETE FROM admissions WHERE admission_sha256 = ?", hash);
    const today = this.today();
    if (existing) {
      // The same phone pairing again: it stays a member; the owner re-derives its keys.
      if (existing.lastSeenDay !== today) {
        this.store.exec(
          "UPDATE devices SET last_seen_day = ? WHERE device_id = ?",
          today,
          id,
        );
      }
    } else {
      this.store.exec(
        "INSERT INTO devices (device_id, signing_public_key, role, added_at, last_seen_day) VALUES (?, ?, 'phone', ?, ?)",
        id,
        msg.pub,
        now,
        today,
      );
    }
    this.membersCache = null;
    const payload = JSON.stringify({
      id,
      pub: msg.pub,
      agree: msg.agree,
      mac: msg.mac,
    });
    const ev = this.store.one<{ id: number }>(
      "INSERT INTO owner_events (kind, payload, created_at) VALUES ('member_joined', ?, ?) RETURNING id",
      payload,
      now,
    )!;
    const owner = this.ownerId();
    if (owner) {
      for (const o of this.socketsOf(owner)) {
        this.send(o, {
          t: "member_joined",
          id,
          pub: msg.pub,
          agree: msg.agree,
          mac: msg.mac,
          eid: ev.id,
        });
      }
    }
    this.log(att.rm, { evt: "joined", members: this.members().size });
    await this.complete(ws, att, id);
  }

  /** Marks the socket authenticated, sends ok, pending owner events and buffered frames. */
  private async complete(
    ws: WebSocket,
    att: Attachment,
    id: string,
  ): Promise<void> {
    const member = this.members().get(id);
    if (!member) return this.fail(ws, CloseCode.NotAuthorised, "not_member");
    const authed: Attachment = {
      v: 1,
      st: "a",
      rm: att.rm,
      in: att.in,
      at: att.at,
      id,
      ro: member.role,
    };
    ws.serializeAttachment(authed);
    const today = this.today();
    if (member.lastSeenDay !== today) {
      // Written at most once per device per day (spec 8.3).
      this.store.exec(
        "UPDATE devices SET last_seen_day = ? WHERE device_id = ?",
        today,
        id,
      );
      member.lastSeenDay = today;
    }
    const members: MemberInfo[] = [...this.members().values()].map((m) => ({
      id: m.id,
      role: m.role,
      online: m.id === id || this.isOnline(m.id),
      lastSeenDay: m.lastSeenDay,
    }));
    this.send(ws, { t: "ok", role: member.role, members });
    if (member.role === "owner") this.sendOwnerEvents(ws);
    this.deliverBuffered(ws, id);
    this.announce(id, true);
  }

  private sendOwnerEvents(ws: WebSocket): void {
    const rows = this.store.exec<{ id: number; kind: string; payload: string }>(
      "SELECT id, kind, payload FROM owner_events ORDER BY id",
    );
    for (const r of rows) {
      const p = JSON.parse(r.payload) as {
        id: string;
        pub?: string;
        agree?: string;
        mac?: string;
      };
      if (r.kind === "member_joined") {
        this.send(ws, {
          t: "member_joined",
          id: p.id,
          pub: p.pub!,
          agree: p.agree!,
          mac: p.mac!,
          eid: r.id,
        });
      } else {
        this.send(ws, { t: "member_left", id: p.id, eid: r.id });
      }
    }
  }

  // ---------------------------------------------------------------- commands

  private async command(
    ws: WebSocket,
    att: Attachment,
    msg: ControlMessage,
  ): Promise<void> {
    if (!this.roomExists() || !this.members().has(att.id!)) {
      return this.fail(ws, CloseCode.NotAuthorised, "not_member");
    }
    const owner = att.ro === "owner";
    switch (msg.t) {
      case "ping":
        // Only reached when the text differs from the exact auto-response string.
        try {
          ws.send(PONG_MESSAGE);
        } catch {
          /* gone */
        }
        return;
      case "add_admission":
        if (!owner) break;
        return this.addAdmission(ws, att, msg);
      case "cancel_admission":
        if (!owner) break;
        this.store.exec(
          "DELETE FROM admissions WHERE admission_sha256 = ?",
          msg.h,
        );
        return this.send(ws, { t: "ack", op: "cancel_admission", h: msg.h });
      case "event_ack":
        if (!owner) break;
        this.store.exec("DELETE FROM owner_events WHERE id = ?", msg.eid);
        return;
      case "revoke":
        if (!owner) break;
        return this.revoke(ws, att, msg.id);
      case "delete_room":
        if (!owner) break;
        return this.destroy(att.rm, "owner");
      case "leave":
        if (owner) break;
        return this.leave(ws, att);
      default:
        break;
    }
    this.fail(ws, CloseCode.NotAllowed, "not_allowed");
  }

  private async addAdmission(
    ws: WebSocket,
    att: Attachment,
    msg: ControlOf<"add_admission">,
  ): Promise<void> {
    const now = this.now();
    const expires = Math.min(msg.exp, now + BUFFER_TTL_MS);
    if (expires <= now)
      return this.send(ws, {
        t: "error",
        code: "admission_expired",
        msg: "exp is in the past",
      });
    const count = this.store.one<{ n: number }>(
      "SELECT COUNT(*) AS n FROM admissions WHERE expires_at > ?",
      now,
    )!.n;
    if (count >= MAX_ADMISSIONS)
      return this.send(ws, {
        t: "error",
        code: "too_many_admissions",
        msg: "too many admissions",
      });
    this.store.exec(
      "INSERT INTO admissions (admission_sha256, expires_at) VALUES (?, ?) ON CONFLICT (admission_sha256) DO UPDATE SET expires_at = excluded.expires_at",
      msg.h,
      expires,
    );
    await this.ensureAlarm(expires);
    this.send(ws, { t: "ack", op: "add_admission", h: msg.h });
    this.log(att.rm, { evt: "admission" });
  }

  private removePhone(id: string): void {
    this.store.exec(
      "DELETE FROM devices WHERE device_id = ? AND role = 'phone'",
      id,
    );
    this.store.exec("DELETE FROM buffered WHERE recipient_device_id = ?", id);
    this.batches.delete(id);
    this.membersCache = null;
  }

  private revoke(ws: WebSocket, att: Attachment, id: string): void {
    const m = this.members().get(id);
    if (m && m.role === "phone") {
      const sockets = this.socketsOf(id);
      this.removePhone(id);
      for (const s of sockets) this.fail(s, CloseCode.NotAuthorised, "revoked");
      this.log(att.rm, { evt: "revoked", members: this.members().size });
    }
    this.send(ws, { t: "ack", op: "revoke", id });
  }

  private leave(ws: WebSocket, att: Attachment): void {
    const id = att.id!;
    const others = this.socketsOf(id).filter((s) => s !== ws);
    this.removePhone(id);
    this.queueOwnerEvent("member_left", { id });
    for (const s of others) this.closeSocket(s, 1000, "left");
    this.closeSocket(ws, 1000, "left");
    this.log(att.rm, { evt: "left", members: this.members().size });
  }

  private queueOwnerEvent(kind: "member_left", payload: { id: string }): void {
    const ev = this.store.one<{ id: number }>(
      "INSERT INTO owner_events (kind, payload, created_at) VALUES (?, ?, ?) RETURNING id",
      kind,
      JSON.stringify(payload),
      this.now(),
    )!;
    const owner = this.ownerId();
    if (owner)
      for (const o of this.socketsOf(owner))
        this.send(o, { t: "member_left", id: payload.id, eid: ev.id });
  }

  /** delete_room (by the owner) or housekeeping: closes everything and deletes all storage. */
  private async destroy(
    roomB64: string,
    by: "owner" | "housekeeping",
  ): Promise<void> {
    const owner = this.ownerId();
    for (const ws of this.ctx.getWebSockets()) {
      const a = this.att(ws);
      if (by === "owner" && a.id === owner)
        this.closeSocket(ws, 1000, "room deleted");
      else this.closeSocket(ws, CloseCode.RoomNotFound, "room not found");
    }
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    this.batches.clear();
    await this.ctx.storage.deleteAlarm();
    this.store.alarmWrites++;
    await this.ctx.storage.deleteAll();
    this.exists = false;
    this.membersCache = null;
    this.alarmAt = null;
    this.log(roomB64, { evt: "deleted", by });
  }

  // ---------------------------------------------------------------- routing and buffering

  private route(ws: WebSocket, att: Attachment, bytes: Uint8Array): void {
    let header;
    try {
      header = parseFrame(bytes).header;
    } catch (e) {
      if (e instanceof ProtocolError && e.code === "frame_too_large") {
        return this.fail(ws, CloseCode.FrameTooLarge, "frame_too_large");
      }
      return this.fail(ws, 1008, "bad_frame");
    }
    const members = this.members();
    if (!members.has(att.id!))
      return this.fail(ws, CloseCode.NotAuthorised, "not_member");
    if (b64uEncode(header.sender) !== att.id)
      return this.fail(ws, CloseCode.NotAllowed, "wrong_sender");
    const recipient = b64uEncode(header.recipient);
    const owner = this.ownerId();
    if (att.ro === "phone") {
      if (recipient !== owner)
        return this.fail(ws, CloseCode.NotAllowed, "not_allowed");
    } else {
      if (recipient === owner)
        return this.fail(ws, CloseCode.NotAllowed, "not_allowed");
      if (!members.has(recipient)) return; // RELAY-07: dropped.
    }
    this.deliver(recipient, bytes, att.id!, header.type);
  }

  private deliver(
    recipient: string,
    bytes: Uint8Array,
    sender: string,
    type: number,
  ): void {
    const sockets = this.socketsOf(recipient);
    let sent = 0;
    let closedStale = false;
    for (const s of sockets) {
      if (!this.isFresh(s, this.att(s))) {
        // RELAY-10: a socket that went quiet (a sleeping laptop) is treated as offline.
        this.closeSocket(s, 1001, "no ping for 75 s");
        closedStale = true;
        continue;
      }
      try {
        s.send(bytes);
        sent++;
      } catch {
        this.closing.add(s);
      }
    }
    if (closedStale && sent === 0) this.announce(recipient, false);
    if (sent > 0) return;
    this.buffer(recipient, bytes, sender, type);
  }

  private buffer(
    recipient: string,
    bytes: Uint8Array,
    sender: string,
    type: number,
  ): void {
    let b = this.batches.get(recipient);
    if (b && b.bytes + 4 + bytes.length > BUFFER_ROW_BYTES) {
      void this.flush(recipient);
      b = undefined;
    }
    if (!b) {
      b = {
        frames: [],
        bytes: 0,
        firstAt: this.now(),
        lastAtReal: Date.now(),
        senders: new Set(),
      };
      this.batches.set(recipient, b);
    }
    b.frames.push(bytes);
    b.bytes += 4 + bytes.length;
    b.lastAtReal = Date.now();
    b.senders.add(sender);
    if (type === FrameType.AudioEnd || type === FrameType.AudioCancel) {
      void this.flush(recipient);
    } else {
      this.scheduleFlush();
    }
  }

  private scheduleFlush(delay = FLUSH_DELAY_MS): void {
    if (this.flushTimer) return;
    // The relay's only timer; while it is pending the object does not hibernate.
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.onFlushTimer();
    }, delay);
  }

  private async onFlushTimer(): Promise<void> {
    let next = Infinity;
    for (const [recipient, b] of [...this.batches]) {
      const idle = Date.now() - b.lastAtReal;
      if (idle >= FLUSH_DELAY_MS - 5) await this.flush(recipient);
      else next = Math.min(next, FLUSH_DELAY_MS - idle);
    }
    if (next !== Infinity) this.scheduleFlush(next);
  }

  /** Writes one recipient's in-memory batch as one row (RELAY-08). */
  private async flush(recipient: string): Promise<void> {
    const b = this.batches.get(recipient);
    if (!b) return;
    this.batches.delete(recipient);
    if (!this.roomExists() || !this.members().has(recipient)) return;
    const blob = encodeBatch(b.frames);
    let total = this.store.one<{ n: number }>(
      "SELECT COALESCE(SUM(length(frames)), 0) AS n FROM buffered",
    )!.n;
    let dropped = 0;
    if (total + blob.length > this.bufferLimitBytes) {
      // Drop the oldest buffered dictations whole: rows up to and including one that ends a
      // dictation, and only then check the fit again, so no dictation is left without its start.
      const rows = this.store.exec<{ id: number; frames: ArrayBuffer }>(
        "SELECT id, frames FROM buffered ORDER BY id",
      );
      let lastDropped: number | null = null;
      const senders = new Set<string>();
      for (const r of rows) {
        lastDropped = r.id;
        dropped++;
        total -= r.frames.byteLength;
        const frames = decodeBatch(r.frames);
        for (const f of frames) senders.add(b64uEncode(f.subarray(2, 18)));
        if (
          frameListEndsDictation(frames) &&
          total + blob.length <= this.bufferLimitBytes
        )
          break;
      }
      // The dropped rows are the oldest ones, so one statement deletes them all.
      if (lastDropped !== null)
        this.store.exec("DELETE FROM buffered WHERE id <= ?", lastDropped);
      // Tell the phones (or the computer) whose frames were thrown away.
      for (const s of senders) {
        for (const ws of this.socketsOf(s))
          this.send(ws, {
            t: "error",
            code: "buffer_full",
            msg: "the relay buffer for this room is full",
          });
      }
    }
    const expires = b.firstAt + BUFFER_TTL_MS;
    this.store.exec(
      "INSERT INTO buffered (recipient_device_id, frames, expires_at) VALUES (?, ?, ?)",
      recipient,
      blob,
      expires,
    );
    this.log(undefined, {
      evt: "buffered",
      frames: b.frames.length,
      bytes: blob.length,
      dropped,
    });
    await this.ensureAlarm(expires);
  }

  /** On connect: stored rows first (oldest first), then the unflushed batch; then delete. */
  private deliverBuffered(ws: WebSocket, id: string): void {
    const now = this.now();
    const rows = this.store.exec<{
      id: number;
      frames: ArrayBuffer;
      expires_at: number;
    }>(
      "SELECT id, frames, expires_at FROM buffered WHERE recipient_device_id = ? ORDER BY id",
      id,
    );
    let count = 0;
    for (const r of rows) {
      if (r.expires_at <= now) continue;
      for (const f of decodeBatch(r.frames)) {
        ws.send(f);
        count++;
      }
    }
    if (rows.length) {
      this.store.exec(
        "DELETE FROM buffered WHERE recipient_device_id = ? AND id <= ?",
        id,
        rows[rows.length - 1]!.id,
      );
    }
    const b = this.batches.get(id);
    if (b) {
      this.batches.delete(id);
      for (const f of b.frames) {
        if (b.firstAt + BUFFER_TTL_MS <= now) break;
        ws.send(f);
        count++;
      }
    }
    if (count) this.log(this.att(ws).rm, { evt: "delivered", frames: count });
  }

  // ---------------------------------------------------------------- housekeeping (RELAY-12)

  /** First moment a device seen on `day` has been unseen for more than 90 days. */
  private deviceExpiry(day: number): number {
    return (day + DEVICE_TTL_DAYS + 1) * DAY_MS;
  }

  private async ensureAlarm(at: number): Promise<void> {
    if (this.alarmAt === undefined)
      this.alarmAt = await this.ctx.storage.getAlarm();
    if (this.alarmAt === null || at < this.alarmAt) {
      this.alarmAt = at;
      await this.ctx.storage.setAlarm(at);
      this.store.alarmWrites++;
    }
  }

  async alarm(): Promise<void> {
    this.alarmAt = null;
    if (!this.roomExists()) return;
    const now = this.now();
    const today = this.today();
    const roomB64 = this.ctx.getWebSockets().map((w) => this.att(w).rm)[0];
    // Devices that are connected right now count as seen.
    for (const m of this.members().values()) {
      if (m.lastSeenDay !== today && this.isOnline(m.id)) {
        this.store.exec(
          "UPDATE devices SET last_seen_day = ? WHERE device_id = ?",
          today,
          m.id,
        );
        m.lastSeenDay = today;
      }
    }
    this.store.exec("DELETE FROM admissions WHERE expires_at <= ?", now);
    this.store.exec("DELETE FROM buffered WHERE expires_at <= ?", now);
    const members = [...this.members().values()];
    const owner = members.find((m) => m.role === "owner");
    if (!owner || today - owner.lastSeenDay > DEVICE_TTL_DAYS) {
      await this.destroy(roomB64 ?? "", "housekeeping");
      return;
    }
    for (const m of members) {
      if (m.role === "phone" && today - m.lastSeenDay > DEVICE_TTL_DAYS) {
        const sockets = this.socketsOf(m.id);
        this.removePhone(m.id);
        this.queueOwnerEvent("member_left", { id: m.id });
        for (const s of sockets)
          this.closeSocket(s, CloseCode.NotAuthorised, "removed");
        this.log(roomB64, { evt: "expired_phone" });
      }
    }
    await this.scheduleNextAlarm();
  }

  private async scheduleNextAlarm(): Promise<void> {
    const candidates: number[] = [];
    const adm = this.store.one<{ t: number | null }>(
      "SELECT MIN(expires_at) AS t FROM admissions",
    )!.t;
    if (adm !== null) candidates.push(adm);
    const buf = this.store.one<{ t: number | null }>(
      "SELECT MIN(expires_at) AS t FROM buffered",
    )!.t;
    if (buf !== null) candidates.push(buf);
    for (const m of this.members().values())
      candidates.push(this.deviceExpiry(m.lastSeenDay));
    if (candidates.length === 0) return;
    this.alarmAt = Math.min(...candidates);
    await this.ctx.storage.setAlarm(this.alarmAt);
    this.store.alarmWrites++;
  }

  // ---------------------------------------------------------------- test hooks

  pendingBatchCount(): number {
    return this.batches.size;
  }

  /** Marks a device's sockets as just heard from on the relay clock (tests shift the clock). */
  markAliveForTest(deviceId: string): void {
    for (const ws of this.socketsOf(deviceId))
      this.liveOf(ws).lastMsgAt = this.now();
  }

  /** JSON size of the largest attachment this object can create. */
  worstCaseAttachmentSize(): number {
    const pending: Attachment = {
      v: 1,
      st: "p",
      rm: "A".repeat(22),
      in: "create",
      ch: "A".repeat(43),
      at: Number.MAX_SAFE_INTEGER,
    };
    const authed: Attachment = {
      v: 1,
      st: "a",
      rm: "A".repeat(22),
      in: "create",
      at: Number.MAX_SAFE_INTEGER,
      id: "A".repeat(22),
      ro: "owner",
    };
    return Math.max(
      JSON.stringify(pending).length,
      JSON.stringify(authed).length,
    );
  }
}
