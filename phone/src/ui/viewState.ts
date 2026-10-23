/** From the state machine to the design system's PhoneApp state and labels (spec 7.3). */
import type { PhoneAppLabels, PhoneAppState } from "@walkietalkey/ui";
import type { MachineState } from "../core/machine";
import { T } from "../lib/strings";

export interface ViewState {
  state: PhoneAppState;
  labels: PhoneAppLabels;
  recording: boolean;
  /** Show the cancel control (a recording that ends with a tap). */
  latched?: boolean;
  /** Show LogoLoader `ekko` over the button (Appendix D: while sending). */
  sending: boolean;
}

export function viewState(m: MachineState, noConnection: boolean): ViewState {
  const recording = m.phase === "rec" || m.phase === "cancel";
  const lost: ViewState = {
    state: "offline",
    labels: { offline: T.noConnection },
    recording: false,
    sending: false,
  };
  switch (m.phase) {
    case "idle":
      return noConnection
        ? lost
        : { state: "idle", labels: {}, recording, sending: false };
    case "rec":
    case "cancel":
      // A latched recording (tap mode, Start diktering) ends with a tap, not a release.
      return {
        state: m.phase,
        labels: m.latched && !m.armed ? { rec: T.tapToSend } : {},
        recording,
        sending: false,
        latched: m.latched,
      };
    case "send":
      return noConnection
        ? lost
        : { state: "send", labels: {}, recording, sending: true };
    case "offline":
      return noConnection
        ? lost
        : { state: "offline", labels: {}, recording, sending: false };
    case "no_speech":
      return {
        state: "idle",
        labels: { idle: T.noSpeech },
        recording,
        sending: false,
      };
    case "mic_denied":
      return {
        state: "paused",
        labels: { paused: T.micDenied },
        recording,
        sending: false,
      };
    case "ready":
    case "failed":
    case "error":
    case "paused":
      return { state: m.phase, labels: {}, recording, sending: false };
  }
}

/** PHONE-29: the clock counts down from 4:45; returns the seconds left, or null before that. */
export function countdownSeconds(
  elapsedMs: number,
  maxMs: number,
  fromMs: number,
): number | null {
  if (elapsedMs < fromMs) return null;
  return Math.max(0, Math.ceil((maxMs - elapsedMs) / 1000));
}
