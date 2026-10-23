/**
 * The phone app's brain: rooms and their sockets, the recording state machine and its effects,
 * audio sessions in memory, pairing, removal, and the target computer. React reads it through
 * subscribe/getSnapshot (useSyncExternalStore).
 */
import {
  b64uDecode,
  b64uEncode,
  counterKey,
  derivePairKeys,
  type DeviceKeys,
  type DevicePayload,
  type PairingPayload,
} from "@walkietalkey/protocol";
import type { RecorderLike } from "../audio/recorder";
import { MicDeniedError, MicError } from "../audio/recorder";
import type { Platform } from "../lib/platform";
import { platformTag } from "../lib/platform";
import type { PhoneStorage, RoomRecord, Settings } from "../lib/storage";
import {
  JoinError,
  RoomLink,
  joinRoom,
  leaveOnce,
  type LinkEvent,
  type WebSocketCtor,
} from "./link";
import {
  initialMachine,
  transition,
  type Effect,
  type MachineEvent,
  type MachineState,
  type Mode,
} from "./machine";
import {
  chooseTarget,
  needsPresence,
  type Candidate,
  type PresenceAnswer,
} from "./presence";
import { Pacer } from "./resend";
import {
  SessionStreamer,
  isOpen,
  newSession,
  type AudioSession,
} from "./streamer";

/** PHONE-29: five minutes per recording. */
export const MAX_RECORDING_MS = 5 * 60 * 1000;
/** The countdown starts at 4:45. */
export const COUNTDOWN_FROM_MS = 4 * 60 * 1000 + 45 * 1000;
/** PHONE-24: how long the phone waits for a result before "Nåede ikke frem". */
export const RESULT_TIMEOUT_MS = 10 * 60 * 1000;
/** How long a lost connection may last before the screen says "Ingen forbindelse". */
export const NO_CONNECTION_GRACE_MS = 3000;
/** PHONE-40: how long to wait for presence answers. */
export const PRESENCE_WAIT_MS = 1000;

export interface ComputerView {
  roomId: string;
  name: string;
  os: "mac" | "win";
  deviceName: string;
  connected: boolean;
  online: boolean;
}

export interface Notice {
  id: number;
  kind: "removed";
  computer: string;
}

export type PairingState =
  | { state: "idle" }
  | { state: "joining"; computer: string }
  | {
      state: "error";
      kind: "expired" | "full" | "network" | "error";
      computer: string;
      detail: string;
    };

export interface Snapshot {
  loaded: boolean;
  rooms: ComputerView[];
  target: string | null;
  machine: MachineState;
  settings: Settings;
  notices: Notice[];
  pairing: PairingState;
  /** The target's socket has been down for a while (or the phone is offline). */
  noConnection: boolean;
}

export interface ControllerDeps {
  storage: PhoneStorage;
  platform: Platform;
  recorder: RecorderLike;
  haptic: (kind: "start" | "stop") => void;
  wake: { acquire(): void; release(): void; visible(): void };
  WebSocketImpl?: WebSocketCtor;
  now?: () => number;
  /** Link timings, shortened in tests. */
  backoffMs?: number[];
}

interface RoomEntry {
  record: RoomRecord;
  link: RoomLink;
  streamer: SessionStreamer;
  presenceWaiters: Array<(a: PresenceAnswer) => void>;
}

export class PhoneController {
  private readonly deps: ControllerDeps;
  private readonly now: () => number;
  private device: DeviceKeys | null = null;
  private readonly rooms = new Map<string, RoomEntry>();
  private readonly sessions = new Map<string, AudioSession>();
  private readonly resultTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  private machine: MachineState = initialMachine({
    mode: "hold",
    peerOnline: false,
    connected: false,
  });
  private settings: Settings = { mode: "hold", haptics: true };
  private target: string | null = null;
  private notices: Notice[] = [];
  private noticeId = 0;
  private pairing: PairingState = { state: "idle" };
  private noConnection = false;
  private noConnTimer: ReturnType<typeof setTimeout> | null = null;
  private maxTimer: ReturnType<typeof setTimeout> | null = null;
  private recChain: Promise<unknown> = Promise.resolve();
  private loaded = false;
  private snapshot: Snapshot;
  private readonly listeners = new Set<() => void>();
  private choosing = false;

