// Pure helpers behind the WalkieTalkey screens. Run with `bun test src/walkietalkey`.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  addWord,
  consentKey,
  dayNumber,
  lastSeen,
  cleanupConsentNeeded,
  consentProviderName,
  EDDA_MODEL_ID,
  exportReplacements,
  exportWordList,
  findFastModelId,
  formatClock,
  importWords,
  isCloudProvider,
  isCopilotBinding,
  keyParts,
  nextStep,
  onboardingSteps,
  parseReplacements,
  parseWordList,
  pillStateFromEnd,
  previousStep,
  removeWord,
  resumeStep,
  secondsLeft,
  unloadChoice,
  newestFirst,
  RETENTION_OPTIONS,
  UNLOAD_OPTIONS,
  totalSizeMb,
  formatSizeMb,
} from "./helpers";

describe("onboarding steps (DESK-10..17)", () => {
  test("a Mac gets all eight steps in the spec's order", () => {
    assert.deepEqual(onboardingSteps("macos", { phonePairing: true }), [
      "welcome",
      "model",
      "microphone",
      "key",
      "paste",
      "notifications",
      "phone",
      "try",
    ]);
  });

  test("Windows has no Accessibility step; paste works without it", () => {
    const steps = onboardingSteps("windows", { phonePairing: true });
    assert.ok(!steps.includes("paste"));
    assert.equal(steps[0], "welcome");
    assert.equal(steps[steps.length - 1], "try");
  });

  test("no phone step when the company forbids pairing", () => {
    assert.ok(
      !onboardingSteps("macos", { phonePairing: false }).includes("phone"),
    );
  });

  test("next and previous walk the list and stop at the ends", () => {
    const steps = onboardingSteps("macos", { phonePairing: true });
    assert.equal(nextStep(steps, "welcome"), "model");
    assert.equal(nextStep(steps, "try"), null);
    assert.equal(previousStep(steps, "model"), "welcome");
    assert.equal(previousStep(steps, "welcome"), null);
  });

  test("resume picks the stored step, or the next one that exists here", () => {
    const mac = onboardingSteps("macos", { phonePairing: true });
    const win = onboardingSteps("windows", { phonePairing: false });
    assert.equal(resumeStep("key", mac), "key");
    assert.equal(resumeStep("paste", win), "notifications");
    assert.equal(resumeStep("phone", win), "try");
    assert.equal(resumeStep(null, mac), null);
    assert.equal(resumeStep("nonsense", mac), null);
  });
});

describe("pairing countdown (spec 5.3)", () => {
  test("seconds left rounds up and never goes below zero", () => {
    assert.equal(secondsLeft(10_000, 0), 10);
    assert.equal(secondsLeft(10_000, 9_001), 1);
    assert.equal(secondsLeft(10_000, 12_000), 0);
  });

  test("clock format is m:ss", () => {
    assert.equal(formatClock(600), "10:00");
    assert.equal(formatClock(65), "1:05");
    assert.equal(formatClock(0), "0:00");
  });
});

describe("word lists (DESK-66, DESK-68)", () => {
  test("plain text import: one entry per line, trimmed, no blanks or repeats", () => {
    assert.deepEqual(
      parseWordList(" Rentoft \n\nWalkieTalkey\nrentoft\r\nEdda"),
      ["Rentoft", "WalkieTalkey", "Edda"],
    );
  });

  test("export writes one word per line", () => {
    assert.equal(exportWordList(["a", "b"]), "a\nb\n");
    assert.equal(exportWordList([]), "");
  });

  test("words are stored oldest first and shown newest first", () => {
    let words: string[] = [];
    words = addWord(words, "Edda");
    words = addWord(words, " Ekko ");
    assert.deepEqual(words, ["Edda", "Ekko"]);
    assert.deepEqual(newestFirst(words), ["Ekko", "Edda"]);
    // Adding an existing word again makes it the newest, in the new spelling.
    assert.deepEqual(addWord(words, "edda"), ["Ekko", "edda"]);
    assert.deepEqual(addWord(words, "   "), words);
    assert.deepEqual(removeWord(words, "Edda"), ["Ekko"]);
  });

  test("import appends only new words", () => {
    assert.deepEqual(importWords(["Edda"], ["edda", "Ekko"]), ["Edda", "Ekko"]);
  });

  test("replacements round-trip as 'X => Y' lines", () => {
    const list = [
      { from: "walkie talkie", to: "WalkieTalkey" },
      { from: "pe en", to: "PN" },
    ];
    const text = exportReplacements(list);
    assert.equal(text, "walkie talkie => WalkieTalkey\npe en => PN\n");
    assert.deepEqual(parseReplacements(text), list);
  });

  test("replacement import also reads tabs and arrows, and skips broken lines", () => {
    assert.deepEqual(parseReplacements("a\tb\nc -> d\nno separator\n => e\n"), [
      { from: "a", to: "b" },
      { from: "c", to: "d" },
    ]);
  });
});

