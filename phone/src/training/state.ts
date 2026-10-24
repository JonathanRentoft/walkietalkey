/**
 * The training screen's state (the fine-tuning workbench, `wt-train record`; PROTOCOL.md 8.4,
 * PRIV-05). A computer that runs a training session sends the sentence to read as a
 * training_prompt; the phone shows it instead of the main screen and records it through the
 * dictation path, tagged with the prompt (audio_start_training). It is the only text a computer
 * sends a phone, and only while the session runs.
 *
 * A take may only go to a computer that showed it supports training on the current connection,
 * because an older desktop would treat the take's blocks as a dictation: when the computer goes
 * away or the phone's socket is new, the prompt goes stale (the button waits) until the computer
 * sends it again, which it does when it sees the phone online; without a fresh prompt the phone
 * returns to normal (STALE_MS). training_end, or "Afslut", ends it at once.
 */
import {
  b64uEncode,
  type DevicePayload,
  type TrainingCheck,
  type TrainingItem,
  type TrainingLast,
  type TrainingStyle,
} from "@walkietalkey/protocol";
import { T } from "../lib/strings";

/** How long a stale prompt waits for the computer to send it again. */
export const STALE_MS = 10_000;

export interface TrainingView {
  roomId: string;
  computer: string;
  /** The training session's id, as sent and as base64url. */
  training: Uint8Array;
  id: string;
  style: TrainingStyle;
  done: number;
  total: number;
  next: TrainingItem | null;
  last: TrainingLast | null;
  /** Reading the last sentence again. */
  redo: boolean;
  /** The computer went away or the connection is new: no take until it sends the prompt again. */
  stale: boolean;
}

export type TrainingPromptPayload = Extract<
  DevicePayload,
  { type: "training_prompt" }
>;

export function fromPrompt(
  roomId: string,
  computer: string,
  p: TrainingPromptPayload,
): TrainingView {
  return {
    roomId,
    computer,
    training: p.training,
    id: b64uEncode(p.training),
    style: p.style,
    done: p.done,
    total: p.total,
    next: p.next ?? null,
    last: p.last ?? null,
    redo: false,
    stale: false,
  };
}

/** What a press records now: the next sentence, or the last one again (a redo). */
export function trainingItem(t: TrainingView): TrainingItem | null {
  if (t.redo && t.last) return { prompt: t.last.prompt, text: t.last.text };
  return t.next;
}

/** How the computer judged the last take (training/wt_train/recorder/checks.py). */
export function checkMessage(check: TrainingCheck): string {
  return T.trainingChecks[check] ?? T.trainingChecks.error;
}
