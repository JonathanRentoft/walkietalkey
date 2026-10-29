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
import { meterLevel } from "../audio/pcm";
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
} from "./machine";
import {
  chooseTarget,
  needsPresence,
  type Candidate,
  type PresenceAnswer,
} from "./presence";
import { Pacer } from "./resend";
import { dayNumber, daysAway, isStale, supersededRooms } from "./stale";
import {
  SessionStreamer,
  isOpen,
  newSession,
  type AudioSession,
} from "./streamer";
import {
  STALE_MS,
  canSkip,
  fromPrompt,
  skipPrompt,
  trainingItem,
  type TrainingView,
} from "../training/state";

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
/** PHONE-40: how long the target choice waits for each link's fresh state (auth, failure or pong). */
export const LINKS_SETTLE_MS = 3000;
/**
 * PHONE-30: the warm microphone closes after this long without a dictation or a touch (the
 * screen usually locks sooner, which closes it too); never while the training screen shows.
 */
export const MIC_IDLE_MS = 3 * 60 * 1000;
/**
 * PHONE-50 (run 12): a training take records on for this long after the release, so the last
 * word never touches the end of the take (the owner's pilot found speech at the very edge of many
 * takes). The screen shows the take on its way at once. Dictations stop at the release.
 */
export const TRAINING_TAIL_MS = 500;