describe("AI cleanup (DESK-80..82)", () => {
  test("Apple Intelligence and local endpoints are not cloud", () => {
    assert.equal(isCloudProvider("apple", null), false);
    assert.equal(isCloudProvider("custom", "http://localhost:11434/v1"), false);
    assert.equal(isCloudProvider("custom", "http://127.0.0.1:1234/v1"), false);
    assert.equal(
      isCloudProvider("custom", "https://example.openai.azure.com"),
      true,
    );
    assert.equal(isCloudProvider("custom", null), false);
    assert.equal(isCloudProvider("openai", null), true);
  });

  test("consent is needed before a cloud provider is turned on", () => {
    const base = {
      cleanup_mode: "always" as const,
      cleanup_provider: "openai",
      cleanup_base_url: null,
      cleanup_consented: [] as string[],
    };
    assert.equal(cleanupConsentNeeded(base), true);
    assert.equal(
      cleanupConsentNeeded({ ...base, cleanup_consented: ["openai"] }),
      false,
    );
    assert.equal(cleanupConsentNeeded({ ...base, cleanup_mode: "off" }), false);
    assert.equal(
      cleanupConsentNeeded({ ...base, cleanup_provider: "apple" }),
      false,
    );
    assert.equal(
      cleanupConsentNeeded({ ...base, cleanup_provider: null }),
      false,
    );
  });

  test("the consent text names the provider, or the host of a custom endpoint", () => {
    assert.equal(consentProviderName("anthropic", null), "Anthropic");
    assert.equal(
      consentProviderName("custom", "https://firma.openai.azure.com/openai"),
      "firma.openai.azure.com",
    );
  });
});

describe("keys (DESK-13, DESK-21)", () => {
  test("a binding splits into its keys", () => {
    assert.deepEqual(keyParts("fn"), ["fn"]);
    assert.deepEqual(keyParts("ctrl_right"), ["ctrl_right"]);
    assert.deepEqual(keyParts("super+shift+f23"), ["super", "shift", "f23"]);
    assert.deepEqual(keyParts(""), []);
  });

  test("the Copilot key arrives as Win+Shift+F23", () => {
    assert.equal(isCopilotBinding("super+shift+f23"), true);
    assert.equal(isCopilotBinding("shift+super+f23"), true);
    assert.equal(isCopilotBinding("ctrl_right"), false);
  });
});

describe("pill (DESK-55)", () => {
  test("each end state maps to the design system's pill state", () => {
    assert.equal(pillStateFromEnd("pasted"), "pasted");
    assert.equal(pillStateFromEnd("clipboard"), "ready");
    assert.equal(pillStateFromEnd("no_speech"), "nospeech");
    assert.equal(pillStateFromEnd("cleanup_skipped"), "raw");
    assert.equal(pillStateFromEnd("something_else"), "ready");
  });
});

describe("model (DESK-30, DESK-31, DESK-45)", () => {
  test("Hold talemodellen indlæst offers Altid, 15 minutes and 1 hour", () => {
    assert.deepEqual(
      UNLOAD_OPTIONS.map((o) => o.value),
      ["never", "min15", "hour1"],
    );
    assert.equal(unloadChoice("never"), "never");
    assert.equal(unloadChoice("hour1"), "hour1");
    assert.equal(unloadChoice("min5"), null);
    assert.equal(unloadChoice(undefined), "never");
  });

  test("the fast model is found by its repository", () => {
    assert.equal(
      findFastModelId([
        { id: EDDA_MODEL_ID },
        { id: "walkietalkey/ekko-v1-tiny-gguf/ekko-v1-tiny-Q8_0.gguf" },
      ]),
      "walkietalkey/ekko-v1-tiny-gguf/ekko-v1-tiny-Q8_0.gguf",
    );
    assert.equal(findFastModelId([{ id: EDDA_MODEL_ID }]), null);
  });

  test("space used adds up the downloaded models", () => {
    assert.equal(
      totalSizeMb([
        { size_mb: 890, is_downloaded: true },
        { size_mb: 130, is_downloaded: true },
        { size_mb: 1500, is_downloaded: false },
      ]),
      1020,
    );
    assert.equal(formatSizeMb(1020), "1,0 GB");
    assert.equal(formatSizeMb(130), "130 MB");
  });
});

describe("history (DESK-91)", () => {
  test("retention options are in the spec's order", () => {
    assert.deepEqual(RETENTION_OPTIONS, [
      "dont_keep",
      "day",
      "two_weeks",
      "ninety_days",
      "forever",
    ]);
  });
});

describe("lastSeen", () => {
  test("today, yesterday or the date the relay last saw the phone", () => {
    const today = dayNumber(Date.UTC(2026, 9, 23, 12));
    assert.equal(today, 20_749);
    assert.deepEqual(lastSeen(today, today), { kind: "today" });
    assert.deepEqual(lastSeen(today - 1, today), { kind: "yesterday" });
    const old = lastSeen(today - 3, today);
    assert.equal(old?.kind, "date");
    assert.equal(
      old?.kind === "date" ? old.date.toISOString().slice(0, 10) : "",
      "2026-10-20",
    );
    assert.equal(lastSeen(null, today), null);
    assert.equal(lastSeen(0, today), null);
  });
});

describe("isCloudProvider with tricky custom endpoints", () => {
  test("only this computer is on the device", () => {
    assert.equal(isCloudProvider("custom", "http://localhost:11434/v1"), false);
    assert.equal(isCloudProvider("custom", "http://127.0.0.1:8080/v1"), false);
    assert.equal(isCloudProvider("custom", "http://[::1]:11434/v1"), false);
    assert.equal(
      isCloudProvider("custom", "http://localhost@api.example.com/v1"),
      true,
    );
    assert.equal(
      isCloudProvider("custom", "http://localhost.example.com/v1"),
      true,
    );
    assert.equal(isCloudProvider("custom", "http://127.0.0.1.nip.io/v1"), true);
  });
});

describe("consentKey", () => {
  test("a custom endpoint's consent covers only its host, as the backend's", () => {
    assert.equal(consentKey("openai", null), "openai");
    assert.equal(
      consentKey("custom", "https://Firma.openai.azure.com/v1"),
      "custom:firma.openai.azure.com",
    );
    assert.equal(
      consentKey("custom", "http://gpu.lan:8080/v1"),
      "custom:gpu.lan:8080",
    );
    assert.notEqual(
      consentKey("custom", "https://a.example/v1"),
      consentKey("custom", "https://b.example/v1"),
    );
  });
});
