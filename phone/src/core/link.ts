/**
 * One phone socket per paired room (spec 8.2, PROTOCOL.md 5 to 7): authenticate, keep alive with
 * the exact ping, reconnect with backoff, follow the computer's `peer` status, and carry the
 * encrypted device frames through a PairChannel. 4401 or 4404 means the pairing is gone (PHONE-14).
 */
import {
  CloseCode,
  ExtraCloseCode,
  PING_INTERVAL_MS,
  PING_MESSAGE,
  PairChannel,
  b64uDecode,
  b64uEncode,
  computeJoinMac,
  parseControlMessage,
  roomSocketUrl,
  serializeControlMessage,
  signChallenge,
  type ControlMessage,
  type CounterStore,
  type DeviceKeys,
  type DevicePayload,
  type MemberInfo,
  type PairKeys,
  type PairingPayload,
} from "@walkietalkey/protocol";
import type { StreamLink } from "./streamer";

export type WebSocketCtor = new (url: string) => WebSocket;

/** Why a handshake failed: the close code (0 for a timeout or a network error) and the relay's error code. */
export class HandshakeError extends Error {
  readonly code: number;
  readonly relayCode: string | null;
  constructor(code: number, relayCode: string | null, message: string) {
    super(message);
    this.name = "HandshakeError";
    this.code = code;
    this.relayCode = relayCode;
  }
}

export interface Handshake {
  ws: WebSocket;
  members: MemberInfo[];
  /** Messages that arrived after `ok`, before the caller took over the socket. */
  early: Array<string | ArrayBuffer>;
}

/**
 * Opens a socket and answers the relay's challenge with `answer(challenge)`; resolves on `ok`.
 * The socket's handlers are left queueing until the caller replaces them.
 */
export function handshake(
  WS: WebSocketCtor,
  url: string,
  answer: (challenge: Uint8Array) => Promise<ControlMessage>,
  timeoutMs = 15_000,
): Promise<Handshake> {
  return new Promise((resolve, reject) => {
    let ws: WebSocket;
    try {
      ws = new WS(url);
    } catch (e) {
      reject(
        new HandshakeError(
          0,
          null,
          e instanceof Error ? e.message : "cannot open socket",
        ),
      );
      return;
    }
    ws.binaryType = "arraybuffer";
    const early: Array<string | ArrayBuffer> = [];
    let relayCode: string | null = null;
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        ws.close(4000, "handshake timeout");
      } catch {
        /* closed */
      }
      reject(new HandshakeError(0, null, "handshake timed out"));
    }, timeoutMs);
    ws.onmessage = (ev: MessageEvent) => {
      if (settled) {
        early.push(ev.data as string | ArrayBuffer);
        return;
      }
      if (typeof ev.data !== "string") return;
      let msg: ControlMessage;
      try {
        msg = parseControlMessage(ev.data);
      } catch {
        return;
      }
      if (msg.t === "challenge") {
        answer(b64uDecode(msg.n, 32)).then(
          (reply) => {
            if (!settled && ws.readyState === WebSocket.OPEN)
              ws.send(serializeControlMessage(reply));
          },
          () => ws.close(4000, "cannot answer"),
        );
      } else if (msg.t === "ok") {
        settled = true;
        clearTimeout(timer);
        resolve({ ws, members: msg.members, early });
      } else if (msg.t === "error") {
        relayCode = msg.code;
      }
    };
    ws.onclose = (ev: CloseEvent) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new HandshakeError(ev.code, relayCode, `closed with ${ev.code}`));
    };
  });
}

export function authHandshake(
  WS: WebSocketCtor,
  relayUrl: string,
  roomId: Uint8Array,
  device: DeviceKeys,
  timeoutMs?: number,
): Promise<Handshake> {
  return handshake(
    WS,
    roomSocketUrl(relayUrl, roomId, "auth"),
    async (n) => ({
      t: "auth",
      id: b64uEncode(device.deviceId),
      sig: b64uEncode(
        await signChallenge(device.signing.privateKey, "wt-auth-v1", roomId, n),
      ),
    }),
    timeoutMs,
  );
}

export type JoinFailure = "expired" | "full" | "network" | "error";

export class JoinError extends Error {
  readonly kind: JoinFailure;
  readonly detail: string;
  constructor(kind: JoinFailure, detail: string) {
    super(`${kind}: ${detail}`);
    this.name = "JoinError";
    this.kind = kind;
    this.detail = detail;
  }
}

