/* The front page's build-time choices and the signature animation's timeline (run 5: SITE-02, SITE-06, spec 2.6). */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_HERO,
  HERO,
  HERO_VARIANTS,
  draftClaims,
  pickHero,
} from "../src/lib/hero";
import {
  FINAL_STEP,
  LOOP_MS,
  STAGE_WORDS,
  STEPS,
  WORD_MS,
  WORD_START_MS,
  stepAt,
} from "../src/lib/stage";

describe("hero variants (chosen at build time)", () => {
  it("has the three variants, fn-led by default", () => {
    expect(HERO_VARIANTS).toEqual(["fn", "phone", "privacy"]);
    expect(DEFAULT_HERO).toBe("fn");
  });
  it("picks the variant from SITE_HERO, and the default without one", () => {
    expect(pickHero(undefined)).toBe("fn");
    expect(pickHero("")).toBe("fn");
    for (const v of HERO_VARIANTS) expect(pickHero(v)).toBe(v);
    expect(pickHero(" Phone ")).toBe("phone");
  });
  it("refuses an unknown variant instead of building the wrong page", () => {
    expect(() => pickHero("main")).toThrow(/SITE_HERO/);
  });
  it("shows unmeasured claims only in draft builds", () => {
    expect(draftClaims(undefined)).toBe(false);
    expect(draftClaims("0")).toBe(false);
    expect(draftClaims("1")).toBe(true);
  });
  it.each(HERO_VARIANTS)(
    "%s has a title, a lead and a line under the buttons, in Danish without em dashes or exclamation marks",
    (v) => {
      const h = HERO[v];
      for (const s of [h.title, h.lead, h.fine])
        expect(s.length).toBeGreaterThan(5);
      for (const s of Object.values(h))
        expect(String(s)).not.toMatch(/[—!]|direkte/i);
    },
  );
  it("says free and open source under every variant's buttons", () => {
    for (const v of HERO_VARIANTS)
      expect(HERO[v].fine).toMatch(/^Gratis og open source · /);
  });
  it("gives each variant its own title", () => {
    const titles = HERO_VARIANTS.map((v) => HERO[v].title);
    expect(new Set(titles).size).toBe(3);
    expect(HERO.fn.title).toBe("Tal. Slip. Indsæt.");
    /* spec 2.6: the privacy-led title is one of the claims that hold, word for word */
    expect(HERO.privacy.title).toBe(
      "Talen bliver til tekst på din egen computer.",
    );
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
