/* The front page's copy and its one script's choices (run 10; SITE-02, SITE-06, spec 2.6). */
import { describe, expect, it } from "vitest";
import { pickLive } from "../src/components/front/front";
import * as copy from "../src/lib/features";
import {
  FAQ,
  FEATURES,
  PRIVACY_FACTS,
  ROW_ORDER,
  SHOWCASE,
  SHOWCASE_INTRO,
  SHOWCASE_ORDER,
  SPEED,
  STEPS,
  boxSide,
} from "../src/lib/features";

const strings = (v: unknown): string[] =>
  typeof v === "string"
    ? [v]
    : Array.isArray(v)
      ? v.flatMap(strings)
      : v && typeof v === "object"
        ? Object.values(v).flatMap(strings)
        : [];

describe("the front page's copy (run 10)", () => {
  const all = strings(
    Object.values(copy).filter((v) => typeof v !== "function"),
  );

  it("is Danish copy without em dashes, exclamation marks or 'direkte' (spec 2.6, Appendix A)", () => {
    for (const s of all) expect(s, s).not.toMatch(/[—!]|direkte/i);
  });

  it("holds no unmeasured claim and nothing pending, not even as data", () => {
    for (const s of all) {
      expect(s, s).not.toMatch(/hvisk|tale lavt|som du siger dem/i);
      expect(s, s).not.toMatch(/TODO|bekræft|ikke målt/i);
    }
    for (const f of [...Object.values(FEATURES), ...Object.values(SHOWCASE)])
      expect(f, f.key).not.toHaveProperty("claim");
    for (const q of FAQ) expect(q).not.toHaveProperty("claim");
  });

  it("has six feature rows, without the Danish-and-English one, then privacy, open source, getting started and the price", () => {
    expect(SHOWCASE_ORDER).toEqual([
      "fn",
      "phone",
      "corrections",
      "words",
      "notify",
      "devices",
    ]);
    expect(Object.keys(SHOWCASE).sort()).toEqual([...SHOWCASE_ORDER].sort());
    expect(ROW_ORDER).toEqual([
      ...SHOWCASE_ORDER,
      "privacy",
      "oss",
      "start",
      "free",
    ]);
  });

  it("puts each row's box on the other side of the one before it, starting on the right", () => {
    expect(ROW_ORDER.map(boxSide)).toEqual(
      ROW_ORDER.map((_, i) => (i % 2 ? "left" : "right")),
    );
    expect(() => boxSide("mixed" as never)).toThrow(/unknown row/);
  });

  it("gives every row a heading that makes sense on its own", () => {
    const titles = [
      SHOWCASE_INTRO.title,
      ...SHOWCASE_ORDER.map((k) => SHOWCASE[k].title),
      FEATURES.privacy.title,
      FEATURES.oss.title,
      FEATURES.start.title,
      FEATURES.free.title,
      FEATURES.faq.title,
      ...STEPS.map((s) => s.title),
      ...PRIVACY_FACTS.map((f) => f.title),
    ];
    for (const t of titles) {
      expect(t.split(" ").length, t).toBeGreaterThanOrEqual(2);
      expect(t, t).not.toMatch(/^(Eller|Og|Men|Til)\b|^(Tal|Slip|Indsæt)\.$/);
    }
    expect(new Set(titles).size).toBe(titles.length);
  });

  it("keeps the approved feature titles, and whole sentences where the old ones leaned on the one before", () => {
    expect(SHOWCASE_ORDER.map((k) => SHOWCASE[k].title)).toEqual([
      "Hold fn, tal, slip",
      "Telefonen er din mikrofon",
      "Den retter dig, når du retter dig selv",
      "Dine ord, stavet rigtigt",
      "Teksten kommer som en notifikation",
      "Teksten lander, hvor du sidder",
    ]);
    expect(SHOWCASE_ORDER.map((k) => SHOWCASE[k].scene)).toEqual([
      "fn",
      "telefon",
      "renskriv",
      "ordliste",
      "notifikation",
      "enheder",
    ]);
  });

  it("says the speed as it was measured: about a second after release, on an M1 Pro, also after two minutes (DESK-43, DESK-46)", () => {
    expect(SPEED).toMatch(/M1 Pro/);
    expect(SPEED).toMatch(/omkring et sekund/);
    expect(SPEED).toMatch(/to minutter/);
    expect(SHOWCASE.fn.fact).toBe(SPEED);
  });

  it("ties self-corrections to the optional AI cleanup (spec 6.10, PRIV-04)", () => {
    expect(FEATURES.corrections.short).toMatch(/AI-oprydning/);
    expect(FEATURES.corrections.body).toMatch(/valgfri og slået fra/);
    expect(SHOWCASE.corrections.text).toMatch(/Slår du AI-oprydning til/);
  });

  it("says privacy in four facts that hold, the first two word for word (spec 2.6)", () => {
    expect(PRIVACY_FACTS.map((f) => f.title)).toEqual([
      "Talen bliver til tekst på din egen computer",
      "Krypteret fra telefon til computer",
      "Ingen lyd gemmes",
      "Ingen konto",
    ]);
  });

  it("gets started in three steps, and keeps five questions", () => {
    expect(STEPS).toHaveLength(3);
    expect(FAQ).toHaveLength(5);
  });
});

describe("one living background at a time (SITE-06)", () => {
  it("runs the most visible one", () => {
    expect(pickLive([0, 300, 200], -1)).toBe(1);
    expect(pickLive([0, 0, 0], -1)).toBe(-1);
  });
  it("keeps the running one while another is only a little more visible, so they do not flicker", () => {
    expect(pickLive([100, 105], 0)).toBe(0);
    expect(pickLive([100, 130], 0)).toBe(1);
    expect(pickLive([0, 130], 0)).toBe(1);
  });
});
