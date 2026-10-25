// Pure helpers behind the WalkieTalkey screens. Run with `bun test src/walkietalkey`.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  formatValidationWer,
  formatVersionDate,
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
  forwardStep,
  globeUsageKey,
  keyModeKey,
  ONBOARDING_DONE,
  onboardingFinished,
  smoothLevels,
  WAVE_FLOOR,
  waveLevels,
  importWords,
  isCloudProvider,
  isCopilotBinding,
  keyParts,
  micNotice,
  micPillHint,
  nextStep,
  onboardingSteps,
  dictationWorked,
  phoneOfferPending,
  resumeOptions,
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

describe("onboarding steps (DESK-10..17, run 2: plug and play)", () => {
  test("a Mac: Velkommen, Mikrofon, Tilgængelighed, Prøv det, Telefon, Klar", () => {
    assert.deepEqual(
      onboardingSteps("macos", { phonePairing: true, dictated: true }),
      ["welcome", "microphone", "accessibility", "try", "phone", "done"],
    );
  });

  test("Windows has no Tilgængelighed step: the key and paste need no permission", () => {
    assert.deepEqual(
      onboardingSteps("windows", { phonePairing: true, dictated: true }),
      ["welcome", "microphone", "try", "phone", "done"],
    );
  });

  test("no model step and no Input Monitoring step any more", () => {
    for (const platform of ["macos", "windows"] as const) {
      const steps: string[] = onboardingSteps(platform, {
        phonePairing: true,
        dictated: true,
      });
      for (const gone of ["model", "key", "paste", "notifications"])
        assert.ok(!steps.includes(gone), `${platform} still has ${gone}`);
    }
  });

  test("no phone step when the company forbids pairing", () => {
    assert.deepEqual(
      onboardingSteps("macos", { phonePairing: false, dictated: true }),
      ["welcome", "microphone", "accessibility", "try", "done"],
    );
  });

  test("run 5: Telefon comes only after a dictation that worked, never before", () => {
    assert.deepEqual(
      onboardingSteps("macos", { phonePairing: true, dictated: false }),
      ["welcome", "microphone", "accessibility", "try", "done"],
    );
    // Prøv det moves straight on to Klar until a dictation works.
    const before = onboardingSteps("macos", {
      phonePairing: true,
      dictated: false,
    });
    assert.equal(nextStep(before, "try"), "done");
    // A restart at Telefon was reached after a dictation that worked.
    assert.equal(
      resumeStep(
        "phone",
        onboardingSteps("macos", resumeOptions("phone", true)),
      ),
      "phone",
    );
    assert.equal(
      resumeStep("try", onboardingSteps("macos", resumeOptions("try", true))),
      "try",
    );
  });

  test("run 5: a dictation worked when it was pasted or put on the clipboard", () => {
    assert.equal(dictationWorked("pasted"), true);
    assert.equal(dictationWorked("clipboard"), true);
    assert.equal(dictationWorked("cleanup_skipped"), true);
    assert.equal(dictationWorked("no_speech"), false);
    assert.equal(dictationWorked("mic_silent"), false);
    assert.equal(dictationWorked(undefined), false);
  });

  test("run 5: pairing is offered later only when onboarding ended without it", () => {
    assert.equal(
      phoneOfferPending({ phonePairing: true, phoneStepShown: false }),
      true,
    );
    assert.equal(
      phoneOfferPending({ phonePairing: true, phoneStepShown: true }),
      false,
    );
    assert.equal(
      phoneOfferPending({ phonePairing: false, phoneStepShown: false }),
      false,
    );
  });

  test("next and previous walk the list and stop at the ends", () => {
    const steps = onboardingSteps("macos", {
      phonePairing: true,
      dictated: true,
    });
    assert.equal(nextStep(steps, "welcome"), "microphone");
    assert.equal(nextStep(steps, "try"), "phone");
    assert.equal(nextStep(steps, "done"), null);
    assert.equal(previousStep(steps, "microphone"), "welcome");
    assert.equal(previousStep(steps, "welcome"), null);
  });

  test("going forward skips a permission step that is already granted", () => {
    const mac = onboardingSteps("macos", {
      phonePairing: true,
      dictated: true,
    });
    const none = { microphone: false, accessibility: false };
    assert.equal(forwardStep(mac, "welcome", none), "microphone");
    assert.equal(
      forwardStep(mac, "welcome", { microphone: true, accessibility: false }),
      "accessibility",
    );
    assert.equal(
      forwardStep(mac, "welcome", { microphone: true, accessibility: true }),
      "try",
    );
    assert.equal(
      forwardStep(mac, "microphone", { microphone: true, accessibility: true }),
      "try",
    );
    assert.equal(forwardStep(mac, "try", none), "phone");
    assert.equal(forwardStep(mac, "done", none), null);
  });

  test("resume picks the stored step, or the next one that exists here", () => {
    const mac = onboardingSteps("macos", {
      phonePairing: true,
      dictated: true,
    });
    const win = onboardingSteps("windows", {
      phonePairing: false,
      dictated: true,
    });
    assert.equal(resumeStep("accessibility", mac), "accessibility");
    assert.equal(resumeStep("accessibility", win), "try");
    assert.equal(resumeStep("phone", win), "done");
    assert.equal(resumeStep(null, mac), null);
    assert.equal(resumeStep("nonsense", mac), null);
  });

  test("v1's stored steps resume at the step that replaced them", () => {
    const mac = onboardingSteps("macos", {
      phonePairing: true,
      dictated: true,
    });
    const win = onboardingSteps("windows", {
      phonePairing: true,
      dictated: true,
    });
    assert.equal(resumeStep("model", mac), "microphone");
    assert.equal(resumeStep("key", mac), "accessibility");
    assert.equal(resumeStep("paste", mac), "accessibility");
    assert.equal(resumeStep("key", win), "try");
    assert.equal(resumeStep("notifications", mac), "try");
  });

  test("a finished onboarding is remembered as done, not as a step", () => {
    const mac = onboardingSteps("macos", {
      phonePairing: true,
      dictated: true,
    });
    assert.equal(resumeStep(ONBOARDING_DONE, mac), null);
    assert.equal(onboardingFinished(ONBOARDING_DONE), true);
    assert.equal(onboardingFinished("try"), false);
    assert.equal(onboardingFinished(null), false);
  });
});

