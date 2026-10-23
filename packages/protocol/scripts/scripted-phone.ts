#!/usr/bin/env bun
/**
 * A scripted phone on top of @walkietalkey/protocol, for integration and smoke tests.
 *
 * Library: `ScriptedPhone` (pair, connect, stream a WAV, resend, presence, leave).
 * CLI:
 *   bun scripts/scripted-phone.ts stream --url '<pairing url>' --wav file.wav [--fps 5] [--name X] [--insecure-localhost]
 *   bun scripts/scripted-phone.ts --stdio [--insecure-localhost]     JSON lines on stdin/stdout (see README in PROTOCOL.md)
 * Works with bun, and with Node 22.18+ (`node scripts/scripted-phone.ts ...`).
 */
import {
  BLOCK_MS,
  CloseCode,
  MAX_BLOCKS_PER_FRAME,
  MAX_RESEND_FRAMES_PER_SECOND,
  MemoryCounterStore,
  PairChannel,
  ProtocolError,
  SAMPLE_RATE,
  b64uDecode,
  b64uEncode,
  computeJoinMac,
  concatBytes,
  decodePairingUrl,
  derivePairKeys,
  generateDeviceKeys,
  randomBytes,
  roomSocketUrl,
  signChallenge,
  type DeviceKeys,
  type DevicePayload,
  type MemberInfo,
  type PairingPayload,
  type ResultReason,
} from "../src/index.ts";
import { RelaySocket, SocketClosedError, type Incoming } from "./relay-socket.ts";
import { parseWav, splitBlocks } from "./wav.ts";

export type PhoneEvent = { event: string } & Record<string, unknown>;

export interface ScriptedPhoneOptions {
  name?: string;
  platform?: string;
  allowInsecureLocalhost?: boolean;
  onEvent?: (e: PhoneEvent) => void;
}

export interface PhoneResult {
  ok: boolean;
  reason?: ResultReason;
}

interface Session {
  id: Uint8Array;
  blocks: Uint8Array[];
  durationMs: number;
}