/** spec 5.3 step 4: join with `a`, both public keys and the join MAC. */
export async function joinRoom(
  WS: WebSocketCtor,
  p: PairingPayload,
  device: DeviceKeys,
  timeoutMs = 15_000,
): Promise<Handshake> {
  try {
    return await handshake(
      WS,
      roomSocketUrl(p.u, p.r, "join"),
      async (n) => ({
        t: "join",
        a: b64uEncode(p.a),
        pub: b64uEncode(device.signingSpki),
        agree: b64uEncode(device.agreementSpki),
        mac: b64uEncode(
          await computeJoinMac(
            p.s,
            p.r,
            device.signingSpki,
            device.agreementSpki,
          ),
        ),
        sig: b64uEncode(
          await signChallenge(device.signing.privateKey, "wt-join-v1", p.r, n),
        ),
      }),
      timeoutMs,
    );
  } catch (e) {
    if (!(e instanceof HandshakeError)) throw new JoinError("error", String(e));
    if (e.code === CloseCode.NotAuthorised) {
      // PROTOCOL.md 7.3: the join may have succeeded with its `ok` lost; a member can authenticate.
      try {
        return await authHandshake(WS, p.u, p.r, device, timeoutMs);
      } catch (e2) {
        const code = e2 instanceof HandshakeError ? e2.code : 0;
        if (code === CloseCode.NotAuthorised || code === CloseCode.RoomNotFound)
          throw new JoinError("expired", e.relayCode ?? "admission_invalid");
        throw new JoinError(
          "network",
          e2 instanceof Error ? e2.message : String(e2),
        );
      }
    }
    if (e.code === CloseCode.RoomNotFound)
      throw new JoinError("expired", "room_not_found");
    if (e.relayCode === "room_full") throw new JoinError("full", "room_full");
    if (e.code === 0 || e.code === 1006)
      throw new JoinError("network", e.message);
    throw new JoinError("error", e.relayCode ?? `close ${e.code}`);
  }
}

export type LinkEvent =
  | { type: "status"; connected: boolean }
  | { type: "peer"; online: boolean }
  | { type: "payload"; payload: DevicePayload }
  | { type: "removed"; code: number }
  | { type: "relay_error"; code: string }
  | { type: "authenticated"; connId: number };

export interface LinkRoom {
  roomId: string;
  relayUrl: string;
  computerId: string;
  keys: PairKeys;
}

export interface LinkOptions {
  room: LinkRoom;
  device: DeviceKeys;
  store: CounterStore;
  onEvent: (e: LinkEvent) => void;
  WebSocketImpl?: WebSocketCtor;
  /** Reconnect delays (DESK-60's schedule). */
  backoffMs?: number[];
  pingIntervalMs?: number;
  pongTimeoutMs?: number;
}

const DEFAULT_BACKOFF = [1000, 2000, 5000, 10_000, 30_000];
/**
 * Back in the foreground, a socket that still counts as connected must answer a ping this fast,
 * or it is given up and replaced at once (iOS suspends home-screen apps; their sockets can die
 * without the page noticing).
 */
export const FOREGROUND_PONG_TIMEOUT_MS = 1500;

export class RoomLink implements StreamLink {
  readonly room: LinkRoom;
  connId = 0;
  connected = false;
  peerOnline = false;
  removed = false;
  /**
   * The latest connection check has an outcome: an authentication, a failed attempt, or a pong.
   * reconnectNow() starts a new check (for the foreground target choice, PHONE-40).
   */
  settled = false;
  private readonly opts: LinkOptions;
  private readonly WS: WebSocketCtor;
  private ws: WebSocket | null = null;
  private connecting = false;
  private stopped = true;
  private attempt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;
  private channel: Promise<PairChannel> | null = null;
  private sendChain: Promise<unknown> = Promise.resolve();
  private recvChain: Promise<unknown> = Promise.resolve();
  private leaving: (() => void) | null = null;
  private settledWaiters: Array<() => void> = [];

  constructor(opts: LinkOptions) {
    this.opts = opts;
    this.room = opts.room;
    this.WS = opts.WebSocketImpl ?? WebSocket;
  }

  private emit(e: LinkEvent): void {
    this.opts.onEvent(e);
  }

  private get computerId(): string {
    return this.room.computerId;
  }

  private getChannel(): Promise<PairChannel> {
    this.channel ??= PairChannel.open({
      role: "phone",
      selfId: this.opts.device.deviceId,
      peerId: b64uDecode(this.computerId, 16),
      keys: this.room.keys,
      store: this.opts.store,
    });
    return this.channel;
  }