  constructor(deps: ControllerDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.snapshot = this.buildSnapshot();
  }

  // ------------------------------------------------------------------ store

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getSnapshot = (): Snapshot => this.snapshot;

  private buildSnapshot(): Snapshot {
    return {
      loaded: this.loaded,
      rooms: [...this.rooms.values()]
        .map((r) => ({
          roomId: r.record.roomId,
          name: r.record.computerName,
          os: r.record.os,
          deviceName: r.record.deviceName,
          connected: r.link.connected,
          online: r.link.connected && r.link.peerOnline,
        }))
        .sort((a, b) => a.name.localeCompare(b.name, "da")),
      target: this.target,
      machine: this.machine,
      settings: this.settings,
      notices: this.notices,
      pairing: this.pairing,
      noConnection: this.noConnection,
    };
  }

  private changed(): void {
    this.snapshot = this.buildSnapshot();
    for (const fn of this.listeners) fn();
  }

  // ------------------------------------------------------------------ start

  async init(): Promise<void> {
    const { storage } = this.deps;
    this.settings = await storage.getSettings();
    this.device = await storage.loadOrCreateDeviceKeys();
    for (const record of await storage.listRooms()) this.addRoom(record);
    this.target =
      this.settings.target && this.rooms.has(this.settings.target)
        ? this.settings.target
        : this.lastUsed();
    this.machine = initialMachine({
      mode: this.settings.mode,
      peerOnline: false,
      connected: false,
    });
    this.loaded = true;
    for (const r of this.rooms.values()) r.link.start();
    this.watchConnection();
    this.changed();
    void this.retryPendingLeaves();
    void this.chooseOnForeground();
  }

  private lastUsed(): string | null {
    let best: RoomRecord | null = null;
    for (const r of this.rooms.values())
      if (!best || r.record.lastUsedAt > best.lastUsedAt) best = r.record;
    return best?.roomId ?? null;
  }

  private addRoom(record: RoomRecord): RoomEntry {
    const link = new RoomLink({
      room: record,
      device: this.device!,
      store: this.deps.storage,
      WebSocketImpl: this.deps.WebSocketImpl,
      backoffMs: this.deps.backoffMs,
      onEvent: (e) => this.linkEvent(record.roomId, e),
    });
    const entry: RoomEntry = {
      record,
      link,
      streamer: new SessionStreamer(link, new Pacer()),
      presenceWaiters: [],
    };
    this.rooms.set(record.roomId, entry);
    return entry;
  }

  private async retryPendingLeaves(): Promise<void> {
    const { storage } = this.deps;
    for (const p of await storage.listPendingLeaves()) {
      if (this.rooms.has(p.roomId)) {
        await storage.deletePendingLeave(p.roomId);
        continue;
      }
      if (await leaveOnce(this.WS, p.relayUrl, p.roomId, this.device!))
        await storage.deletePendingLeave(p.roomId);
    }
  }

  private get WS(): WebSocketCtor {
    return this.deps.WebSocketImpl ?? WebSocket;
  }

  // ------------------------------------------------------------------ links

  private linkEvent(roomId: string, e: LinkEvent): void {
    const entry = this.rooms.get(roomId);
    if (!entry) return;
    const isTarget = roomId === this.target;
    switch (e.type) {
      case "status":
        if (isTarget) {
          this.dispatch({ type: "connection", up: e.connected });
          this.watchConnection();
        }
        break;
      case "peer":
        if (isTarget) this.dispatch({ type: "peer", online: e.online });
        break;
      case "authenticated":
        void entry.streamer.resendOpen(this.sessionsOf(roomId));
        break;
      case "payload":
        this.payload(entry, e.payload);
        break;
      case "relay_error":
        if (isTarget) this.dispatch({ type: "relay_error", code: e.code });
        break;
      case "removed":
        void this.dropRoom(roomId, true);
        return;
    }
    this.changed();
  }