/** PHONE-32: pack up to 10 blocks (2 s) per frame for a resend. */
export function packResend(blocks: Uint8Array[]): { firstIndex: number; pcm: Uint8Array }[] {
  const out: { firstIndex: number; pcm: Uint8Array }[] = [];
  for (let i = 0; i < blocks.length; i += MAX_BLOCKS_PER_FRAME) {
    out.push({ firstIndex: i, pcm: concatBytes(...blocks.slice(i, i + MAX_BLOCKS_PER_FRAME)) });
  }
  return out;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The relay said this pairing is gone (PHONE-14). */
export class RemovedError extends Error {
  readonly code: number;
  constructor(code: number) {
    super(`pairing removed (${code})`);
    this.name = "RemovedError";
    this.code = code;
  }
}

export class ScriptedPhone {
  readonly keys: DeviceKeys;
  readonly options: ScriptedPhoneOptions;
  pairing: PairingPayload | null = null;
  computerId: Uint8Array | null = null;
  channel: PairChannel | null = null;
  socket: RelaySocket | null = null;
  ownerOnline = false;
  lastClose: { code: number; reason: string } | null = null;
  private readonly store = new MemoryCounterStore();
  private readonly sessions = new Map<string, Session>();
  private readonly results = new Map<string, PhoneResult>();
  private readonly presence: { secondsSinceInput: number; locked: boolean }[] = [];
  private waiters: Array<() => void> = [];

  private constructor(keys: DeviceKeys, options: ScriptedPhoneOptions) {
    this.keys = keys;
    this.options = options;
  }

  static async create(options: ScriptedPhoneOptions = {}): Promise<ScriptedPhone> {
    return new ScriptedPhone(await generateDeviceKeys(), options);
  }

  get deviceId(): string {
    return b64uEncode(this.keys.deviceId);
  }

  private emit(e: PhoneEvent): void {
    this.options.onEvent?.(e);
  }

  private wake(): void {
    for (const w of this.waiters.splice(0)) w();
  }

  private async waitFor<T>(get: () => T | undefined, what: string, timeoutMs: number): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const v = get();
      if (v !== undefined) return v;
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`timed out waiting for ${what}`);
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, Math.min(left, 250));
        this.waiters.push(() => {
          clearTimeout(t);
          resolve();
        });
      });
    }
  }

  private socketUrl(intent: "auth" | "join"): string {
    const p = this.pairing!;
    return roomSocketUrl(p.u, p.r, intent);
  }

  private async challenge(socket: RelaySocket): Promise<Uint8Array> {
    return b64uDecode((await socket.control("challenge")).n, 32);
  }

  /** Scans the pairing QR URL, joins the room, derives the pair keys, sends device_info. */
  async pair(url: string): Promise<void> {
    this.pairing = decodePairingUrl(url, { allowInsecureLocalhost: this.options.allowInsecureLocalhost });
    const p = this.pairing;
    const socket = await RelaySocket.open(this.socketUrl("join"));
    let members: MemberInfo[];
    try {
      const ch = await this.challenge(socket);
      const sig = await signChallenge(this.keys.signing.privateKey, "wt-join-v1", p.r, ch);
      const mac = await computeJoinMac(p.s, p.r, this.keys.signingSpki, this.keys.agreementSpki);
      socket.sendControl({
        t: "join",
        a: b64uEncode(p.a),
        pub: b64uEncode(this.keys.signingSpki),
        agree: b64uEncode(this.keys.agreementSpki),
        mac: b64uEncode(mac),
        sig: b64uEncode(sig),
      });
      members = (await socket.control("ok")).members;
    } catch (e) {
      socket.close();
      if (e instanceof SocketClosedError && e.code === CloseCode.NotAuthorised) {
        // The join may have succeeded with its answer lost; a member can simply authenticate.
        await this.connect();
        await this.sendDeviceInfo();
        return;
      }
      throw e;
    }
    await this.deriveFromOwner(members);
    this.adopt(socket, members);
    this.emit({ event: "paired", deviceId: this.deviceId, computerId: b64uEncode(this.computerId!) });
    await this.sendDeviceInfo();
  }

  /** The computer's device id comes from the member list; then both direction keys. */
  private async deriveFromOwner(members: MemberInfo[]): Promise<void> {
    const owner = members.find((m) => m.role === "owner");
    if (!owner) throw new Error("room has no owner");
    this.computerId = b64uDecode(owner.id, 16);
    const p = this.pairing!;
    const keys = await derivePairKeys({
      agreementPrivateKey: this.keys.agreement.privateKey,
      peerAgreementSpki: p.e,
      secret: p.s,
      roomId: p.r,
      computerId: this.computerId,
      phoneId: this.keys.deviceId,
    });
    this.channel = await PairChannel.open({
      role: "phone",
      selfId: this.keys.deviceId,
      peerId: this.computerId,
      keys,
      store: this.store,
    });
  }

  private adopt(socket: RelaySocket, members: MemberInfo[]): void {
    this.socket = socket;
    this.ownerOnline = members.some((m) => m.role === "owner" && m.online);
    socket.onMessage = (m) => this.incoming(m);
    socket.onClose = (code, reason) => {
      this.lastClose = { code, reason };
      this.emit({ event: "closed", code, reason });
      if (code === CloseCode.NotAuthorised || code === CloseCode.RoomNotFound) this.emit({ event: "removed", code });
      this.wake();
    };
    // Anything that arrived before the handler was attached.
    for (const m of socket.queue.splice(0)) if (!this.incoming(m)) socket.queue.push(m);
    socket.startPing();
  }

  /** Authenticates on a new socket (after a reconnect). Throws RemovedError on 4401/4404. */
  async connect(): Promise<void> {
    if (!this.pairing) throw new Error("not paired");
    const socket = await RelaySocket.open(this.socketUrl("auth"));
    let members: MemberInfo[];
    try {
      const ch = await this.challenge(socket);
      const sig = await signChallenge(this.keys.signing.privateKey, "wt-auth-v1", this.pairing.r, ch);
      socket.sendControl({ t: "auth", id: this.deviceId, sig: b64uEncode(sig) });
      members = (await socket.control("ok")).members;
    } catch (e) {
      socket.close();
      if (e instanceof SocketClosedError && (e.code === CloseCode.NotAuthorised || e.code === CloseCode.RoomNotFound)) {
        this.lastClose = { code: e.code, reason: e.reason };
        this.emit({ event: "removed", code: e.code });
        throw new RemovedError(e.code);
      }
      throw e;
    }
    if (!this.channel) await this.deriveFromOwner(members);
    this.adopt(socket, members);
    this.emit({ event: "connected", ownerOnline: this.ownerOnline });
  }

  /** Reconnects and (PHONE-32) resends every session that has no result yet. */
  async reconnect(resend = true): Promise<void> {
    this.socket?.close();
    await this.connect();
    if (resend) for (const s of this.sessions.values()) await this.resend(s.id);
  }

  /** Simulates the phone's network dropping (the socket goes away without leave). */
  drop(): void {
    this.socket?.close(4000, "simulated drop");
  }

  private incoming(m: Incoming): boolean {
    if (m.kind === "text") {
      if (m.msg?.t === "peer") {
        if (this.computerId && m.msg.id === b64uEncode(this.computerId)) this.ownerOnline = m.msg.online;
        this.emit({ event: "peer", online: m.msg.online });
        return true;
      }
      if (m.msg?.t === "error") this.emit({ event: "relay_error", code: m.msg.code });
      return false;
    }
    void this.openFrame(m.bytes);
    return true;
  }

  private async openFrame(bytes: Uint8Array): Promise<void> {
    if (!this.channel) return;
    let p: DevicePayload;
    try {
      p = await this.channel.open(bytes);
    } catch (e) {
      this.emit({ event: "frame_dropped", code: e instanceof ProtocolError ? e.code : String(e) });
      return;
    }
    if (p.type === "result") {
      const sid = b64uEncode(p.sessionId);
      const r: PhoneResult = p.ok ? { ok: true } : { ok: false, reason: p.reason };
      this.results.set(sid, r);
      // The computer has it; the phone can forget the audio (PHONE-32).
      this.sessions.delete(sid);
      this.emit({ event: "result", sessionId: sid, ...r });
    } else if (p.type === "presence") {
      this.presence.push({ secondsSinceInput: p.secondsSinceInput, locked: p.locked });
      this.emit({ event: "presence", secondsSinceInput: p.secondsSinceInput, locked: p.locked });
    }
    this.wake();
  }

  /** Seals and sends; returns false (and sends nothing) while offline. */
  async send(payload: DevicePayload): Promise<boolean> {
    if (!this.channel) throw new Error("not paired");
    if (!this.socket?.open) return false;
    const frame = await this.channel.seal(payload);
    if (!this.socket?.open) return false;
    this.socket.sendBinary(frame);
    return true;
  }

  async sendDeviceInfo(): Promise<void> {
    await this.send({ type: "device_info", name: this.options.name ?? "Scripted phone", platform: this.options.platform ?? "web" });
  }

  /**
   * Streams PCM16 mono 16 kHz as 200 ms blocks, one frame per block at `framesPerSecond`
   * (5 = real time), then audio_end. `dropAfter` closes the socket after that many blocks; the
   * blocks after it are lost, as on a real phone whose network went away.
   */
  async streamPcm(pcm: Uint8Array, opts: { framesPerSecond?: number; dropAfter?: number } = {}): Promise<string> {
    const fps = opts.framesPerSecond ?? 1000 / BLOCK_MS;
    const blocks = splitBlocks(pcm);
    const id = randomBytes(16);
    const sid = b64uEncode(id);
    const durationMs = Math.round((pcm.length / 2 / SAMPLE_RATE) * 1000);
    this.sessions.set(sid, { id, blocks, durationMs });
    this.emit({ event: "stream_start", sessionId: sid, blocks: blocks.length });
    await this.send({ type: "audio_start", sessionId: id, sampleRate: SAMPLE_RATE, codec: "pcm16" });
    const t0 = Date.now();
    for (let i = 0; i < blocks.length; i++) {
      const due = t0 + ((i + 1) * 1000) / fps;
      const wait = due - Date.now();
      if (wait > 0) await sleep(wait);
      await this.send({ type: "audio_chunk", sessionId: id, firstIndex: i, pcm: blocks[i]! });
      if (opts.dropAfter !== undefined && i + 1 === opts.dropAfter) this.drop();
    }
    await this.send({ type: "audio_end", sessionId: id, chunks: blocks.length, durationMs });
    this.emit({ event: "stream_end", sessionId: sid });
    return sid;
  }

  async streamWav(wav: Uint8Array, opts: { framesPerSecond?: number; dropAfter?: number } = {}): Promise<string> {
    return this.streamPcm(parseWav(wav).pcm, opts);
  }

  /** PHONE-32: the whole session again, up to 10 blocks per frame, at most 25 frames per second. */
  async resend(sessionId: Uint8Array | string): Promise<void> {
    const sid = typeof sessionId === "string" ? sessionId : b64uEncode(sessionId);
    const s = this.sessions.get(sid);
    if (!s) return;
    const gap = 1000 / MAX_RESEND_FRAMES_PER_SECOND;
    await this.send({ type: "audio_start", sessionId: s.id, sampleRate: SAMPLE_RATE, codec: "pcm16" });
    for (const f of packResend(s.blocks)) {
      await sleep(gap);
      await this.send({ type: "audio_chunk", sessionId: s.id, firstIndex: f.firstIndex, pcm: f.pcm });
    }
    await sleep(gap);
    await this.send({ type: "audio_end", sessionId: s.id, chunks: s.blocks.length, durationMs: s.durationMs });
    this.emit({ event: "resent", sessionId: sid, frames: Math.ceil(s.blocks.length / MAX_BLOCKS_PER_FRAME) });
  }

  async cancel(sessionId: string): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    await this.send({ type: "audio_cancel", sessionId: s.id });
    this.sessions.delete(sessionId);
  }

  async waitResult(sessionId: string, timeoutMs = 30_000): Promise<PhoneResult> {
    return this.waitFor(() => this.results.get(sessionId), `result for ${sessionId}`, timeoutMs);
  }

  /** PHONE-40: asks the computer; null if no answer within the time. */
  async presenceQuery(timeoutMs = 1000): Promise<{ secondsSinceInput: number; locked: boolean } | null> {
    const before = this.presence.length;
    await this.send({ type: "presence_query" });
    try {
      return await this.waitFor(() => this.presence[before], "presence", timeoutMs);
    } catch {
      return null;
    }
  }

  /** Removes the pairing from the phone's side (relay `leave`). */
  async leave(): Promise<void> {
    if (!this.socket?.open) await this.connect();
    this.socket!.sendControl({ t: "leave" });
    await this.socket!.closed();
  }

  async waitClosed(timeoutMs = 10_000): Promise<{ code: number; reason: string }> {
    if (!this.socket) throw new Error("no socket");
    return this.socket.closed(timeoutMs);
  }

  close(): void {
    this.socket?.close();
  }
}