describe("tap or hold (Phase 1, DESK-22)", () => {
  test("the key's mode in words", () => {
    assert.equal(keyModeKey("hold_or_toggle"), "wt.key.howHoldOrTap");
    assert.equal(keyModeKey(undefined), "wt.key.howHoldOrTap");
    assert.equal(keyModeKey("push_to_talk"), "wt.key.howHold");
    assert.equal(keyModeKey("toggle"), "wt.key.howTap");
  });
});

describe("Globe key (Phase 1)", () => {
  test("what fn also does, from AppleFnUsageType", () => {
    assert.equal(globeUsageKey(1), "wt.globe.usage.inputSource");
    assert.equal(globeUsageKey(2), "wt.globe.usage.emoji");
    assert.equal(globeUsageKey(3), "wt.globe.usage.dictation");
    assert.equal(globeUsageKey(null), "wt.globe.usage.other");
    assert.equal(globeUsageKey(7), "wt.globe.usage.other");
  });
});

describe("live waveform (DESK-55)", () => {
  test("one level per bar, loudest in the middle, always a visible dot", () => {
    const bars = waveLevels(
      [0, 0, 0, 0, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0],
      9,
    );
    assert.equal(bars.length, 9);
    for (const b of bars) assert.ok(b >= WAVE_FLOOR && b <= 1);
    // Symmetric around the middle bar.
    for (let i = 0; i < 4; i++) assert.equal(bars[i], bars[8 - i]);
  });

  test("silence is a calm row of dots", () => {
    assert.deepEqual(waveLevels([], 5), Array(5).fill(WAVE_FLOOR));
    assert.deepEqual(waveLevels([0, 0, 0], 3), Array(3).fill(WAVE_FLOOR));
  });

  test("bars rise fast and fall slowly", () => {
    const up = smoothLevels([0.1, 0.1], [1, 1]);
    const down = smoothLevels([1, 1], [0, 0]);
    assert.ok(up[0] > 0.5, "attack is fast");
    assert.ok(down[0] > 0.6, "release is slow");
    assert.deepEqual(smoothLevels([], [0.5]), [0.5]);
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
    assert.equal(pillStateFromEnd("mic_silent"), "micsilent");
    assert.equal(pillStateFromEnd("cleanup_skipped"), "raw");
    assert.equal(pillStateFromEnd("something_else"), "ready");
  });
});

describe("silent microphone (DESK-59)", () => {
  const silent = (over: Record<string, unknown> = {}) => ({
    silent_input: "Scarlett Solo USB",
    suggestion: null,
    probing: false,
    ...over,
  });

  test("no notice while the input works", () => {
    assert.equal(micNotice(null), null);
    assert.equal(
      micNotice({ silent_input: null, suggestion: null, probing: false }),
      null,
    );
    assert.equal(micPillHint(null), null);
  });

  test("looking, then a suggestion with Brug, or plainly none", () => {
    assert.deepEqual(micNotice(silent({ probing: true })), {
      key: "wt.mic.searching",
      name: "Scarlett Solo USB",
    });
    assert.deepEqual(
      micNotice(silent({ suggestion: "MacBook Pro-mikrofon" })),
      {
        key: "wt.mic.try",
        name: "Scarlett Solo USB",
        other: "MacBook Pro-mikrofon",
      },
    );
    assert.deepEqual(micNotice(silent()), {
      key: "wt.mic.none",
      name: "Scarlett Solo USB",
    });
  });

  test("the pill adds Prøv {navn} or Tjek mikrofonen once the probe is done", () => {
    assert.equal(micPillHint(silent({ probing: true })), null);
    assert.deepEqual(
      micPillHint(silent({ suggestion: "MacBook Pro-mikrofon" })),
      { key: "wt.pill.micTry", name: "MacBook Pro-mikrofon" },
    );
    assert.deepEqual(micPillHint(silent()), { key: "wt.pill.micNone" });
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

describe("versions of Edda (run 6)", () => {
  test("the export date in Danish", () => {
    assert.equal(
      formatVersionDate("2026-10-25T12:00:00+00:00"),
      "25. okt. 2026",
    );
    assert.equal(formatVersionDate(null), null);
    assert.equal(formatVersionDate("not a date"), null);
  });
  test("the validation WER as a Danish percentage", () => {
    assert.equal(formatValidationWer(0.061), "6,1 %");
    assert.equal(formatValidationWer(0.0583), "5,8 %");
    assert.equal(formatValidationWer(null), null);
  });
});