  private sessionsOf(roomId: string): AudioSession[] {
    return [...this.sessions.values()]
      .filter((s) => s.roomId === roomId && isOpen(s))
      .sort((a, b) => a.startedAt - b.startedAt);
  }

  private payload(entry: RoomEntry, p: DevicePayload): void {
    if (p.type === "result") {
      const sid = b64uEncode(p.sessionId);
      const s = this.sessions.get(sid);
      if (!s || s.roomId !== entry.record.roomId) return;
      s.result = p.ok ? { ok: true } : { ok: false, reason: p.reason };
      // The computer has it: the audio can go (PHONE-32).
      s.blocks = [];
      this.sessions.delete(sid);
      this.clearResultTimer(sid);
      this.dispatch(
        p.ok
          ? { type: "result", sessionId: sid, ok: true }
          : { type: "result", sessionId: sid, ok: false, reason: p.reason },
      );
    } else if (p.type === "presence") {
      const answer = {
        secondsSinceInput: p.secondsSinceInput,
        locked: p.locked,
      };
      for (const w of entry.presenceWaiters.splice(0)) w(answer);
    }
  }

  /** "Ingen forbindelse. Prøver igen." once the target's socket has been down for a moment. */
  private watchConnection(): void {
    const link = this.target ? this.rooms.get(this.target)?.link : undefined;
    const up = !link || link.connected;
    if (up) {
      if (this.noConnTimer) clearTimeout(this.noConnTimer);
      this.noConnTimer = null;
      this.noConnection = false;
      return;
    }
    if (this.noConnection || this.noConnTimer) return;
    this.noConnTimer = setTimeout(() => {
      this.noConnTimer = null;
      const l = this.target ? this.rooms.get(this.target)?.link : undefined;
      if (l && !l.connected) {
        this.noConnection = true;
        this.changed();
      }
    }, NO_CONNECTION_GRACE_MS);
  }

  // ------------------------------------------------------------------ machine

  private dispatch(e: MachineEvent): void {
    const { state, effects } = transition(this.machine, e);
    this.machine = state;
    for (const fx of effects) this.effect(fx);
    this.changed();
  }

  private effect(fx: Effect): void {
    switch (fx.type) {
      case "start_capture":
        this.startCapture(fx.sessionId);
        break;
      case "finish_capture":
        this.finishCapture(fx.sessionId);
        break;
      case "cancel_capture":
        this.cancelCapture(fx.sessionId);
        break;
      case "haptic":
        if (this.settings.haptics) this.deps.haptic(fx.kind);
        break;
      case "wake_lock":
        if (fx.on) this.deps.wake.acquire();
        else this.deps.wake.release();
        break;
      case "retry": {
        const s = this.sessions.get(fx.sessionId);
        const entry = s ? this.rooms.get(s.roomId) : undefined;
        if (!s || !entry) return;
        this.armResultTimer(s);
        void entry.streamer.retry(s);
        break;
      }
    }
  }

  private pendingSession: AudioSession | null = null;

  private startCapture(sid: string): void {
    const s = this.pendingSession;
    this.pendingSession = null;
    if (!s || s.sid !== sid) return;
    const entry = this.rooms.get(s.roomId);
    if (!entry) return;
    this.sessions.set(sid, s);
    this.trimFailed();
    void entry.streamer.start(s);
    const now = this.now();
    entry.record = { ...entry.record, lastUsedAt: now };
    void this.deps.storage.touchRoom(s.roomId, now).catch(() => undefined);
    if (this.maxTimer) clearTimeout(this.maxTimer);
    this.maxTimer = setTimeout(() => {
      this.maxTimer = null;
      if (this.machine.sessionId === sid)
        this.dispatch({ type: "max_duration" });
    }, MAX_RECORDING_MS);
    this.recChain = this.recChain.then(async () => {
      if (s.cancelled || s.ended) return;
      try {
        await this.deps.recorder.start(
          (block) => void entry.streamer.addBlock(s, block),
        );
      } catch (e) {
        if (this.machine.sessionId !== sid) return;
        if (e instanceof MicDeniedError) this.dispatch({ type: "mic_denied" });
        else
          this.dispatch({
            type: "mic_error",
            detail: e instanceof MicError ? e.detail : "Error",
          });
      }
    });
  }

