/* The front page's build-time choices, its shared copy and the run 5 signature animation's timeline (SITE-02, SITE-06,
   spec 2.6). */
import { describe, expect, it } from "vitest";
import {
  CONCEPTS,
  CONCEPT_INFO,
  PREVIEW_BRANCHES,
  SHARED_PREFIX,
  conceptDir,
  draftClaims,
  pickConcept,
  previewBranch,
} from "../src/lib/build";
import {
  FAQ,
  FEATURES,
  FEATURE_ORDER,
  KICKER,
  PRIVACY_FACTS,
  SHOWCASE,
  SHOWCASE_INTRO,
  SHOWCASE_ORDER,
  STAGE,
  STEPS as START_STEPS,
  TRY,
} from "../src/lib/features";
import { HERO } from "../src/lib/hero";
import {
  FINAL_STEP,
  LOOP_MS,
  STAGE_WORDS,
  STEPS,
  WORD_MS,
  WORD_START_MS,
  stepAt,
} from "../src/lib/stage";

describe("front page choices (run 8, chosen at build time)", () => {
  it("has the three final pages, named by their hero's background", () => {
    expect(CONCEPTS).toEqual(["waves", "bars", "metal"]);
    expect(CONCEPTS.map((c) => CONCEPT_INFO[c].n)).toEqual([1, 2, 3]);
    /* each page's own rules have their own prefix; the shared sections have one of their own */
    const prefixes = CONCEPTS.map((c) => CONCEPT_INFO[c].prefix);
    expect(new Set([...prefixes, SHARED_PREFIX]).size).toBe(4);
  });
  it("builds the current front page, the one in production, without SITE_CONCEPT", () => {
    expect(pickConcept(undefined)).toBeNull();
    expect(pickConcept(" ")).toBeNull();
    expect(conceptDir(null)).toBe("current");
  });
  it("picks a page by name or by number", () => {
    for (const c of CONCEPTS) {
      expect(pickConcept(c)).toBe(c);
      expect(pickConcept(c.toUpperCase())).toBe(c);
      expect(pickConcept(String(CONCEPT_INFO[c].n))).toBe(c);
      expect(conceptDir(c)).toBe(c);
    }
  });
  it("refuses an unknown page instead of building the wrong one", () => {
    expect(() => pickConcept("main")).toThrow(/SITE_CONCEPT/);
    expect(() => pickConcept("stage")).toThrow(/SITE_CONCEPT/);
  });
  it("shows unmeasured claims only in draft builds", () => {
    expect(draftClaims(undefined)).toBe(false);
    expect(draftClaims("0")).toBe(false);
    expect(draftClaims("1")).toBe(true);
  });
  it("deploys each page to its own preview branch, never to production", () => {
    expect(PREVIEW_BRANCHES).toEqual(["final-1", "final-2", "final-3"]);
    for (const c of CONCEPTS)
      expect(previewBranch(c)).not.toMatch(/^(main|master|production)$/);
  });
});

