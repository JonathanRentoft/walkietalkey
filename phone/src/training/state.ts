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
 *
 * "Spring over" (PHONE-52) passes over the current sentence without a desktop change: the phone
 * starts a training take for `skip:<prompt>` and cancels it at once, with no audio. The installed
 * desktop hands both to the recorder, which reads a cancelled take with that prefix as a skip;
 * the phone then waits for the computer's next prompt.
 */
import {
  MAX_PROMPT_ID_BYTES,
  b64uEncode,
  utf8Encode,
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
  /** The prompt "Spring over" asked the computer to pass over; it waits for another one. */
  skipped: string | null;
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
    skipped: null,
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

/** The prefix of a skip's prompt (PROTOCOL.md 8.4, PHONE-52). */
export const SKIP_PREFIX = "skip:";

/** The prompt a skip of `prompt` sends, or null when it would not fit the protocol's 64 bytes. */
export function skipPrompt(prompt: string): string | null {
  const out = SKIP_PREFIX + prompt;
  return utf8Encode(out).length <= MAX_PROMPT_ID_BYTES ? out : null;
}

/**
 * "Spring over" can be pressed: there is a next sentence, it is not a redo, the prompt is fresh,
 * and this sentence was not skipped already (the computer has not moved on yet). Recording and
 * sending are checked by the screen and the controller.
 */
export function canSkip(t: TrainingView): boolean {
  return (
    !t.stale &&
    !t.redo &&
    t.next !== null &&
    t.skipped !== t.next.prompt &&
    skipPrompt(t.next.prompt) !== null
  );
}