  private finishCapture(sid: string): void {
    if (this.maxTimer) clearTimeout(this.maxTimer);
    this.maxTimer = null;
    const s = this.sessions.get(sid);
    const entry = s ? this.rooms.get(s.roomId) : undefined;
    if (!s || !entry) return;
    this.recChain = this.recChain.then(async () => {
      await this.deps.recorder.stop();
      if (s.cancelled) return;
      if (s.blocks.length === 0) {
        await entry.streamer.cancel(s);
        this.sessions.delete(sid);
        this.dispatch({ type: "empty", sessionId: sid });
        return;
      }
      await entry.streamer.end(s, this.now());
      this.armResultTimer(s);
    });
  }

  private cancelCapture(sid: string): void {
    if (this.maxTimer) clearTimeout(this.maxTimer);
    this.maxTimer = null;
    this.deps.recorder.abort();
    const s = this.sessions.get(sid);
    if (!s) return;
    this.sessions.delete(sid);
    this.clearResultTimer(sid);
    const entry = this.rooms.get(s.roomId);
    if (entry) void entry.streamer.cancel(s);
    else s.blocks = [];
  }

  private armResultTimer(s: AudioSession): void {
    this.clearResultTimer(s.sid);
    this.resultTimers.set(
      s.sid,
      setTimeout(() => {
        this.resultTimers.delete(s.sid);
        if (!isOpen(s)) return;
        s.failed = true;
        this.dispatch({ type: "timeout", sessionId: s.sid });
      }, RESULT_TIMEOUT_MS),
    );
  }

  private clearResultTimer(sid: string): void {
    const t = this.resultTimers.get(sid);
    if (t) clearTimeout(t);
    this.resultTimers.delete(sid);
  }

  /** Keep at most a few failed recordings in memory (up to 9.6 MB each). */
  private trimFailed(max = 3): void {
    const failed = [...this.sessions.values()]
      .filter((s) => s.failed && s.sid !== this.machine.sessionId)
      .sort((a, b) => a.startedAt - b.startedAt);
    while (failed.length > max) {
      const s = failed.shift()!;
      s.blocks = [];
      s.cancelled = true;
      this.sessions.delete(s.sid);
    }
  }

  // ------------------------------------------------------------------ UI input

  /** First touch anywhere: the AudioContext may only start inside a gesture (PHONE-35). */
  prime(): void {
    try {
      this.deps.recorder.prime();
    } catch {
      /* no audio support; start() reports it */
    }
  }

  down(): void {
    if (!this.target || !this.rooms.has(this.target)) return;
    this.prime();
    const s = newSession(this.target, this.now());
    this.pendingSession = s;
    this.dispatch({ type: "down", sessionId: s.sid, at: this.now() });
    this.pendingSession = null;
  }

  up(): void {
    this.dispatch({ type: "up" });
  }

  /**
   * The iOS shell's "Start diktering" (`wt-shell-start`, or `?start=1` on a cold start): starts a
   * recording as in tap mode. Ignored when not paired or already recording.
   */
  shellStart(): boolean {
    if (!this.target || !this.rooms.has(this.target)) return false;
    this.prime();
    const s = newSession(this.target, this.now());
    this.pendingSession = s;
    this.dispatch({ type: "shell_start", sessionId: s.sid, at: this.now() });
    this.pendingSession = null;
    return this.machine.sessionId === s.sid && this.machine.phase === "rec";
  }

  /** The cancel control of a latched recording (tap mode, Start diktering). */
  cancel(): void {
    this.dispatch({ type: "cancel" });
  }

  /** Stops every socket and timer (tests, and a page that goes away for good). */
  dispose(): void {
    for (const r of this.rooms.values()) r.link.stop();
    for (const t of this.resultTimers.values()) clearTimeout(t);
    this.resultTimers.clear();
    if (this.maxTimer) clearTimeout(this.maxTimer);
    if (this.noConnTimer) clearTimeout(this.noConnTimer);
    this.maxTimer = null;
    this.noConnTimer = null;
  }

