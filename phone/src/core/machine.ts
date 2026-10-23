/**
 * The main screen's recording state machine (PHONE-20 to PHONE-26), as a pure function from
 * (state, event) to (state, effects). The controller performs the effects.
 */
import type { ResultReason } from "@walkietalkey/protocol";

export type Phase =
  | "idle"
  | "rec"
  | "cancel"
  | "send"
  | "offline"
  | "ready"
  | "failed"
  | "error"
  | "paused"
  | "no_speech"
  | "mic_denied";

export type Mode = "hold" | "toggle";

export interface MachineState {
  phase: Phase;
  mode: Mode;
  /** The session the screen is about (the current or the last recording). */
  sessionId: string | null;
  recStartedAt: number | null;
  /** The relay's view of the target computer (RELAY-10 `peer`). */
  peerOnline: boolean;
  /** This phone's socket to the target's room is authenticated. */
  connected: boolean;
  /** What "Detaljer" explains (a result reason, a relay error code or mic:<name>). */
  detail: string | null;
  /**
   * The recording goes on without a finger on the button: started by a tap (tap mode) or by the
   * iOS shell's "Start diktering". The next tap on the button sends it; sliding off during that
   * tap, or the cancel control, cancels it.
   */
  latched: boolean;
  /** A latched recording's stopping tap is under way (its finger is down). */
  armed: boolean;
}

export type MachineEvent =
  | { type: "down"; sessionId: string; at: number }
  | { type: "up" }
  | { type: "slide"; inside: boolean }
  | { type: "max_duration" }
  | { type: "empty"; sessionId: string }
  | { type: "mic_denied" }
  | { type: "mic_error"; detail: string }
  | { type: "result"; sessionId: string; ok: boolean; reason?: ResultReason }
  | { type: "peer"; online: boolean }
  | { type: "connection"; up: boolean }
  | { type: "timeout"; sessionId: string }
  | { type: "retry" }
  | { type: "relay_error"; code: string }
  | { type: "mode"; mode: Mode }
  | { type: "retarget"; peerOnline: boolean; connected: boolean }
  | { type: "foreground" }
  /** The iOS shell's "Start diktering" (App Intent, Action button, Control Center). */
  | { type: "shell_start"; sessionId: string; at: number }
  /** The cancel control shown during a latched recording. */
  | { type: "cancel" };

export type Effect =
  | { type: "start_capture"; sessionId: string }
  /** Stop the microphone, send audio_end, start the 10 minute wait. */
  | { type: "finish_capture"; sessionId: string }
  /** Stop the microphone, send audio_cancel, forget the audio. */
  | { type: "cancel_capture"; sessionId: string }
  | { type: "haptic"; kind: "start" | "stop" }
  | { type: "wake_lock"; on: boolean }
  | { type: "retry"; sessionId: string };

export interface Transition {
  state: MachineState;
  effects: Effect[];
}

export function initialMachine(opts: { mode: Mode; peerOnline: boolean; connected: boolean }): MachineState {
  return {
    phase: "idle",
    mode: opts.mode,
    sessionId: null,
    recStartedAt: null,
    peerOnline: opts.peerOnline,
    connected: opts.connected,
    detail: null,
    latched: false,
    armed: false,
  };
}

const RECORDING = new Set<Phase>(["rec", "cancel"]);
const WAITING = new Set<Phase>(["send", "offline"]);
const SETTLED = new Set<Phase>(["ready", "no_speech", "paused", "error", "mic_denied"]);

/** Waiting for the result: "offline" when the relay says the computer is away, else "send". */
function waiting(s: MachineState): Phase {
  return s.connected && !s.peerOnline ? "offline" : "send";
}

function start(s: MachineState, e: { sessionId: string; at: number }, latched: boolean): Transition {
  return {
    state: { ...s, phase: "rec", sessionId: e.sessionId, recStartedAt: e.at, detail: null, latched, armed: false },
    effects: [
      { type: "start_capture", sessionId: e.sessionId },
      { type: "haptic", kind: "start" },
      { type: "wake_lock", on: true },
    ],
  };
}