// ---------------------------------------------------------------- CLI

function arg(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function print(obj: unknown): void {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

async function readFileBytes(path: string): Promise<Uint8Array> {
  const fs = await import("node:fs/promises");
  return new Uint8Array(await fs.readFile(path));
}

async function stdioMode(insecure: boolean, name: string | undefined): Promise<void> {
  const phone = await ScriptedPhone.create({ allowInsecureLocalhost: insecure, name, onEvent: (e) => print(e) });
  print({ event: "ready", deviceId: phone.deviceId });
  const readline = await import("node:readline");
  const rl = readline.createInterface({ input: process.stdin });
  // Commands run one at a time, in order.
  let chain: Promise<void> = Promise.resolve();
  rl.on("line", (line) => {
    if (!line.trim()) return;
    chain = chain.then(async () => {
      let cmd: Record<string, unknown>;
      try {
        cmd = JSON.parse(line) as Record<string, unknown>;
      } catch {
        print({ reply: "?", ok: false, error: "bad JSON" });
        return;
      }
      const reply = (extra: Record<string, unknown>) => print({ reply: cmd.cmd, id: cmd.id ?? null, ...extra });
      try {
        switch (cmd.cmd) {
          case "pair":
            await phone.pair(String(cmd.url));
            return reply({ ok: true, deviceId: phone.deviceId, computerId: b64uEncode(phone.computerId!) });
          case "connect":
            await phone.connect();
            return reply({ ok: true, ownerOnline: phone.ownerOnline });
          case "stream": {
            const wav = await readFileBytes(String(cmd.wav));
            const sid = await phone.streamWav(wav, {
              framesPerSecond: typeof cmd.fps === "number" ? cmd.fps : undefined,
              dropAfter: typeof cmd.dropAfter === "number" ? cmd.dropAfter : undefined,
            });
            return reply({ ok: true, sessionId: sid });
          }
          case "resend":
            await phone.resend(String(cmd.sessionId));
            return reply({ ok: true });
          case "reconnect":
            await phone.reconnect(cmd.resend !== false);
            return reply({ ok: true });
          case "drop":
            phone.drop();
            await phone.waitClosed();
            return reply({ ok: true });
          case "wait_result": {
            const r = await phone.waitResult(String(cmd.sessionId), typeof cmd.timeoutMs === "number" ? cmd.timeoutMs : 30_000);
            return reply({ ok: true, result: r });
          }
          case "presence":
            return reply({ ok: true, presence: await phone.presenceQuery(typeof cmd.timeoutMs === "number" ? cmd.timeoutMs : 1000) });
          case "leave":
            await phone.leave();
            return reply({ ok: true });
          case "wait_closed": {
            const c = await phone.waitClosed(typeof cmd.timeoutMs === "number" ? cmd.timeoutMs : 10_000);
            return reply({ ok: true, code: c.code });
          }
          case "quit":
            reply({ ok: true });
            phone.close();
            process.exit(0);
            return;
          default:
            return reply({ ok: false, error: "unknown command" });
        }
      } catch (e) {
        const code = e instanceof RemovedError ? e.code : e instanceof SocketClosedError ? e.code : undefined;
        reply({ ok: false, error: e instanceof Error ? e.message : String(e), code });
      }
    });
  });
  rl.on("close", () => {
    void chain.then(() => {
      phone.close();
      process.exit(0);
    });
  });
}

async function streamMode(args: string[], insecure: boolean): Promise<void> {
  const url = arg(args, "--url");
  const wavPath = arg(args, "--wav");
  if (!url || !wavPath) {
    console.error("usage: scripted-phone.ts stream --url '<pairing url>' --wav file.wav [--fps 5] [--name X] [--insecure-localhost]");
    process.exit(2);
  }
  const fps = arg(args, "--fps");
  const phone = await ScriptedPhone.create({ allowInsecureLocalhost: insecure, name: arg(args, "--name"), onEvent: (e) => print(e) });
  await phone.pair(url);
  const sid = await phone.streamWav(await readFileBytes(wavPath), { framesPerSecond: fps ? Number(fps) : undefined });
  const result = await phone.waitResult(sid, 60_000);
  print({ event: "done", sessionId: sid, ...result });
  phone.close();
  process.exit(result.ok ? 0 : 1);
}

const isMain = (() => {
  const entry = process.argv[1] ?? "";
  return entry.endsWith("scripted-phone.ts") || entry.endsWith("scripted-phone.js");
})();

if (isMain) {
  const args = process.argv.slice(2);
  const insecure = args.includes("--insecure-localhost");
  const run = args.includes("--stdio") ? stdioMode(insecure, arg(args, "--name")) : args[0] === "stream" ? streamMode(args, insecure) : null;
  if (!run) {
    console.error("usage: scripted-phone.ts --stdio | stream --url ... --wav ...");
    process.exit(2);
  }
  run.catch((e) => {
    print({ event: "fatal", error: e instanceof Error ? e.message : String(e) });
    process.exit(1);
  });
}