  slide(inside: boolean): void {
    if (this.machine.phase !== "rec" && this.machine.phase !== "cancel") return;
    this.dispatch({ type: "slide", inside });
  }

  retry(): void {
    this.dispatch({ type: "retry" });
  }

  // ------------------------------------------------------------------ target

  selectTarget(roomId: string): void {
    if (!this.rooms.has(roomId) || roomId === this.target) return;
    if (this.machine.phase === "rec" || this.machine.phase === "cancel") return;
    this.setTarget(roomId);
  }

  private setTarget(roomId: string | null): void {
    this.target = roomId;
    this.settings = { ...this.settings, target: roomId ?? undefined };
    void this.deps.storage.putSettings(this.settings).catch(() => undefined);
    const link = roomId ? this.rooms.get(roomId)?.link : undefined;
    this.noConnection = false;
    this.dispatch({
      type: "retarget",
      peerOnline: !!link?.peerOnline,
      connected: !!link?.connected,
    });
    this.watchConnection();
  }

  /** Back in the foreground (PHONE-40): check the sockets, then pick the computer you sit at. */
  foreground(): void {
    this.deps.wake.visible();
    this.dispatch({ type: "foreground" });
    for (const r of this.rooms.values()) r.link.reconnectNow();
    void this.chooseOnForeground();
  }

  network(online: boolean): void {
    if (online) for (const r of this.rooms.values()) r.link.reconnectNow();
  }

  private async chooseOnForeground(): Promise<void> {
    if (this.rooms.size < 2 || this.choosing) return;
    this.choosing = true;
    try {
      await Promise.all(
        [...this.rooms.values()].map((r) => r.link.whenSettled(3000)),
      );
      const entries = [...this.rooms.values()];
      const candidates: Candidate[] = entries.map((r) => ({
        roomId: r.record.roomId,
        online: r.link.connected && r.link.peerOnline,
        lastUsedAt: r.record.lastUsedAt,
      }));
      const answers = new Map<string, PresenceAnswer | null>();
      if (needsPresence(candidates)) {
        await Promise.all(
          entries
            .filter((r) => r.link.connected && r.link.peerOnline)
            .map(async (r) =>
              answers.set(r.record.roomId, await this.askPresence(r)),
            ),
        );
      }
      const choice = chooseTarget(candidates, answers);
      const phase = this.machine.phase;
      const busy =
        phase === "rec" ||
        phase === "cancel" ||
        phase === "send" ||
        phase === "offline";
      if (choice && choice !== this.target && !busy) this.setTarget(choice);
    } finally {
      this.choosing = false;
    }
  }

  private async askPresence(r: RoomEntry): Promise<PresenceAnswer | null> {
    const answer = new Promise<PresenceAnswer | null>((resolve) => {
      const t = setTimeout(() => resolve(null), PRESENCE_WAIT_MS);
      r.presenceWaiters.push((a) => {
        clearTimeout(t);
        resolve(a);
      });
    });
    if (!(await r.link.send({ type: "presence_query" }))) return null;
    return answer;
  }

  // ------------------------------------------------------------------ pairing

