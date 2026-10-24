// Types shared by the WalkieTalkey screens. Backend types come from the
// generated bindings; the event payloads are written out here because specta
// does not export them.
export type {
  CleanupMode,
  HistoryItem,
  HistoryRetention as HistoryRetentionName,
  MicCheck,
  PairingView,
  PhoneView,
  RelayView,
  Replacement,
  SpeedVerdict,
  WtSettings,
  WtSettingsView,
} from "@/bindings";
export type { DictationPillState as DictationPillStateName } from "@walkietalkey/ui";

/** `wt-pill-end` (src-tauri/src/walkietalkey/pill.rs). */
export interface PillEndEvent {
  state:
    | "pasted"
    | "clipboard"
    | "no_speech"
    | "cleanup_skipped"
    /** The input gave no sound for the whole take (DESK-59). */
    | "mic_silent";
  /** "⌘V" or "Ctrl+V". */
  shortcut: string;
}

/** `wt-mic-silent` (mic/mod.rs, DESK-59): the input has given no sound
 *  for 1.5 s of this recording (`true`), or sound came (`false`). The window
 *  notice comes as `wt-mic-check` with a `MicCheck`. */
export interface MicSilentEvent {
  silent: boolean;
}

/** `wt-pill-countdown` (limits.rs), from 4:45. */
export interface PillCountdownEvent {
  seconds_left: number;
}

/** `wt-phone-joined` (relay/mod.rs); `name` is "en telefon uden navn" when
 *  the phone sent none. */
export interface PhoneJoinedEvent {
  id: string;
  name: string;
}

/** `wt-update-status` (updates.rs). */
export type UpdateStatus =
  | { state: "checking" }
  | { state: "up_to_date" }
  | { state: "downloading"; version: string }
  | { state: "ready"; version: string }
  | { state: "failed"; message: string };

/** `wt-notify` (notify.rs), when system notifications are unavailable. */
export interface NoticeEvent {
  title: string;
  body: string;
  history_id: number | null;
}

/** Handy's `model-download-progress`. */
export interface DownloadProgress {
  model_id: string;
  downloaded: number;
  total: number;
  percentage: number;
}
