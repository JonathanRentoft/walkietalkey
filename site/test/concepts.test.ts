/* Run 6: the front page in three complete, different concepts (lib/build.ts), each a page of its own over the same
   shared copy (lib/features.ts). Every concept shows every feature of the brief, composed rather than stacked as
   fourteen sections; draft previews show the unmeasured claims marked TODO(claim), production never does. These
   checks run on the built HTML; e2e-concepts/ checks the pages in a browser (motion, reduced motion, the demos). */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parse, type HTMLElement } from "node-html-parser";
import { beforeAll, describe, expect, it } from "vitest";
import { CONCEPTS, CONCEPT_INFO, type Concept } from "../src/lib/build";
import {
  CTA,
  FAQ,
  FEATURES,
  FEATURE_ORDER,
  PLANS,
  PRIVACY_FACTS,
  STEPS,
} from "../src/lib/features";
import { CONTACT_URL, PAGES, REPO_URL } from "../src/lib/site";
import { buildConcept } from "../scripts/concepts";

/** A concept's whole JavaScript, inline and from files with their imports, uncompressed (SITE-06). */
const CONCEPT_JS_BUDGET = 24 * 1024;
/** "composed rather than stacked as fourteen sections" */
const MAX_SECTIONS = 8;

const draft: Partial<Record<Concept, { dir: string; doc: HTMLElement }>> = {};
const prod: Partial<Record<Concept, { dir: string; doc: HTMLElement }>> = {};

beforeAll(() => {
  for (const c of CONCEPTS) {
    for (const [into, isDraft] of [
      [draft, true],
      [prod, false],
    ] as const) {
      const dir = buildConcept(c, isDraft, true);
      into[c] = { dir, doc: parse(readFileSync(join(dir, "index.html"), "utf8")) };
    }
  }
}, 300_000);

/** visible text: no scripts, styles or aria-hidden decoration */
function visibleText(root: HTMLElement): string {
  const clone = parse(`<body>${root.toString()}</body>`);
  clone
    .querySelectorAll("script, style, template, [aria-hidden=true]")
    .forEach((n) => n.remove());
  return clone.querySelector("body")!.textContent.replace(/\s+/g, " ");
}

function scriptBytes(dir: string, d: HTMLElement): { files: string[]; bytes: number } {
  const seen = new Set<string>();
  let bytes = 0;
  const load = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    const code = readFileSync(file, "utf8");
    bytes += Buffer.byteLength(code);
    for (const m of code.matchAll(
      /(?:import|export)\s*(?:[\w*{}\s,]+from\s*)?["']([^"']+\.js)["']|import\(\s*["']([^"']+\.js)["']\s*\)/g,
    ))
      load(resolve(dirname(file), m[1] ?? m[2]));
  };
  for (const s of d.querySelectorAll("script")) {
    const src = s.getAttribute("src");
    if (src) load(join(dir, src));
    else bytes += Buffer.byteLength(s.textContent);
  }
  return { files: [...seen], bytes };
}

function css(dir: string, d: HTMLElement): string {
  return d
    .querySelectorAll('link[rel="stylesheet"]')
    .map((l) => readFileSync(join(dir, l.getAttribute("href")!), "utf8"))
    .join("\n");
}

const feature = (d: HTMLElement, key: string) =>
  d.querySelectorAll(`[data-feature="${key}"]`);