  /** Spec 5.3 steps 4 to 7 on the phone. */
  async pair(p: PairingPayload, deviceName: string): Promise<boolean> {
    const name = deviceName.trim() || this.deps.platform.device;
    this.pairing = { state: "joining", computer: p.n };
    this.changed();
    const device =
      this.device ?? (await this.deps.storage.loadOrCreateDeviceKeys());
    this.device = device;
    let h;
    try {
      h = await joinRoom(this.WS, p, device);
    } catch (e) {
      const kind = e instanceof JoinError ? e.kind : "error";
      this.pairing = {
        state: "error",
        kind,
        computer: p.n,
        detail: e instanceof JoinError ? e.detail : String(e),
      };
      this.changed();
      return false;
    }
    const owner = h.members.find((m) => m.role === "owner");
    if (!owner) {
      h.ws.close(1000, "bye");
      this.pairing = {
        state: "error",
        kind: "error",
        computer: p.n,
        detail: "no_owner",
      };
      this.changed();
      return false;
    }
    const computerId = b64uDecode(owner.id, 16);
    const keys = await derivePairKeys({
      agreementPrivateKey: device.agreement.privateKey,
      peerAgreementSpki: p.e,
      secret: p.s,
      roomId: p.r,
      computerId,
      phoneId: device.deviceId,
    });
    const roomId = b64uEncode(p.r);
    const old = this.rooms.get(roomId);
    if (old) {
      old.link.stop();
      this.rooms.delete(roomId);
    }
    await this.deps.storage.resetCounters([
      counterKey(device.deviceId, computerId),
      counterKey(computerId, device.deviceId),
    ]);
    const now = this.now();
    const record: RoomRecord = {
      roomId,
      relayUrl: p.u,
      computerName: p.n,
      os: p.o,
      computerId: owner.id,
      keys,
      deviceName: name,
      pairedAt: now,
      lastUsedAt: now,
    };
    await this.deps.storage.putRoom(record);
    const entry = this.addRoom(record);
    entry.link.adopt(h);
    // Step 7: the phone's name, encrypted with the pair key.
    await entry.link.send({
      type: "device_info",
      name,
      platform: platformTag(this.deps.platform),
    });
    this.settings = { ...this.settings, deviceName: name };
    this.pairing = { state: "idle" };
    this.setTarget(roomId);
    return true;
  }

  clearPairingError(): void {
    this.pairing = { state: "idle" };
    this.changed();
  }

  // ------------------------------------------------------------------ removal

  /** Settings › Parrede computere › Fjern: `leave`, then forget the room (spec 5.4). */
  async removeRoom(roomId: string): Promise<void> {
    const entry = this.rooms.get(roomId);
    if (!entry) return;
    let ok = entry.link.connected ? await entry.link.leave() : false;
    if (!ok)
      ok = await leaveOnce(
        this.WS,
        entry.record.relayUrl,
        roomId,
        this.device!,
      );
    if (!ok)
      await this.deps.storage.addPendingLeave({
        roomId,
        relayUrl: entry.record.relayUrl,
      });
    await this.dropRoom(roomId, false);
  }

  /** PHONE-14 (removed on the other side) or after Fjern: drop the room, its keys and its audio. */
  private async dropRoom(roomId: string, notify: boolean): Promise<void> {
    const entry = this.rooms.get(roomId);
    if (!entry) return;
    entry.link.stop();
    this.rooms.delete(roomId);
    for (const s of [...this.sessions.values()]) {
      if (s.roomId !== roomId) continue;
      s.blocks = [];
      s.cancelled = true;
      this.sessions.delete(s.sid);
      this.clearResultTimer(s.sid);
    }
    await this.deps.storage.deleteRoom(roomId);
    if (notify)
      this.notices = [
        ...this.notices,
        {
          id: ++this.noticeId,
          kind: "removed",
          computer: entry.record.computerName,
        },
      ];
    if (this.target === roomId) {
      if (this.machine.phase === "rec" || this.machine.phase === "cancel") {
        this.deps.recorder.abort();
        this.deps.wake.release();
      }
      this.machine = initialMachine({
        mode: this.settings.mode,
        peerOnline: false,
        connected: false,
      });
      this.setTarget(this.lastUsed());
    }
    this.changed();
  }

  dismissNotice(id: number): void {
    this.notices = this.notices.filter((n) => n.id !== id);
    this.changed();
  }

  // ------------------------------------------------------------------ settings

  setMode(mode: Mode): void {
    this.settings = { ...this.settings, mode };
    void this.deps.storage.putSettings(this.settings).catch(() => undefined);
    this.dispatch({ type: "mode", mode });
  }

  setHaptics(on: boolean): void {
    this.settings = { ...this.settings, haptics: on };
    void this.deps.storage.putSettings(this.settings).catch(() => undefined);
    this.changed();
  }

  /** Seconds recorded so far (for the clock). */
  recordedMs(): number {
    return this.machine.recStartedAt === null
      ? 0
      : this.now() - this.machine.recStartedAt;
  }
}