export interface ComputerView {
  roomId: string;
  name: string;
  os: "mac" | "win";
  deviceName: string;
  connected: boolean;
  online: boolean;
  /** The day the relay last saw the computer (RELAY-02); null when unknown. */
  lastSeenDay: number | null;
  /** Whole days since then; null when unknown. */
  daysAway: number | null;
  /**
   * Run 5: away for days, so maybe reset, reinstalled or with a new identity: the screen offers
   * "Par igen" while it still waits for the computer (PHONE-24, core/stale.ts).
   */
  stale: boolean;
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
  /**
   * PHONE-21: the microphone level while recording, 0 (silence) to 1 (loud), from the RMS of the
   * latest 200 ms block; 0 when not recording.
   */
  level: number;
  /** A computer's training session (the fine-tuning workbench): the training screen shows. */
  training: TrainingView | null;
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
  /** MIC_IDLE_MS, shortened in tests. */
  micIdleMs?: number;
  /** Whether the page is visible now (document.visibilityState). */
  visible?: () => boolean;
  /** training/state.ts STALE_MS, shortened in tests. */
  trainingStaleMs?: number;
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
    peerOnline: false,
    connected: false,
  });
  private settings: Settings = { haptics: true };
  private target: string | null = null;
  private notices: Notice[] = [];
  private noticeId = 0;
  private pairing: PairingState = { state: "idle" };
  private noConnection = false;
  private level = 0;
  private noConnTimer: ReturnType<typeof setTimeout> | null = null;
  private maxTimer: ReturnType<typeof setTimeout> | null = null;
  private recChain: Promise<unknown> = Promise.resolve();
  private loaded = false;
  private snapshot: Snapshot;
  private readonly listeners = new Set<() => void>();
  /**
   * Admissions this phone has sent a join with in this session (in memory only). Only a retry of
   * one of them may fall back to authenticating as a member (link.ts `memberFallback`, run 5).
   */
  private readonly joinAttempts = new Set<string>();
  private choosing = false;
  private chooseAgain = false;
  /** The page is visible (not in the background). */
  private visible: boolean;
  /** The microphone is open or opening (warm), as far as the controller asked for it. */
  private micOpen = false;
  /** No dictation and no touch for MIC_IDLE_MS. */
  private micIdle = false;
  /** Opening the microphone was refused; ask again only when the app comes back. */
  private micRefused = false;
  private micIdleTimer: ReturnType<typeof setTimeout> | null = null;
  /** WalkieTalkey training (training/state.ts): the prompt on screen, and sessions that are over. */
  private training: TrainingView | null = null;
  private readonly trainingOver = new Set<string>();
  private trainingTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * A training take's last TRAINING_TAIL_MS after the release: the microphone still records for
   * it, and `finish` ends it as a dictation ends on release. At most one; never while recording.
   */
  private tail: {
    sid: string;
    timer: ReturnType<typeof setTimeout>;
    finish: () => void;
  } | null = null;

  constructor(deps: ControllerDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.visible = (deps.visible ?? pageVisible)();
    this.snapshot = this.buildSnapshot();
  }

  // ------------------------------------------------------------------ store

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getSnapshot = (): Snapshot => this.snapshot;

  private buildSnapshot(): Snapshot {
    const today = dayNumber(this.now());
    return {
      loaded: this.loaded,
      rooms: [...this.rooms.values()]
        .map((r) => {
          const view = {
            connected: r.link.connected,
            online: r.link.connected && r.link.peerOnline,
            lastSeenDay: r.link.ownerLastSeenDay,
          };
          return {
            roomId: r.record.roomId,
            name: r.record.computerName,
            os: r.record.os,
            deviceName: r.record.deviceName,
            ...view,
            daysAway: daysAway(view.lastSeenDay, today),
            stale: isStale(view, today),
          };
        })
        .sort((a, b) => a.name.localeCompare(b.name, "da")),
      target: this.target,
      machine: this.machine,
      settings: this.settings,
      notices: this.notices,
      pairing: this.pairing,
      noConnection: this.noConnection,
      level:
        this.machine.phase === "rec" || this.machine.phase === "cancel"
          ? this.level
          : 0,
      training: this.training,
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
      peerOnline: false,
      connected: false,
    });
    this.loaded = true;
    for (const r of this.rooms.values()) r.link.start();
    this.watchConnection();
    this.micPolicy(true);
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
      now: this.now,
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
        if (!e.connected) this.trainingStale(roomId);
        if (isTarget) {
          this.dispatch({ type: "connection", up: e.connected });
          this.watchConnection();
        }
        break;
      case "peer":
        if (!e.online) this.trainingStale(roomId);
        if (isTarget) this.dispatch({ type: "peer", online: e.online });
        // PHONE-32: the computer is back. Its old socket may have looked live at the relay for up
        // to 75 s after it went to sleep and swallowed what was sent, so open sessions go again.
        if (e.online && e.announced)
          void entry.streamer.peerReturned(this.sessionsOf(roomId));
        break;
      case "authenticated":
        // A new connection: the training prompt waits until the computer sends it again.
        this.trainingStale(roomId);
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
    } else if (p.type === "training_prompt") {
      const t = fromPrompt(entry.record.roomId, entry.record.computerName, p);
      if (this.trainingOver.has(t.id)) return;
      // A skipped sentence sent again (the phone back online, say) still waits for the next one.
      const was = this.training;
      if (was?.id === t.id && was.skipped && was.skipped === t.next?.prompt)
        t.skipped = was.skipped;
      this.clearTrainingTimer();
      this.training = t;
      // PHONE-50: the training screen keeps the microphone warm (it opens it again if it went idle
      // on the main screen), so every take starts with the pre-roll.
      this.micIdle = false;
      this.micPolicy(true);
      // Takes go to the computer that asked for them.
      if (t.roomId !== this.target && !this.busy()) this.setTarget(t.roomId);
    } else if (p.type === "training_end") {
      const id = b64uEncode(p.training);
      this.trainingOver.add(id);
      if (this.training?.id === id) this.endTraining();
    }
  }

  private busy(): boolean {
    const phase = this.machine.phase;
    return (
      phase === "rec" ||
      phase === "cancel" ||
      phase === "send" ||
      phase === "offline"
    );
  }

  private clearTrainingTimer(): void {
    if (this.trainingTimer) clearTimeout(this.trainingTimer);
    this.trainingTimer = null;
  }

  private endTraining(): void {
    this.clearTrainingTimer();
    this.training = null;
    // The warm microphone's idle time counts from the training screen's end (PHONE-30).
    this.micPolicy(true);
    // The last take's "Gemt" is not a dictation's "Klar på": the main screen starts afresh.
    const phase = this.machine.phase;
    if (
      phase === "ready" ||
      phase === "no_speech" ||
      phase === "error" ||
      phase === "paused"
    )
      this.machine = {
        ...this.machine,
        phase: "idle",
        sessionId: null,
        detail: null,
      };
  }

  /** The computer went away, or this phone's connection is new (training/state.ts). */
  private trainingStale(roomId: string): void {
    const t = this.training;
    if (!t || t.roomId !== roomId || t.stale) return;
    this.training = { ...t, stale: true };
    this.clearTrainingTimer();
    this.trainingTimer = setTimeout(() => {
      this.trainingTimer = null;
      if (this.training?.stale) {
        this.endTraining();
        this.changed();
      }
    }, this.deps.trainingStaleMs ?? STALE_MS);
  }

  /** "Tag om" on the training screen (the last sentence again), or back to the next sentence. */
  trainingRedo(on: boolean): void {
    const t = this.training;
    if (!t || !t.last || this.busy()) return;
    this.training = { ...t, redo: on };
    this.changed();
  }

  /**
   * "Spring over" (PHONE-52): asks the computer to pass over the current sentence, as a training
   * take for `skip:<prompt>` that is cancelled at once, with no audio (PROTOCOL.md 8.4). The
   * computer answers with its next prompt; until the prompt changes, the button waits.
   */
  trainingSkip(): void {
    const t = this.training;
    if (!t || !t.next || !canSkip(t) || this.busy()) return;
    const prompt = skipPrompt(t.next.prompt);
    const entry = this.rooms.get(t.roomId);
    if (!prompt || !entry?.link.connected) return;
    const skipped = t.next.prompt;
    const s = newSession(t.roomId, this.now());
    s.training = { id: t.training, prompt };
    this.training = { ...t, skipped };
    this.changed();
    void entry.streamer.skip(s).then((sent) => {
      // Not sent (the connection dropped): the button can be pressed again.
      const now = this.training;
      if (sent || now?.id !== t.id || now.skipped !== skipped) return;
      this.training = { ...now, skipped: null };
      this.changed();
    });
  }

  /** "Afslut": back to normal; this session's prompts are not shown again. */
  leaveTraining(): void {
    const t = this.training;
    if (!t) return;
    this.trainingOver.add(t.id);
    this.endTraining();
    this.changed();
  }

  /**
   * A new recording: a training take while the training screen shows (to the computer that
   * asked for it), else a dictation to the target. Null when there is nothing to record.
   */
  private sessionForPress(): AudioSession | null {
    const t = this.training;
    if (t) {
      const item = trainingItem(t);
      if (t.stale || !item || !this.rooms.has(t.roomId)) return null;
      const s = newSession(t.roomId, this.now());
      const microphone = this.deps.recorder.microphoneName?.() ?? undefined;
      s.training = { id: t.training, prompt: item.prompt, microphone };
      return s;
    }
    if (!this.target || !this.rooms.has(this.target)) return null;
    return newSession(this.target, this.now());
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
    const was = this.recording();
    const { state, effects } = transition(this.machine, e);
    this.machine = state;
    for (const fx of effects) this.effect(fx);
    // The idle time of the warm microphone counts from the end of a dictation.
    if (was !== this.recording()) this.micPolicy(true);
    this.changed();
  }

  private recording(): boolean {
    return this.machine.phase === "rec" || this.machine.phase === "cancel";
  }

  // ------------------------------------------------------------------ microphone

  /**
   * PHONE-30: the microphone is open while the app is visible and paired, so a dictation starts
   * with the 300 ms before the press (src/audio/capture.ts). It closes when the page is hidden,
   * after MIC_IDLE_MS without a dictation or a touch, and when no computer is paired. Audio
   * between dictations stays in that short ring in memory and is never sent (PHONE-33).
   * While the training screen shows it never goes idle (PHONE-50, run 12): the first take after a
   * quiet spell over a sentence starts with the pre-roll too.
   */
  private micWanted(): boolean {
    return (
      this.loaded &&
      this.visible &&
      this.rooms.size > 0 &&
      !this.micIdle &&
      !this.micRefused
    );
  }

  private micPolicy(restartIdle = false): void {
    const { recorder } = this.deps;
    if (this.micWanted()) {
      if (!this.micOpen) {
        this.micOpen = true;
        recorder.warm().catch((e: unknown) => {
          this.micOpen = false;
          if (e instanceof MicDeniedError) this.micRefused = true;
        });
      }
    } else if (this.micOpen && !this.recording()) {
      // A training take's tail ends first, so the take keeps its last block.
      this.endTail();
      this.micOpen = false;
      // After the last block of a dictation that is still stopping; unless it was wanted again.
      this.recChain = this.recChain.then(() => {
        if (!this.micOpen) recorder.cool();
      });
    }
    if (restartIdle || !this.micOpen || this.recording()) this.armMicIdle();
  }

  private armMicIdle(): void {
    if (this.micIdleTimer) clearTimeout(this.micIdleTimer);
    this.micIdleTimer = null;
    if (!this.micOpen || this.recording() || this.training) return;
    this.micIdleTimer = setTimeout(() => {
      this.micIdleTimer = null;
      if (this.recording() || this.training) return;
      this.micIdle = true;
      this.micPolicy();
    }, this.deps.micIdleMs ?? MIC_IDLE_MS);
  }

  /** A touch or a key anywhere: the user is here, keep (or open) the microphone. */
  activity(): void {
    this.micIdle = false;
    this.micPolicy(true);
  }

  /** The page went to the background: send a recording that is under way, close the microphone. */
  hidden(): void {
    this.visible = false;
    if (this.recording()) this.dispatch({ type: "hidden" });
    // A training take goes at once too, without the rest of its tail.
    this.endTail();
    this.micPolicy();
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
    // A recording opens the microphone (if warming it was refused, the press may still be granted).
    this.micOpen = true;
    this.level = 0;
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
        await this.deps.recorder.start((block, rms) => {
          void entry.streamer.addBlock(s, block);
          this.showLevel(sid, rms);
        });
        this.micRefused = false;
      } catch (e) {
        if (e instanceof MicDeniedError) this.micRefused = true;
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

  /** PHONE-21: the level meter follows the microphone, one update per 200 ms block. */
  private showLevel(sid: string, rms: number): void {
    const phase = this.machine.phase;
    if (
      this.machine.sessionId !== sid ||
      (phase !== "rec" && phase !== "cancel")
    )
      return;
    const level = meterLevel(rms);
    if (level === this.level) return;
    this.level = level;
    this.changed();
  }

  private finishCapture(sid: string): void {
    if (this.maxTimer) clearTimeout(this.maxTimer);
    this.maxTimer = null;
    const s = this.sessions.get(sid);
    const entry = s ? this.rooms.get(s.roomId) : undefined;
    if (!s || !entry) return;
    const finish = () => {
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
    };
    if (!s.training) {
      finish();
      return;
    }
    // PHONE-50: a training take records on for TRAINING_TAIL_MS (the screen already shows it on
    // its way, the level meter is down), then ends as a dictation does. A press, the page going
    // to the background or the microphone closing ends the tail at once (endTail).
    this.endTail();
    this.tail = {
      sid,
      timer: setTimeout(() => this.endTail(), TRAINING_TAIL_MS),
      finish,
    };
  }

  /** A training take's tail is over (or cut short): stop the microphone and send the take's end. */
  private endTail(): void {
    const t = this.tail;
    if (!t) return;
    this.tail = null;
    clearTimeout(t.timer);
    t.finish();
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

  /** The button went down: recording starts now (PHONE-26). */
  down(): void {
    // A press during a hands-free recording stops it; the new session is then never used.
    const s = this.recording()
      ? newSession("", this.now())
      : this.sessionForPress();
    if (!s) return;
    this.prime();
    this.activity();
    // A press during a training take's tail ends that take now; the new one starts after it.
    this.endTail();
    this.pendingSession = s;
    this.dispatch({ type: "down", sessionId: s.sid, at: this.now() });
    this.pendingSession = null;
  }

  /** The button came up: within 0.5 s of the press it goes hands-free, later it sends. */
  up(): void {
    this.dispatch({ type: "up", at: this.now() });
  }

  /**
   * The system took the touch away (pointercancel: an iOS gesture, a call, an alert). The press
   * ends as if released, but never as a tap: a short one sends too instead of going hands-free.
   */
  interrupted(): void {
    this.dispatch({ type: "up", at: this.now(), interrupted: true });
  }

  /**
   * The iOS shell's "Start diktering" (`wt-shell-start`, or `?start=1` on a cold start): starts a
   * hands-free recording. Ignored when not paired or already recording.
   */
  shellStart(): boolean {
    const s = this.sessionForPress();
    if (!s) return false;
    this.prime();
    this.activity();
    // As a press: a training take's tail ends now.
    this.endTail();
    this.pendingSession = s;
    this.dispatch({ type: "shell_start", sessionId: s.sid, at: this.now() });
    this.pendingSession = null;
    return this.machine.sessionId === s.sid && this.machine.phase === "rec";
  }

  /** The cancel control of a hands-free recording ("Annullér"). */
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
    if (this.micIdleTimer) clearTimeout(this.micIdleTimer);
    if (this.tail) clearTimeout(this.tail.timer);
    this.clearTrainingTimer();
    this.maxTimer = null;
    this.noConnTimer = null;
    this.micIdleTimer = null;
    this.tail = null;
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

  /**
   * Back in the foreground (PHONE-40): open the microphone again, check the sockets, then pick
   * the computer you sit at.
   */
  foreground(): void {
    this.visible = true;
    this.micIdle = false;
    this.micRefused = false;
    this.micPolicy(true);
    this.deps.wake.visible();
    this.dispatch({ type: "foreground" });
    for (const r of this.rooms.values()) r.link.reconnectNow();
    void this.chooseOnForeground();
  }

  network(online: boolean): void {
    if (online) for (const r of this.rooms.values()) r.link.reconnectNow();
  }

  private async chooseOnForeground(): Promise<void> {
    if (this.rooms.size < 2) return;
    // A foreground during a choice (the one at start, say) gets a choice of its own afterwards.
    if (this.choosing) {
      this.chooseAgain = true;
      return;
    }
    this.choosing = true;
    try {
      do {
        this.chooseAgain = false;
        await this.chooseOnce();
      } while (this.chooseAgain && this.rooms.size >= 2);
    } finally {
      this.choosing = false;
    }
  }

  private async chooseOnce(): Promise<void> {
    // The sockets may have died in the background: wait for every link's fresh state first.
    await Promise.all(
      [...this.rooms.values()].map((r) => r.link.whenSettled(LINKS_SETTLE_MS)),
    );
    const entries = [...this.rooms.values()];
    // A link with no outcome yet (no authentication, no pong) does not count as online.
    const live = (r: RoomEntry) =>
      r.link.settled && r.link.connected && r.link.peerOnline;
    const candidates: Candidate[] = entries.map((r) => ({
      roomId: r.record.roomId,
      online: live(r),
      lastUsedAt: r.record.lastUsedAt,
    }));
    const answers = new Map<string, PresenceAnswer | null>();
    if (needsPresence(candidates)) {
      await Promise.all(
        entries
          .filter(live)
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
    // Run 5: the "ok lost" fallback only where it can be true, never for an old code of a room
    // this phone is already in (it would replace working keys).
    const attempt = b64uEncode(p.a);
    const memberFallback =
      !this.rooms.has(b64uEncode(p.r)) || this.joinAttempts.has(attempt);
    this.joinAttempts.add(attempt);
    let h;
    try {
      h = await joinRoom(this.WS, p, device, undefined, memberFallback);
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
    this.activity();
    // Run 5: the same computer under an old identity (reset, reinstalled, v0.2.0) is replaced:
    // its old room would wait for an owner that never comes back.
    // A link without an outcome yet counts as online: it is kept.
    const views = [...this.rooms.values()].map((r) => ({
      roomId: r.record.roomId,
      computerName: r.record.computerName,
      os: r.record.os,
      online: !r.link.settled || (r.link.connected && r.link.peerOnline),
    }));
    for (const gone of supersededRooms(views, record))
      void this.removeRoom(gone);
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
    // A training take in its tail goes with the room: the microphone stops for it now.
    if (this.tail && !this.sessions.has(this.tail.sid)) this.endTail();
    await this.deps.storage.deleteRoom(roomId);
    if (this.training?.roomId === roomId) this.endTraining();
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
        peerOnline: false,
        connected: false,
      });
      this.setTarget(this.lastUsed());
    }
    this.micPolicy();
    this.changed();
  }

  dismissNotice(id: number): void {
    this.notices = this.notices.filter((n) => n.id !== id);
    this.changed();
  }

  // ------------------------------------------------------------------ settings

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

function pageVisible(): boolean {
  return (
    typeof document === "undefined" || document.visibilityState !== "hidden"
  );
}