describe.each(CONCEPTS)("concept %s (run 6)", (c) => {
  const d = () => draft[c]!.doc;
  const p = () => prod[c]!.doc;

  it("is the concept it says it is", () => {
    expect(d().querySelector("body")!.getAttribute("data-concept")).toBe(c);
    expect(p().querySelector("body")!.getAttribute("data-concept")).toBe(c);
  });

  it("has one h1 and the download as its first call to action", () => {
    expect(d().querySelectorAll("h1")).toHaveLength(1);
    const links = d()
      .querySelectorAll("a")
      .map((a) => [a.textContent.trim(), a.getAttribute("href")]);
    expect(links).toContainEqual([CTA.download, PAGES.hent.path]);
  });

  it("shows every feature of the brief, each under its own title", () => {
    for (const key of FEATURE_ORDER) {
      const blocks = feature(d(), key);
      expect(blocks.length, key).toBeGreaterThanOrEqual(1);
      expect(blocks.map(visibleText).join(" "), key).toContain(FEATURES[key].title);
    }
  });

  it(`composes the features into at most ${MAX_SECTIONS} sections instead of one section each`, () => {
    const main = d().querySelector("main")!;
    expect(main).not.toBeNull();
    expect(main.querySelectorAll(":scope > section").length).toBeLessThanOrEqual(MAX_SECTIONS);
  });

  it("says privacy in the four facts that hold, and links the details (spec 2.6)", () => {
    const text = feature(d(), "privacy").map(visibleText).join(" ");
    for (const f of PRIVACY_FACTS) expect(text, f.title).toContain(f.title);
    expect(d().querySelector(`a[href="${PAGES.privacy.path}"]`)).not.toBeNull();
  });

  it("links the code under its open-source feature", () => {
    expect(feature(d(), "oss").some((b) => !!b.querySelector(`a[href="${REPO_URL}"]`))).toBe(true);
  });

  it("is free for everyone, with paid setup help as a service, not a licence (principle 3)", () => {
    const blocks = feature(d(), "free");
    const text = blocks.map(visibleText).join(" ");
    expect(text).toContain(PLANS.free.price);
    expect(text).toContain(PLANS.footnote);
    expect(blocks.some((b) => !!b.querySelector(`a[href="${CONTACT_URL}"]`))).toBe(true);
    expect(blocks.some((b) => !!b.querySelector(`a[href="${PAGES.business.path}"]`))).toBe(true);
  });

  it("gets started in three steps", () => {
    const text = feature(d(), "start").map(visibleText).join(" ");
    for (const s of STEPS) expect(text, s.title).toContain(s.title);
  });

  it("has a short FAQ that links to the rest", () => {
    const blocks = feature(d(), "faq");
    const text = blocks.map(visibleText).join(" ");
    for (const q of FAQ.filter((q) => !q.claim)) expect(text, q.q).toContain(q.q);
    expect(blocks.some((b) => !!b.querySelector(`a[href="${PAGES.faq.path}"]`))).toBe(true);
  });

  it("ties self-corrections to the optional AI cleanup (spec 6.10, PRIV-04)", () => {
    const text = feature(d(), "corrections").map(visibleText).join(" ");
    expect(text).toMatch(/onsdag, nej, torsdag/);
    expect(text).toMatch(/AI-oprydning/);
    /* nowhere else does the page promise it without saying so */
    for (const el of d().querySelectorAll("main p, main li"))
      if (/onsdag, nej, torsdag/.test(el.textContent) && !el.closest('[data-feature="corrections"]'))
        expect(el.textContent, el.textContent).toMatch(/AI-oprydning/);
  });

  it("says the text lands on the computer you sit at, never on the others (spec 12.1)", () => {
    const text = visibleText(d().querySelector("body")!);
    expect(feature(d(), "notify").map(visibleText).join(" ")).toContain("den computer, du sidder ved");
    expect(text).not.toMatch(/historikken|alle dine computere/);
  });

  it("marks every unmeasured claim visibly as TODO(claim) in the draft", () => {
    const claims = d().querySelectorAll("[data-claim]");
    expect(claims.length).toBeGreaterThanOrEqual(2);
    for (const el of claims) {
      expect(el.querySelector(".claim-tag")!.textContent).toBe("TODO(claim)");
      expect(el.getAttribute("title")).toMatch(/ikke målt/i);
    }
  });

  it("shows no unmeasured claim in a production build", () => {
    expect(p().querySelectorAll("[data-claim]")).toHaveLength(0);
    expect(visibleText(p().querySelector("body")!)).not.toMatch(/TODO|hvisk/i);
  });

  it("writes Danish without em dashes, exclamation marks or 'direkte' (spec 2.6, Appendix A)", () => {
    const text = visibleText(p().querySelector("body")!);
    expect(text).not.toMatch(/—/);
    expect(text).not.toMatch(/!/);
    expect(text).not.toMatch(/direkte/i);
  });

  it(`runs no React and keeps its JavaScript under ${CONCEPT_JS_BUDGET / 1024} KB (SITE-06)`, () => {
    expect(d().querySelectorAll("astro-island")).toHaveLength(0);
    const js = scriptBytes(draft[c]!.dir, d());
    expect(js.files.join(" ")).not.toMatch(/client\.|react/);
    expect(js.bytes).toBeLessThanOrEqual(CONCEPT_JS_BUDGET);
  });

  it("has at most one WebGL surface and loads nothing from other origins (SITE-04, SITE-06)", () => {
    expect(d().querySelectorAll("canvas").length).toBeLessThanOrEqual(1);
    for (const el of d().querySelectorAll('[src], link[href]:not([rel="canonical"])')) {
      const url = el.getAttribute("src") ?? el.getAttribute("href")!;
      expect(url, url).not.toMatch(/^(https?:)?\/\//);
    }
  });

  it("stops its motion for reduced motion, and keeps its rules to its own prefix", () => {
    const sheet = css(draft[c]!.dir, d());
    expect(sheet).toMatch(/prefers-reduced-motion/);
    const own = CONCEPT_INFO[c].prefix;
    for (const other of CONCEPTS.filter((o) => o !== c))
      expect(sheet, other).not.toContain("." + CONCEPT_INFO[other].prefix);
    expect(sheet).toContain("." + own);
    /* the design system's CSS comes before the concept's rules, so the concept wins */
    expect(sheet.indexOf(".wt-shiny")).toBeGreaterThanOrEqual(0);
    expect(sheet.indexOf(".wt-shiny")).toBeLessThan(sheet.indexOf("." + own));
  });
});