describe("the front page's shared copy (run 6, run 8)", () => {
  const strings = (v: unknown): string[] =>
    typeof v === "string"
      ? [v]
      : Array.isArray(v)
        ? v.flatMap(strings)
        : v && typeof v === "object"
          ? Object.values(v).flatMap(strings)
          : [];
  it("lists every feature of the brief once, in order", () => {
    expect(FEATURE_ORDER).toEqual([
      "fn",
      "phone",
      "corrections",
      "mixed",
      "words",
      "notify",
      "privacy",
      "oss",
      "free",
      "start",
      "faq",
    ]);
    expect(Object.keys(FEATURES).sort()).toEqual([...FEATURE_ORDER].sort());
  });
  it("is Danish copy without em dashes, exclamation marks or 'direkte' (spec 2.6, Appendix A)", () => {
    for (const s of strings([
      FEATURES,
      FAQ,
      PRIVACY_FACTS,
      START_STEPS,
      SHOWCASE,
      SHOWCASE_INTRO,
      KICKER,
      STAGE,
      TRY,
    ]))
      expect(s, s).not.toMatch(/[—!]|direkte/i);
  });
  it("keeps the production front page's feature sections word for word (run 8)", () => {
    expect(SHOWCASE_ORDER.map((k) => SHOWCASE[k].title)).toEqual([
      "Hold fn, tal, slip",
      "Eller tal ind i telefonen",
      "Den retter dig, når du retter dig selv",
      "Dansk og engelsk i samme sætning",
      "Lander som en notifikation",
      "Til den computer, du sidder ved",
      "Dine ord, stavet rigtigt",
    ]);
    expect(SHOWCASE_ORDER.map((k) => SHOWCASE[k].scene)).toEqual([
      "fn",
      "telefon",
      "renskriv",
      "sprog",
      "notifikation",
      "enheder",
      "ordliste",
    ]);
    expect(SHOWCASE_INTRO.title).toBe("Lavet til den måde, du taler på");
    /* the unmeasured parts stay claims: whispering, English words written as said */
    expect(SHOWCASE.phone.claim!.text).toMatch(/hvisk/i);
    expect(SHOWCASE.mixed.claim!.text).toMatch(/engelske ord, som du siger/);
    for (const k of SHOWCASE_ORDER)
      expect(SHOWCASE[k].text + (SHOWCASE[k].body ?? "")).not.toMatch(
        /hvisk|som du siger dem/i,
      );
  });
  it("keeps whispering a claim until it is measured", () => {
    expect(FEATURES.phone.body + FEATURES.phone.short).not.toMatch(/hvisk/i);
    expect(FEATURES.phone.claim!.text).toMatch(/hvisk/i);
    expect(FAQ.find((q) => /hvisk/i.test(q.q))!.claim).toBeTruthy();
  });
  it("ties self-corrections to the optional AI cleanup (spec 6.10, PRIV-04)", () => {
    expect(FEATURES.corrections.short).toMatch(/AI-oprydning/);
    expect(FEATURES.corrections.body).toMatch(/valgfri og slået fra/);
  });
  it("says privacy in four facts that hold, the first two word for word (spec 2.6)", () => {
    expect(PRIVACY_FACTS.map((f) => f.title)).toEqual([
      "Talen bliver til tekst på din egen computer",
      "Krypteret fra telefon til computer",
      "Ingen lyd gemmes",
      "Ingen konto",
    ]);
  });
  it("gets started in three steps", () => {
    expect(START_STEPS).toHaveLength(3);
  });
  it("keeps the current front page's slogan", () => {
    expect(HERO.title).toBe("Tal. Slip. Indsæt.");
    for (const s of strings(HERO)) expect(s).not.toMatch(/[—!]|direkte/i);
  });
});

describe("the signature animation's timeline", () => {
  it("goes idle, rec, send, ready, reset, and ends calm on ready", () => {
    expect(STEPS.map(([s]) => s)).toEqual([
      "idle",
      "rec",
      "send",
      "ready",
      "reset",
    ]);
    expect(FINAL_STEP).toBe("ready");
    expect(LOOP_MS).toBe(STEPS.reduce((a, [, ms]) => a + ms, 0));
  });
  it("lets every word appear while the phone is still recording", () => {
    const rec = STEPS.find(([s]) => s === "rec")![1];
    expect(WORD_START_MS + STAGE_WORDS.length * WORD_MS).toBeLessThan(rec);
    /* a calm pace of speech: 2.5 to 4.5 words a second */
    expect(1000 / WORD_MS).toBeGreaterThan(2.5);
    expect(1000 / WORD_MS).toBeLessThan(4.5);
  });
  it("says a Danish sentence with an English word in it (spec 2.5)", () => {
    expect(STAGE_WORDS.join(" ")).toBe(
      "Hej Mette. Jeg er ti minutter forsinket, så bare start uden mig. Jeg tager slides med.",
    );
  });
  it("finds the step at any moment of the loop", () => {
    expect(stepAt(0)).toEqual({ step: "idle", left: STEPS[0][1] });
    expect(stepAt(STEPS[0][1])).toEqual({ step: "rec", left: STEPS[1][1] });
    expect(stepAt(LOOP_MS - 1).step).toBe("reset");
    expect(stepAt(LOOP_MS)).toEqual(stepAt(0));
    expect(stepAt(LOOP_MS * 3 + STEPS[0][1] + 10).step).toBe("rec");
  });
});
