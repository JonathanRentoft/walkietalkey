// Pure helpers for the WalkieTalkey screens: no React, no Tauri, so they can
// be unit tested (helpers.test.ts).
import type {
  CleanupMode,
  DictationPillStateName,
  HistoryRetentionName,
  Replacement,
} from "./types";

export type WtPlatform = "macos" | "windows" | "other";

/* ------------------------------------------------------------ Onboarding */

/** The onboarding steps of spec 6.2, in order (DESK-10..17, run 2): no
 *  model step (the model downloads in the background from the first launch)
 *  and no Input Monitoring step (Accessibility covers the key). */
export const ONBOARDING_STEPS = [
  "welcome",
  "microphone",
  "accessibility",
  "try",
  "phone",
  "done",
] as const;
export type OnboardingStepId = (typeof ONBOARDING_STEPS)[number];

/** Stored as `onboarding_resume_step` once onboarding is finished, so a
 *  finished onboarding never shows again, model or not. */
export const ONBOARDING_DONE = "finished";

/** v1's steps, mapped to the step that replaced them (DESK-13 resume). */
const LEGACY_STEPS: Record<string, OnboardingStepId> = {
  model: "microphone",
  key: "accessibility",
  paste: "accessibility",
  notifications: "try",
};

/** The steps this computer shows. Tilgængelighed is a Mac permission;
 *  Windows needs none for the key or for pasting. The phone step needs
 *  pairing to be allowed (Appendix B `AllowPhonePairing`). */
export function onboardingSteps(
  platform: WtPlatform,
  opts: { phonePairing: boolean },
): OnboardingStepId[] {
  return ONBOARDING_STEPS.filter((step) => {
    if (step === "accessibility") return platform === "macos";
    if (step === "phone") return opts.phonePairing;
    return true;
  });
}

export function nextStep(
  steps: readonly OnboardingStepId[],
  current: OnboardingStepId,
): OnboardingStepId | null {
  const i = steps.indexOf(current);
  return i >= 0 && i + 1 < steps.length ? steps[i + 1] : null;
}

export function previousStep(
  steps: readonly OnboardingStepId[],
  current: OnboardingStepId,
): OnboardingStepId | null {
  const i = steps.indexOf(current);
  return i > 0 ? steps[i - 1] : null;
}

/** The next step going forward, skipping a permission step whose
 *  permission is already granted (a reinstall keeps them). */
export function forwardStep(
  steps: readonly OnboardingStepId[],
  current: OnboardingStepId,
  granted: { microphone: boolean; accessibility: boolean },
): OnboardingStepId | null {
  let next = nextStep(steps, current);
  while (
    next &&
    ((next === "microphone" && granted.microphone) ||
      (next === "accessibility" && granted.accessibility))
  ) {
    next = nextStep(steps, next);
  }
  return next;
}

/** Where to resume after a restart (DESK-13): the stored step, or the next
 *  step that exists on this computer. */
export function resumeStep(
  saved: string | null | undefined,
  steps: readonly OnboardingStepId[],
): OnboardingStepId | null {
  if (!saved) return null;
  const all = ONBOARDING_STEPS as readonly string[];
  const at = all.indexOf(LEGACY_STEPS[saved] ?? saved);
  if (at < 0) return null;
  for (let i = at; i < all.length; i++) {
    const step = all[i] as OnboardingStepId;
    if (steps.includes(step)) return step;
  }
  return null;
}

export function onboardingFinished(saved: string | null | undefined): boolean {
  return saved === ONBOARDING_DONE;
}

/* ------------------------------------------------------------------- Key */

/** How the key works, in words (Phase 1: tap or hold is the default). */
export function keyModeKey(
  activation: string | null | undefined,
): "wt.key.howHoldOrTap" | "wt.key.howHold" | "wt.key.howTap" {
  if (activation === "push_to_talk") return "wt.key.howHold";
  if (activation === "toggle") return "wt.key.howTap";
  return "wt.key.howHoldOrTap";
}

/** What the Globe key also does while fn is the dictation key, from
 *  macOS's `AppleFnUsageType` (1 input source, 2 emoji, 3 dictation). */
export function globeUsageKey(
  usage: number | null | undefined,
):
  | "wt.globe.usage.inputSource"
  | "wt.globe.usage.emoji"
  | "wt.globe.usage.dictation"
  | "wt.globe.usage.other" {
  switch (usage) {
    case 1:
      return "wt.globe.usage.inputSource";
    case 2:
      return "wt.globe.usage.emoji";
    case 3:
      return "wt.globe.usage.dictation";
    default:
      return "wt.globe.usage.other";
  }
}

/* -------------------------------------------------------------- Pairing */

export function secondsLeft(expiresAtMs: number, nowMs: number): number {
  return Math.max(0, Math.ceil((expiresAtMs - nowMs) / 1000));
}

/** 600 → "10:00", 65 → "1:05". */
export function formatClock(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/* ------------------------------------------------------------ Word lists */

const sameWord = (a: string, b: string) =>
  a.toLocaleLowerCase("da") === b.toLocaleLowerCase("da");

/** Plain text, one entry per line (DESK-68). */
export function parseWordList(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const word = raw.trim();
    if (word && !out.some((w) => sameWord(w, word))) out.push(word);
  }
  return out;
}