function finish(s: MachineState): Transition {
  const sessionId = s.sessionId!;
  return {
    state: { ...s, phase: waiting(s), recStartedAt: null, latched: false, armed: false },
    effects: [
      { type: "finish_capture", sessionId },
      { type: "haptic", kind: "stop" },
      { type: "wake_lock", on: false },
    ],
  };
}

function cancel(s: MachineState): Transition {
  const sessionId = s.sessionId!;
  return {
    state: { ...s, phase: "idle", sessionId: null, recStartedAt: null, latched: false, armed: false },
    effects: [
      { type: "cancel_capture", sessionId },
      { type: "haptic", kind: "stop" },
      { type: "wake_lock", on: false },
    ],
  };
}

const same = (s: MachineState): Transition => ({ state: s, effects: [] });

export function transition(s: MachineState, e: MachineEvent): Transition {
  switch (e.type) {
    case "down":
      // A latched recording's next tap arms the stop; it happens on release (or cancels, slid off).
      if (RECORDING.has(s.phase)) return s.latched && !s.armed ? same({ ...s, armed: true }) : same(s);
      return start(s, e, s.mode === "toggle");
    case "shell_start":
      if (RECORDING.has(s.phase)) return same(s);
      return start(s, e, true);
    case "up":
      // The release of the tap that started a latched recording changes nothing.
      if (s.latched && !s.armed) return same(s);
      if (s.phase === "rec") return finish(s);
      if (s.phase === "cancel") return cancel(s);
      return same(s);
    case "slide":
      if (s.latched && !s.armed) return same(s);
      if (s.phase === "rec" && !e.inside) return same({ ...s, phase: "cancel" });
      if (s.phase === "cancel" && e.inside) return same({ ...s, phase: "rec" });
      return same(s);
    case "cancel":
      return RECORDING.has(s.phase) ? cancel(s) : same(s);
    case "max_duration":
      return RECORDING.has(s.phase) ? finish(s) : same(s);
    case "empty":
      if (e.sessionId !== s.sessionId || !WAITING.has(s.phase)) return same(s);
      return same({ ...s, phase: "idle", sessionId: null });
    case "mic_denied":
    case "mic_error": {
      if (!RECORDING.has(s.phase)) return same(s);
      const sessionId = s.sessionId!;
      const phase: Phase = e.type === "mic_denied" ? "mic_denied" : "error";
      return {
        state: { ...s, phase, recStartedAt: null, latched: false, armed: false, detail: e.type === "mic_error" ? `mic:${e.detail}` : null },
        effects: [
          { type: "cancel_capture", sessionId },
          { type: "wake_lock", on: false },
        ],
      };
    }
    case "result": {
      if (e.sessionId !== s.sessionId || !(WAITING.has(s.phase) || s.phase === "failed")) return same(s);
      if (e.ok) return same({ ...s, phase: "ready", detail: null });
      if (e.reason === "no_speech") return same({ ...s, phase: "no_speech", detail: null });
      if (e.reason === "paused") return same({ ...s, phase: "paused", detail: null });
      return same({ ...s, phase: "error", detail: e.reason ?? "error" });
    }
    case "peer": {
      const next = { ...s, peerOnline: e.online };
      return same(WAITING.has(s.phase) ? { ...next, phase: waiting(next) } : next);
    }
    case "connection": {
      const next = { ...s, connected: e.up };
      return same(WAITING.has(s.phase) ? { ...next, phase: waiting(next) } : next);
    }
    case "timeout":
      if (e.sessionId !== s.sessionId || !WAITING.has(s.phase)) return same(s);
      return same({ ...s, phase: "failed" });
    case "retry":
      if (s.phase !== "failed" || !s.sessionId) return same(s);
      return { state: { ...s, phase: waiting(s) }, effects: [{ type: "retry", sessionId: s.sessionId }] };
    case "relay_error":
      if (e.code !== "buffer_full" || !WAITING.has(s.phase)) return same(s);
      return same({ ...s, phase: "error", detail: e.code });
    case "mode":
      return same({ ...s, mode: e.mode });
    case "retarget":
      if (RECORDING.has(s.phase)) return same(s);
      return same({ ...s, phase: "idle", sessionId: null, detail: null, peerOnline: e.peerOnline, connected: e.connected });
    case "foreground":
      return same(SETTLED.has(s.phase) ? { ...s, phase: "idle", detail: null } : s);
  }
}