  start(): void {
    if (this.removed) return;
    this.stopped = false;
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.clearRetry();
    this.stopPing();
    const ws = this.ws;
    this.ws = null;
    if (this.connected) {
      this.connected = false;
      this.emit({ type: "status", connected: false });
    }
    try {
      ws?.close(1000, "bye");
    } catch {
      /* closed */
    }
  }

  /** Resolves once the latest connection check has an outcome, or after `timeoutMs`. */
  whenSettled(timeoutMs: number): Promise<void> {
    if (this.settled || this.removed) return Promise.resolve();
    return new Promise((resolve) => {
      const t = setTimeout(resolve, timeoutMs);
      this.settledWaiters.push(() => {
        clearTimeout(t);
        resolve();
      });
    });
  }

  private markSettled(): void {
    this.settled = true;
    for (const w of this.settledWaiters.splice(0)) w();
  }

  /**
   * Back in the foreground or back online: reconnect now, or check that the socket still lives.
   * whenSettled() then waits for this check, not for an earlier one.
   */
  reconnectNow(): void {
    if (this.stopped || this.removed) return;
    this.settled = false;
    if (this.connected) {
      this.checkAlive(FOREGROUND_PONG_TIMEOUT_MS, true);
      return;
    }
    this.clearRetry();
    void this.connect();
  }

  /** Takes over a socket that is already authenticated (right after a join). */
  adopt(h: Handshake): void {
    this.stopped = false;
    this.attach(h);
  }

  private async connect(): Promise<void> {
    if (this.stopped || this.removed || this.ws || this.connecting) return;
    this.connecting = true;
    try {
      const h = await authHandshake(
        this.WS,
        this.room.relayUrl,
        b64uDecode(this.room.roomId, 16),
        this.opts.device,
      );
      if (this.stopped) {
        h.ws.close(1000, "bye");
        return;
      }
      this.attach(h);
    } catch (e) {
      const code = e instanceof HandshakeError ? e.code : 0;
      this.markSettled();
      if (code === CloseCode.NotAuthorised || code === CloseCode.RoomNotFound) {
        this.removed = true;
        this.emit({ type: "removed", code });
        return;
      }
      this.scheduleRetry();
    } finally {
      this.connecting = false;
    }
  }

  private attach(h: Handshake): void {
    const ws = h.ws;
    this.ws = ws;
    this.attempt = 0;
    this.connId++;
    this.connected = true;
    const owner =
      h.members.find((m) => m.id === this.computerId) ??
      h.members.find((m) => m.role === "owner");
    this.peerOnline = !!owner?.online;
    ws.onmessage = (ev: MessageEvent) =>
      this.incoming(ws, ev.data as string | ArrayBuffer);
    ws.onclose = (ev: CloseEvent) => this.closed(ws, ev.code);
    this.startPing();
    this.markSettled();
    this.emit({ type: "status", connected: true });
    this.emit({ type: "peer", online: this.peerOnline });
    this.emit({ type: "authenticated", connId: this.connId });
    for (const m of h.early.splice(0)) this.incoming(ws, m);
  }

  private incoming(ws: WebSocket, data: string | ArrayBuffer): void {
    if (ws !== this.ws) return;
    if (typeof data !== "string") {
      const bytes = new Uint8Array(data);
      this.recvChain = this.recvChain.then(async () => {
        try {
          const payload = await (await this.getChannel()).open(bytes);
          this.emit({ type: "payload", payload });
        } catch {
          // PROTOCOL.md 8.1: failed frames are dropped silently.
        }
      });
      return;
    }
    let msg: ControlMessage;
    try {
      msg = parseControlMessage(data);
    } catch {
      return;
    }
    if (msg.t === "pong") {
      if (this.pongTimer) clearTimeout(this.pongTimer);
      this.pongTimer = null;
      this.markSettled();
    } else if (msg.t === "peer") {
      if (msg.id !== this.computerId) return;
      this.peerOnline = msg.online;
      this.emit({ type: "peer", online: msg.online });
    } else if (msg.t === "error") {
      this.emit({ type: "relay_error", code: msg.code });
    }
  }