export function exportWordList(words: readonly string[]): string {
  return words.length ? words.join("\n") + "\n" : "";
}

/** Handy stores custom words oldest first; the Ordliste shows newest first
 *  because the newest words go to the model first (DESK-66). */
export function newestFirst<T>(items: readonly T[]): T[] {
  return [...items].reverse();
}

/** Adds a word as the newest; a word already in the list moves up. */
export function addWord(words: readonly string[], word: string): string[] {
  const w = word.trim();
  if (!w) return [...words];
  return [...words.filter((x) => !sameWord(x, w)), w];
}

export function removeWord(words: readonly string[], word: string): string[] {
  return words.filter((x) => x !== word);
}

export function importWords(
  existing: readonly string[],
  imported: readonly string[],
): string[] {
  const out = [...existing];
  for (const w of imported) {
    if (!out.some((x) => sameWord(x, w))) out.push(w);
  }
  return out;
}

const REPLACEMENT_SEPARATORS = [" => ", "=>", " -> ", "->", "\t"];

/** "når jeg siger X, skriv Y" as plain text: one "X => Y" per line. Tabs and
 *  "->" are read too, so lists from a spreadsheet work. */
export function parseReplacements(text: string): Replacement[] {
  const out: Replacement[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const sep = REPLACEMENT_SEPARATORS.find((s) => raw.includes(s));
    if (!sep) continue;
    const at = raw.indexOf(sep);
    const from = raw.slice(0, at).trim();
    const to = raw.slice(at + sep.length).trim();
    if (from && to) out.push({ from, to });
  }
  return out;
}

export function exportReplacements(list: readonly Replacement[]): string {
  return (
    list.map((r) => `${r.from} => ${r.to}`).join("\n") +
    (list.length ? "\n" : "")
  );
}

/* ------------------------------------------------------------ AI cleanup */

export interface CleanupProvider {
  id: string;
  /** Product names are not translated. `null`: the label comes from i18n. */
  name: string | null;
  needsKey: boolean;
  macOnly?: boolean;
}

/** DESK-81, in the spec's order. */
export const CLEANUP_PROVIDERS: readonly CleanupProvider[] = [
  { id: "apple", name: "Apple Intelligence", needsKey: false, macOnly: true },
  { id: "openai", name: "OpenAI", needsKey: true },
  { id: "anthropic", name: "Anthropic", needsKey: true },
  { id: "groq", name: "Groq", needsKey: true },
  { id: "cerebras", name: "Cerebras", needsKey: true },
  { id: "openrouter", name: "OpenRouter", needsKey: true },
  { id: "custom", name: null, needsKey: true },
];

/** The host must be this computer itself, not merely start with
 *  "localhost" (http://localhost@host, http://localhost.example.com). */
function isLocalUrl(url: string): boolean {
  let host: string;
  try {
    host = new URL(url.trim()).hostname.toLowerCase();
  } catch {
    return false;
  }
  return (
    host === "localhost" ||
    host === "[::1]" ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
  );
}

/** Whether text leaves the computer (the backend's `is_cloud`). A custom
 *  provider without an endpoint uses the local default (Ollama). */
export function isCloudProvider(
  id: string | null | undefined,
  customBaseUrl: string | null | undefined,
): boolean {
  if (!id || id === "apple") return false;
  if (id === "custom") return !!customBaseUrl && !isLocalUrl(customBaseUrl);
  return true;
}

/** What a consent is given for (DESK-82): the provider, and for a custom
 *  endpoint also its host, so a new destination is asked about again. The
 *  backend's `consent_key` is the same. */
export function consentKey(
  id: string,
  customBaseUrl: string | null | undefined,
): string {
  if (id !== "custom") return id;
  try {
    return `custom:${new URL((customBaseUrl ?? "").trim()).host.toLowerCase()}`;
  } catch {
    return "custom:";
  }
}

export function cleanupConsentNeeded(s: {
  cleanup_mode: CleanupMode;
  cleanup_provider: string | null;
  cleanup_base_url: string | null;
  cleanup_consented: readonly string[];
}): boolean {
  if (s.cleanup_mode === "off" || !s.cleanup_provider) return false;
  if (!isCloudProvider(s.cleanup_provider, s.cleanup_base_url)) return false;
  return !s.cleanup_consented.includes(
    consentKey(s.cleanup_provider, s.cleanup_base_url),
  );
}

/** The {udbyder} of the consent text (DESK-82): the product name, or for a
 *  custom endpoint the host the text goes to. */
export function consentProviderName(
  id: string,
  customBaseUrl: string | null | undefined,
): string {
  if (id === "custom" && customBaseUrl) {
    try {
      return new URL(customBaseUrl).host;
    } catch {
      return customBaseUrl;
    }
  }
  return CLEANUP_PROVIDERS.find((p) => p.id === id)?.name ?? id;
}

/* ------------------------------------------------------------------ Keys */

