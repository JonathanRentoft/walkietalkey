/**
 * The main screen's recording state machine (PHONE-20 to PHONE-29), as a pure function from
 * (state, event) to (state, effects). The controller performs the effects.
 *
 * Tap or hold (PHONE-26): a recording starts the moment the button goes down. Released within
 * 0.5 s it goes hands-free and keeps recording until the next tap (sends), "Annullér" or the
 * 5 minute limit; held longer it is push-to-talk and the release sends. Sliding off the button
 * while a finger is on it shows "Slip for at annullere", and letting go there cancels.
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

/** PHONE-26: a press released sooner than this is a tap (hands-free); longer is a hold. */
export const TAP_MS = 500;

export interface MachineState {
  phase: Phase;
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
   * Hands-free: the recording goes on without a finger on the button, started by a tap or by the
   * iOS shell's "Start diktering". The next tap on the button sends it; sliding off during that
   * tap, or the cancel control, cancels it.
   */
  handsFree: boolean;
  /** A hands-free recording's stopping tap is under way (its finger is down). */
  armed: boolean;
}

export type MachineEvent =
  | { type: "down"; sessionId: string; at: number }
  | { type: "up"; at: number }
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
  | { type: "retarget"; peerOnline: boolean; connected: boolean }
  | { type: "foreground" }
  /** The iOS shell's "Start diktering" (App Intent, Action button, Control Center). */
  | { type: "shell_start"; sessionId: string; at: number }
  /** The cancel control shown during a hands-free recording. */
  | { type: "cancel" }
  /** The page went to the background (or is being closed). */
  | { type: "hidden" };

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

export function initialMachine(opts: {
  peerOnline: boolean;
  connected: boolean;
}): MachineState {
  return {
    phase: "idle",
    sessionId: null,
    recStartedAt: null,
    peerOnline: opts.peerOnline,
    connected: opts.connected,
    detail: null,
    handsFree: false,
    armed: false,
  };
}

const RECORDING = new Set<Phase>(["rec", "cancel"]);
const WAITING = new Set<Phase>(["send", "offline"]);
const SETTLED = new Set<Phase>([
  "ready",
  "no_speech",
  "paused",
  "error",
  "mic_denied",
]);

/** Waiting for the result: "offline" when the relay says the computer is away, else "send". */
function waiting(s: MachineState): Phase {
  return s.connected && !s.peerOnline ? "offline" : "send";
}

function start(
  s: MachineState,
  e: { sessionId: string; at: number },
  handsFree: boolean,
): Transition {
  return {
    state: {
      ...s,
      phase: "rec",
      sessionId: e.sessionId,
      recStartedAt: e.at,
      detail: null,
      handsFree,
      armed: false,
    },
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
    state: {
      ...s,
      phase: waiting(s),
      recStartedAt: null,
      handsFree: false,
      armed: false,
    },
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
    state: {
      ...s,
      phase: "idle",
      sessionId: null,
      recStartedAt: null,
      handsFree: false,
      armed: false,
    },
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
      // A hands-free recording's next tap arms the stop; it happens on release (or cancels, slid off).
      if (RECORDING.has(s.phase))
        return s.handsFree && !s.armed ? same({ ...s, armed: true }) : same(s);
      return start(s, e, false);
    case "shell_start":
      if (RECORDING.has(s.phase)) return same(s);
      return start(s, e, true);
    case "up":
      // No finger is on the button (Start diktering): nothing to release.
      if (s.handsFree && !s.armed) return same(s);
      if (s.phase === "cancel") return cancel(s);
      if (s.phase !== "rec") return same(s);
      // A tap: hands-free from here on.
      if (!s.handsFree && e.at - (s.recStartedAt ?? e.at) < TAP_MS)
        return same({ ...s, handsFree: true });
      return finish(s);
    case "slide":
      if (s.handsFree && !s.armed) return same(s);
      if (s.phase === "rec" && !e.inside)
        return same({ ...s, phase: "cancel" });
      if (s.phase === "cancel" && e.inside) return same({ ...s, phase: "rec" });
      return same(s);
    case "cancel":
      return RECORDING.has(s.phase) ? cancel(s) : same(s);
    case "hidden":
      // Gone to the background: send what was said; a finger that had slid off meant cancel.
      if (s.phase === "cancel") return cancel(s);
      return s.phase === "rec" ? finish(s) : same(s);
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
        state: {
          ...s,
          phase,
          recStartedAt: null,
          handsFree: false,
          armed: false,
          detail: e.type === "mic_error" ? `mic:${e.detail}` : null,
        },
        effects: [
          { type: "cancel_capture", sessionId },
          { type: "wake_lock", on: false },
        ],
      };
    }
    case "result": {
      if (
        e.sessionId !== s.sessionId ||
        !(WAITING.has(s.phase) || s.phase === "failed")
      )
        return same(s);
      if (e.ok) return same({ ...s, phase: "ready", detail: null });
      if (e.reason === "no_speech")
        return same({ ...s, phase: "no_speech", detail: null });
      if (e.reason === "paused")
        return same({ ...s, phase: "paused", detail: null });
      return same({ ...s, phase: "error", detail: e.reason ?? "error" });
    }
    case "peer": {
      const next = { ...s, peerOnline: e.online };
      return same(
        WAITING.has(s.phase) ? { ...next, phase: waiting(next) } : next,
      );
    }
    case "connection": {
      const next = { ...s, connected: e.up };
      return same(
        WAITING.has(s.phase) ? { ...next, phase: waiting(next) } : next,
      );
    }
    case "timeout":
      if (e.sessionId !== s.sessionId || !WAITING.has(s.phase)) return same(s);
      return same({ ...s, phase: "failed" });
    case "retry":
      if (s.phase !== "failed" || !s.sessionId) return same(s);
      return {
        state: { ...s, phase: waiting(s) },
        effects: [{ type: "retry", sessionId: s.sessionId }],
      };
    case "relay_error":
      if (e.code !== "buffer_full" || !WAITING.has(s.phase)) return same(s);
      return same({ ...s, phase: "error", detail: e.code });
    case "retarget":
      if (RECORDING.has(s.phase)) return same(s);
      return same({
        ...s,
        phase: "idle",
        sessionId: null,
        detail: null,
        peerOnline: e.peerOnline,
        connected: e.connected,
      });
    case "foreground":
      return same(
        SETTLED.has(s.phase) ? { ...s, phase: "idle", detail: null } : s,
      );
  }
}