  private closed(ws: WebSocket, code: number): void {
    if (ws !== this.ws) return;
    this.ws = null;
    this.stopPing();
    if (this.connected) {
      this.connected = false;
      this.emit({ type: "status", connected: false });
    }
    if (this.leaving) {
      const done = this.leaving;
      this.leaving = null;
      this.stopped = true;
      done();
      return;
    }
    if (code === CloseCode.NotAuthorised || code === CloseCode.RoomNotFound) {
      this.removed = true;
      this.emit({ type: "removed", code });
      return;
    }
    if (code === ExtraCloseCode.Normal && this.stopped) return;
    this.scheduleRetry();
  }

  /** A socket that cannot even close cleanly (a dead network): give up on it and reconnect. */
  private abandon(): void {
    const ws = this.ws;
    if (!ws) return;
    this.closed(ws, 4000);
    try {
      ws.close(4000, "no pong");
    } catch {
      /* closed */
    }
  }

  private scheduleRetry(): void {
    if (this.stopped || this.removed || this.retryTimer) return;
    const backoff = this.opts.backoffMs ?? DEFAULT_BACKOFF;
    const delay = backoff[Math.min(this.attempt, backoff.length - 1)]!;
    this.attempt++;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.connect();
    }, delay);
  }

  private clearRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(
      () => this.checkAlive(),
      this.opts.pingIntervalMs ?? PING_INTERVAL_MS,
    );
  }

  private stopPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.pongTimer) clearTimeout(this.pongTimer);
    this.pingTimer = null;
    this.pongTimer = null;
  }

  /**
   * RELAY-10: the exact ping; no pong in time means the socket is dead. With `reconnectAtOnce`
   * (the foreground check) a dead socket is replaced without waiting for the backoff.
   */
  checkAlive(
    timeoutMs = this.opts.pongTimeoutMs ?? 10_000,
    reconnectAtOnce = false,
  ): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const giveUp = () => {
      this.abandon();
      if (!reconnectAtOnce) return;
      this.clearRetry();
      void this.connect();
    };
    try {
      ws.send(PING_MESSAGE);
    } catch {
      giveUp();
      return;
    }
    // Any pong answers every ping in flight; the latest deadline is the one that counts.
    if (this.pongTimer) clearTimeout(this.pongTimer);
    this.pongTimer = setTimeout(() => {
      this.pongTimer = null;
      if (this.ws === ws) giveUp();
    }, timeoutMs);
  }

  /** Seals and sends in call order (counters must reach the computer in order); false when offline. */
  send(payload: DevicePayload): Promise<boolean> {
    const result = this.sendChain.then(async () => {
      const ws = this.ws;
      if (!ws || !this.connected || ws.readyState !== WebSocket.OPEN)
        return false;
      const frame = await (await this.getChannel()).seal(payload);
      if (this.ws !== ws || ws.readyState !== WebSocket.OPEN) return false;
      ws.send(frame);
      return true;
    });
    const safe = result.catch(() => false);
    this.sendChain = safe;
    return safe;
  }

  /** Settings › Fjern (spec 5.4): `leave` on an authenticated socket; the relay closes it with 1000. */
  async leave(timeoutMs = 5000): Promise<boolean> {
    if (!this.connected || !this.ws) return false;
    const ws = this.ws;
    const closed = new Promise<boolean>((resolve) => {
      const t = setTimeout(() => {
        this.leaving = null;
        resolve(false);
      }, timeoutMs);
      this.leaving = () => {
        clearTimeout(t);
        resolve(true);
      };
    });
    this.clearRetry();
    ws.send(serializeControlMessage({ t: "leave" }));
    const ok = await closed;
    this.stop();
    return ok;
  }
}

/** `leave` for a room without a live socket (best effort; true when the relay has forgotten us). */
export async function leaveOnce(
  WS: WebSocketCtor,
  relayUrl: string,
  roomId: string,
  device: DeviceKeys,
  timeoutMs = 8000,
): Promise<boolean> {
  let h: Handshake;
  try {
    h = await authHandshake(
      WS,
      relayUrl,
      b64uDecode(roomId, 16),
      device,
      timeoutMs,
    );
  } catch (e) {
    const code = e instanceof HandshakeError ? e.code : 0;
    return code === CloseCode.NotAuthorised || code === CloseCode.RoomNotFound;
  }
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      h.ws.close(1000, "bye");
      resolve(false);
    }, timeoutMs);
    h.ws.onclose = (ev: CloseEvent) => {
      clearTimeout(t);
      resolve(ev.code === ExtraCloseCode.Normal);
    };
    h.ws.onmessage = null;
    h.ws.send(serializeControlMessage({ t: "leave" }));
  });
}