export function keyParts(binding: string | null | undefined): string[] {
  if (!binding) return [];
  return binding
    .split("+")
    .map((p) => p.trim())
    .filter(Boolean);
}

/** Copilot keys arrive as Win+Shift+F23 (DESK-13). */
export function isCopilotBinding(binding: string | null | undefined): boolean {
  const parts = keyParts(binding).map((p) => p.toLowerCase());
  return (
    parts.length === 3 &&
    parts.includes("f23") &&
    parts.includes("shift") &&
    parts.some((p) => p === "super" || p === "win" || p === "meta")
  );
}

/* ------------------------------------------------------------------ Pill */

/** The lowest bar of the waveform: silence is a calm row of dots. */
export const WAVE_FLOOR = 0.12;

/** The backend's `mic-level` (one level per frequency band, low to high) as
 *  `bars` bar heights from WAVE_FLOOR to 1: the voice bands in the middle,
 *  mirrored outwards, so the waveform is symmetric. */
export function waveLevels(levels: readonly number[], bars: number): number[] {
  const out: number[] = [];
  const half = Math.ceil(bars / 2);
  const n = levels.length;
  for (let i = 0; i < bars; i++) {
    // 0 at the middle bar, 1 at the ends.
    const pos = half > 1 ? Math.abs(i - (bars - 1) / 2) / (half - 1) : 0;
    let v = 0;
    if (n) {
      // The middle shows the voice bands, the ends the higher ones.
      const at = Math.min(n - 1, Math.round(pos * (n - 1) * 0.75));
      v = Math.max(0, Math.min(1, levels[at] || 0));
      // A gentle hump, so the middle stands taller.
      v *= 1 - 0.45 * pos;
    }
    out.push(WAVE_FLOOR + (1 - WAVE_FLOOR) * Math.pow(v, 0.9));
  }
  return out;
}

/** Fast attack, slow release, per bar. */
export function smoothLevels(
  previous: readonly number[],
  next: readonly number[],
): number[] {
  return next.map((v, i) => {
    const p = previous[i];
    if (p == null) return v;
    return v > p ? p + (v - p) * 0.7 : p + (v - p) * 0.25;
  });
}

/** The backend's `wt-pill-end` state to the DictationPill state. */
export function pillStateFromEnd(state: string): DictationPillStateName {
  switch (state) {
    case "pasted":
      return "pasted";
    case "no_speech":
      return "nospeech";
    case "cleanup_skipped":
      return "raw";
    default:
      return "ready";
  }
}

/* ----------------------------------------------------------------- Model */

export const EDDA_MODEL_ID = "walkietalkey/edda-v0.2-gguf/edda-v0.2-Q8_0.gguf";
const FAST_MODEL_REPO = "walkietalkey/ekko-v1-tiny-gguf/";

export function findFastModelId(
  models: readonly { id: string }[],
): string | null {
  return models.find((m) => m.id.startsWith(FAST_MODEL_REPO))?.id ?? null;
}

/** "Hold talemodellen indlæst" (DESK-45) on Handy's model_unload_timeout.
 *  Handy's serde names are min15 and hour1 (the generated TypeScript type
 *  spells them differently). */
export const UNLOAD_OPTIONS = [
  { value: "never", labelKey: "wt.model.keepLoaded.always" },
  { value: "min15", labelKey: "wt.model.keepLoaded.min15" },
  { value: "hour1", labelKey: "wt.model.keepLoaded.hour1" },
] as const;
export type UnloadChoice = (typeof UNLOAD_OPTIONS)[number]["value"];

export function unloadChoice(
  value: string | null | undefined,
): UnloadChoice | null {
  if (!value) return "never";
  return UNLOAD_OPTIONS.find((o) => o.value === value)?.value ?? null;
}

export function totalSizeMb(
  models: readonly { size_mb: number; is_downloaded: boolean }[],
): number {
  return models
    .filter((m) => m.is_downloaded)
    .reduce((sum, m) => sum + m.size_mb, 0);
}

/** Danish number format: "1,0 GB", "130 MB". */
export function formatSizeMb(mb: number): string {
  if (mb >= 1000) return `${(mb / 1000).toFixed(1).replace(".", ",")} GB`;
  return `${Math.round(mb)} MB`;
}

/* --------------------------------------------------------------- History */

/** DESK-91, in the spec's order. */
export const RETENTION_OPTIONS: readonly HistoryRetentionName[] = [
  "dont_keep",
  "day",
  "two_weeks",
  "ninety_days",
  "forever",
];

/** Days since 1970-01-01 UTC, the unit of the relay's last-seen day. */
export function dayNumber(nowMs: number): number {
  return Math.floor(nowMs / 86_400_000);
}

export type LastSeen =
  | { kind: "today" }
  | { kind: "yesterday" }
  | { kind: "date"; date: Date };

/** "Sidst set" for a phone that is not online, or null when never seen. */
export function lastSeen(
  day: number | null | undefined,
  today: number,
): LastSeen | null {
  if (day == null || day <= 0) return null;
  const ago = today - day;
  if (ago <= 0) return { kind: "today" };
  if (ago === 1) return { kind: "yesterday" };
  return { kind: "date", date: new Date(day * 86_400_000) };
}
