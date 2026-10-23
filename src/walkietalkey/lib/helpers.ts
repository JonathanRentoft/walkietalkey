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

/** The onboarding steps of spec 6.2, in order (DESK-10..17). */
export const ONBOARDING_STEPS = [
  "welcome",
  "model",
  "microphone",
  "key",
  "paste",
  "notifications",
  "phone",
  "try",
] as const;
export type OnboardingStepId = (typeof ONBOARDING_STEPS)[number];

/** The steps this computer shows. Accessibility (step 5) is a Mac
 *  permission; Windows pastes without it. The phone step needs pairing to be
 *  allowed (Appendix B `AllowPhonePairing`). */
export function onboardingSteps(
  platform: WtPlatform,
  opts: { phonePairing: boolean },
): OnboardingStepId[] {
  return ONBOARDING_STEPS.filter((step) => {
    if (step === "paste") return platform === "macos";
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

/** Where to resume after a restart (DESK-13): the stored step, or the next
 *  step that exists on this computer. */
export function resumeStep(
  saved: string | null | undefined,
  steps: readonly OnboardingStepId[],
): OnboardingStepId | null {
  if (!saved) return null;
  const all = ONBOARDING_STEPS as readonly string[];
  const at = all.indexOf(saved);
  if (at < 0) return null;
  for (let i = at; i < all.length; i++) {
    const step = all[i] as OnboardingStepId;
    if (steps.includes(step)) return step;
  }
  return null;
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

function isLocalUrl(url: string): boolean {
  const u = url.trim().toLowerCase();
  return (
    u.startsWith("http://localhost") ||
    u.startsWith("http://127.0.0.1") ||
    u.startsWith("http://[::1]")
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

export function cleanupConsentNeeded(s: {
  cleanup_mode: CleanupMode;
  cleanup_provider: string | null;
  cleanup_base_url: string | null;
  cleanup_consented: readonly string[];
}): boolean {
  if (s.cleanup_mode === "off" || !s.cleanup_provider) return false;
  if (!isCloudProvider(s.cleanup_provider, s.cleanup_base_url)) return false;
  return !s.cleanup_consented.includes(s.cleanup_provider);
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
