/** From the state machine to the design system's PhoneApp state and labels (spec 7.3). */
import type { PhoneAppLabels, PhoneAppState } from "@walkietalkey/ui";
import type { ComputerView } from "../core/controller";
import type { MachineState } from "../core/machine";
import { T } from "../lib/strings";

export interface ViewState {
  state: PhoneAppState;
  labels: PhoneAppLabels;
  recording: boolean;
  /** Hands-free (PHONE-26): show the lock and the cancel control. */
  handsFree?: boolean;
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
      // Hands-free (a tap, Start diktering) ends with another tap, not a release.
      return {
        state: m.phase,
        labels: m.handsFree && !m.armed ? { rec: T.tapAgainToStop } : {},
        recording,
        sending: false,
        handsFree: m.handsFree,
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

export type StatusKind = "online" | "away" | "connecting" | "lost";

/**
 * The status line at the very top of the main screen (run 2, Phase 4): which computer the text
 * goes to and how it is connected. "lost" is the phone's own connection to the relay (the big
 * label then says "Ingen forbindelse. Prøver igen."), "away" the computer's.
 */
export function statusLine(
  target: Pick<ComputerView, "online" | "connected">,
  noConnection: boolean,
): { kind: StatusKind; text: string } {
  if (noConnection) return { kind: "lost", text: T.statusLost };
  if (target.online) return { kind: "online", text: T.statusOnline };
  if (target.connected) return { kind: "away", text: T.statusAway };
  return { kind: "connecting", text: T.statusConnecting };
}

/** The text before and after {computer}. */
export function splitName(template: string): [string, string] {
  const i = template.indexOf("{computer}");
  if (i < 0) return [template, ""];
  return [template.slice(0, i), template.slice(i + "{computer}".length)];
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
