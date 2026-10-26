/* Run 8: the front page as three finished pages (lib/build.ts), named by their hero's background: waves (LightWaves),
   bars (BarField) and metal (FluidMesh in Nat). They follow the owner's rules and differ only in the rest of the page:
     - the hero is concept B's lit stage with the laptop and the phone, the headline, the buttons and the fine print,
       painted without JavaScript; only its background differs, and that starts after load;
     - FluidMesh in Nat, following the pointer, also appears on pages 1 and 2;
     - every feature section of the production front page, with its demo, given room and split into sections;
     - B's privacy section with all its parts, and C's getting started and pricing on a GradientBars surface;
     - never GradientRows, never the dark brown as a section background;
     - unmeasured claims behind TODO(claim) in drafts and gone in production; Danish without em dashes.
   These checks run on the built HTML; e2e-concepts/ checks the pages in a browser (one background at a time,
   BarField at rest until the visitor moves, reduced motion, words landing at release). */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parse, type HTMLElement } from "node-html-parser";
import { beforeAll, describe, expect, it } from "vitest";
import {
  CONCEPTS,
  CONCEPT_INFO,
  SHARED_PREFIX,
  type Concept,
} from "../src/lib/build";
import {
  CTA,
  FAQ,
  FEATURES,
  FINE_PRINT,
  ONE_LINER,
  PLANS,
  PRIVACY_FACTS,
  SHOWCASE,
  SHOWCASE_INTRO,
  SHOWCASE_ORDER,
  SLOGAN,
  STEPS,
  TRY,
} from "../src/lib/features";
import { CONTACT_URL, PAGES, REPO_URL } from "../src/lib/site";
import { buildConcept } from "../scripts/concepts";

/** A page's whole JavaScript, inline and from files with their imports, uncompressed. React and the design system's
    islands are in it now (the backgrounds and the demos; React DOM alone is about 280 KB, the design system about
    130 KB), all loaded when idle or in view; this keeps them from growing by accident. */
const JS_BUDGET = 460 * 1024;

/* CONCEPTS_ONLY=<name> builds and checks one page (while working on it). */
const RUN = process.env.CONCEPTS_ONLY
  ? CONCEPTS.filter((c) => c === process.env.CONCEPTS_ONLY)
  : CONCEPTS;

const draft: Partial<Record<Concept, { dir: string; doc: HTMLElement }>> = {};
const prod: Partial<Record<Concept, { dir: string; doc: HTMLElement }>> = {};

beforeAll(() => {
  for (const c of RUN) {
    for (const [into, isDraft] of [
      [draft, true],
      [prod, false],
    ] as const) {
      const dir = buildConcept(c, isDraft, true);
      into[c] = {
        dir,
        doc: parse(readFileSync(join(dir, "index.html"), "utf8")),
      };
    }
  }
}, 400_000);

/** visible text: no scripts, styles or aria-hidden decoration */
function visibleText(root: HTMLElement): string {
  const clone = parse(`<body>${root.toString()}</body>`);
  clone
    .querySelectorAll("script, style, template, [aria-hidden=true]")
    .forEach((n) => n.remove());
  return clone.querySelector("body")!.textContent.replace(/\s+/g, " ");
}

function scriptBytes(
  dir: string,
  d: HTMLElement,
): { files: string[]; bytes: number } {
  const seen = new Set<string>();
  let bytes = 0;
  const load = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    const code = readFileSync(file, "utf8");
    bytes += Buffer.byteLength(code);
    for (const m of code.matchAll(
      /(?:import|export)\s*(?:[\w*{}\s,$]+from\s*)?["']([^"']+\.js)["']|import\(\s*["']([^"']+\.js)["']\s*\)/g,
    ))
      load(resolve(dirname(file), m[1] ?? m[2]));
  };
  for (const s of d.querySelectorAll("script")) {
    const src = s.getAttribute("src");
    if (src) load(join(dir, src));
    else bytes += Buffer.byteLength(s.textContent);
  }
  for (const i of d.querySelectorAll("astro-island")) {
    for (const a of ["component-url", "renderer-url"]) {
      const u = i.getAttribute(a);
      if (u) load(join(dir, u));
    }
  }
  return { files: [...seen], bytes };
}

function css(dir: string, d: HTMLElement): string {
  return d
    .querySelectorAll('link[rel="stylesheet"]')
    .map((l) => readFileSync(join(dir, l.getAttribute("href")!), "utf8"))
    .join("\n");
}

/** Astro's serialised island props: [type, value] pairs, 0 a plain value or object, 1 an array. */
function decode(v: unknown): unknown {
  if (Array.isArray(v) && v.length === 2 && typeof v[0] === "number") {
    const [t, x] = v as [number, unknown];
    if (t === 1 && Array.isArray(x)) return x.map(decode);
    if (t === 0 && x && typeof x === "object")
      return Object.fromEntries(
        Object.entries(x as Record<string, unknown>).map(([k, y]) => [
          k,
          decode(y),
        ]),
      );
    return x;
  }
  return v;
}
interface Island {
  el: HTMLElement;
  component: string;
  client: string;
  props: Record<string, unknown>;
}
function islands(root: HTMLElement): Island[] {
  return root.querySelectorAll("astro-island").map((el) => ({
    el,
    component: el.getAttribute("component-export") ?? "",
    client: el.getAttribute("client") ?? "",
    props: Object.fromEntries(
      Object.entries(
        JSON.parse(el.getAttribute("props") || "{}") as Record<string, unknown>,
      ).map(([k, v]) => [k, decode(v)]),
    ),
  }));
}
const inside = (el: HTMLElement, sel: string) => {
  for (let n: HTMLElement | null = el.parentNode; n; n = n.parentNode)
    if (n.matches?.(sel)) return true;
  return false;
};

const feature = (d: HTMLElement, key: string) =>
  d.querySelectorAll(`[data-feature="${key}"]`);

describe.each(RUN)("final page %s (run 8)", (c) => {
  const d = () => draft[c]!.doc;
  const p = () => prod[c]!.doc;
  const hero = () => d().querySelector('[data-section="hero"]')!;

  it("is the page it says it is", () => {
    expect(d().querySelector("body")!.getAttribute("data-concept")).toBe(c);
    expect(p().querySelector("body")!.getAttribute("data-concept")).toBe(c);
  });

  it("has one h1, the slogan, and the download as its first call to action", () => {
    expect(d().querySelectorAll("h1")).toHaveLength(1);
    expect(d().querySelector("h1")!.textContent.trim()).toBe(SLOGAN);
    const first = d().querySelector("main a.wt-shiny")!;
    expect([first.textContent.trim(), first.getAttribute("href")]).toEqual([
      CTA.download,
      PAGES.hent.path,
    ]);
  });

  it("has concept B's hero: the stage with the laptop and the phone, the headline, the buttons and the fine print, all static HTML", () => {
    const h = hero();
    expect(h).not.toBeNull();
    expect(h.querySelector("h1")).not.toBeNull();
    const text = visibleText(h);
    expect(text).toContain(ONE_LINER);
    expect(text).toContain(FINE_PRINT);
    const links = h
      .querySelectorAll("a.wt-shiny")
      .map((a) => [a.textContent.trim(), a.getAttribute("href")]);
    expect(links[0]).toEqual([CTA.download, PAGES.hent.path]);
    expect(links.map((l) => l[0])).toContain(CTA.how);
    const stage = h.querySelector("[data-stage]")!;
    expect(stage.getAttribute("role")).toBe("img");
    expect(stage.getAttribute("aria-label")).toMatch(/slipper/);
    expect(stage.querySelector(".wt-laptop")).not.toBeNull();
    expect(stage.querySelector(".wt-phone")).not.toBeNull();
    /* the words land at release: the line is in the HTML, with the pill's three phases */
    expect(stage.querySelector(".wt-pill--listening")).not.toBeNull();
    expect(stage.querySelector(".wt-pill--processing")).not.toBeNull();
    expect(stage.querySelector(".wt-pill--pasted")).not.toBeNull();
    expect(stage.querySelector("[data-stage-line]")!.textContent).toMatch(/\S/);
    /* nothing of the hero's copy or stage waits for React */
    expect(inside(stage, "astro-island")).toBe(false);
    expect(inside(h.querySelector("h1")!, "astro-island")).toBe(false);
  });

  it("puts its own background behind the hero, and starts it only after load", () => {
    const hosts = hero().querySelectorAll("[data-fp-bg]");
    expect(hosts).toHaveLength(1);
    const own = islands(hero());
    expect(own).toHaveLength(1);
    const [bg] = own;
    expect(bg.client).toBe("idle");
    if (c === "waves") {
      expect(bg.props.kind).toBe("waves");
      expect(hero().querySelector(".wt-waves canvas")).not.toBeNull();
    }
    if (c === "bars") {
      expect(bg.props).toMatchObject({
        kind: "bars",
        mode: "wave",
        bars: 40,
        interactive: true,
      });
      const field = hero().querySelector(".wt-barfield")!;
      expect(field.classList.contains("wt-barfield--wave")).toBe(true);
      expect(field.classList.contains("wt-barfield--interactive")).toBe(true);
      expect(field.querySelectorAll(".wt-bf")).toHaveLength(40);
    }
    if (c === "metal") {
      expect(bg.props).toMatchObject({
        kind: "mesh",
        palette: "nat",
        scrim: "left",
        scrimAmount: 1,
      });
      expect(bg.props.interactive).not.toBe(false);
      expect(hero().getAttribute("data-theme")).toBe("dark");
      expect(hero().querySelector(".wt-gl canvas")).not.toBeNull();
    }
  });

  it("hydrates every island when idle or visible, never at once", () => {
    for (const i of islands(d()))
      expect(["idle", "visible"], i.component).toContain(i.client);
  });

  it(
    c === "metal"
      ? "has FluidMesh in Nat in the hero"
      : "also has FluidMesh in Nat, following the pointer, in a section of its own",
    () => {
      const mesh = islands(d()).filter(
        (i) =>
          i.props.kind === "mesh" &&
          i.props.palette === "nat" &&
          i.props.interactive !== false,
      );
      const outside = mesh.filter(
        (i) => !inside(i.el, '[data-section="hero"]'),
      );
      if (c === "metal") expect(mesh.length).toBeGreaterThanOrEqual(1);
      else {
        expect(outside.length).toBeGreaterThanOrEqual(1);
        for (const i of outside) {
          expect(i.client).toBe("visible");
          expect(inside(i.el, '[data-theme="dark"]')).toBe(true);
        }
      }
    },
  );

  it("keeps every feature section of the production front page with its demo", () => {
    const intro = d()
      .querySelectorAll("h2")
      .find((h) => h.textContent.trim() === SHOWCASE_INTRO.title);
    expect(intro, "the section intro").toBeTruthy();
    expect(visibleText(d().querySelector("main")!)).toContain(
      SHOWCASE_INTRO.lead,
    );
    for (const key of SHOWCASE_ORDER) {
      const f = SHOWCASE[key];
      const block = d().querySelector(`[data-showcase="${key}"]`)!;
      expect(block, key).not.toBeNull();
      const text = visibleText(block);
      expect(text, key).toContain(f.title);
      expect(text, key).toContain(f.text);
      const demo = islands(block).find((i) => i.component === "ShowcaseCard");
      expect(demo, `${key}: its demo`).toBeTruthy();
      expect(demo!.props.scene, key).toBe(f.scene);
      expect(demo!.client).toBe("visible");
      /* the demo's own surface is CSS, so the page can hold it still while another background moves */
      expect(["liquid", "strips", "gradient", "barfield", "bars"]).toContain(
        demo!.props.surface,
      );
    }
    /* the mixed sentence lands whole, as the app pastes it */
    const mixed = islands(d().querySelector('[data-showcase="mixed"]')!)[0];
    expect(mixed.props.release).toBe(true);
  });

  it("gives the features room: split over sections, never one bento", () => {
    const sections = new Set(
      SHOWCASE_ORDER.map((key) => {
        let n: HTMLElement | null = d().querySelector(
          `[data-showcase="${key}"]`,
        );
        while (n && n.tagName !== "SECTION") n = n.parentNode;
        return n;
      }),
    );
    expect(sections.size).toBeGreaterThanOrEqual(2);
    expect(d().querySelector(".bento")).toBeNull();
  });

  it("keeps B's privacy section with all its parts: the relay demo, the four facts and the open code", () => {
    const [priv] = feature(d(), "privacy");
    expect(priv).toBeTruthy();
    expect(inside(priv, '[data-theme="dark"]')).toBe(true);
    const text = visibleText(priv);
    expect(text).toContain(FEATURES.privacy.title);
    for (const f of PRIVACY_FACTS) expect(text, f.title).toContain(f.title);
    const dia = priv.querySelector("[data-relay-demo]")!;
    expect(dia.getAttribute("role")).toBe("img");
    expect(dia.querySelector(".wt-phone")).not.toBeNull();
    expect(dia.querySelector(".wt-laptop")).not.toBeNull();
    expect(dia.querySelectorAll("[data-packet]").length).toBeGreaterThan(0);
    expect(
      priv.querySelector(`a[href="${PAGES.privacy.path}"]`),
    ).not.toBeNull();
    const [oss] = feature(d(), "oss");
    expect(visibleText(oss)).toContain(FEATURES.oss.title);
    expect(oss.querySelector(`a[href="${REPO_URL}"]`)).not.toBeNull();
    expect(inside(oss, '[data-theme="dark"]')).toBe(true);
  });

  it("keeps C's getting started and pricing, on a GradientBars surface", () => {
    const [start] = feature(d(), "start");
    const [free] = feature(d(), "free");
    for (const [k, el] of [
      ["start", start],
      ["free", free],
    ] as const) {
      expect(el, k).toBeTruthy();
      expect(inside(el, ".wt-bars--glow"), `${k} on GradientBars`).toBe(true);
    }
    const s = visibleText(start);
    expect(s).toContain(FEATURES.start.title);
    for (const step of STEPS) expect(s, step.title).toContain(step.title);
    expect(start.querySelectorAll('[role="switch"]')).toHaveLength(2);
    expect(start.querySelector(".wt-keycap")).not.toBeNull();
    const f = visibleText(free);
    expect(f).toContain(FEATURES.free.title);
    expect(free.querySelector("[data-price]")!.textContent.trim()).toBe(
      PLANS.free.price,
    );
    expect(free.querySelector("[data-count]")!.textContent.trim()).toBe(
      TRY.many.replace("{n}", "1.000"),
    );
    const range = free.querySelector('input[type="range"]')!;
    expect(range.getAttribute("aria-valuetext")).toBe(
      TRY.many.replace("{n}", "1.000"),
    );
    expect(f).toContain(PLANS.free.title);
    expect(f).toContain(PLANS.help.title);
    expect(f).toContain(PLANS.footnote);
    expect(free.querySelector(`a[href="${CONTACT_URL}"]`)).not.toBeNull();
    expect(
      free.querySelector(`a[href="${PAGES.business.path}"]`),
    ).not.toBeNull();
    expect(free.querySelector(`a[href="${PAGES.hent.path}"]`)).not.toBeNull();
  });

  it("never uses GradientRows, nor the dark brown as a section background", () => {
    expect(d().querySelector(".wt-rows")).toBeNull();
    for (const i of islands(d()))
      expect(i.props.surface, i.component).not.toBe("rows");
    /* GradientBackground (the silk the brown came in) only inside a demo card */
    for (const el of d().querySelectorAll(".wt-gbg"))
      expect(inside(el, ".wt-show"), el.toString().slice(0, 80)).toBe(true);
    for (const el of d().querySelectorAll("section, [data-fp-bg]")) {
      const st = el.getAttribute("style") ?? "";
      expect(st).not.toMatch(/mokka|rav-dyb/);
    }
  });

  it("marks every unmeasured claim visibly as TODO(claim) in the draft", () => {
    const claims = d().querySelectorAll("[data-claim]");
    expect(claims.length).toBeGreaterThanOrEqual(3);
    for (const el of claims) {
      expect(el.querySelector(".claim-tag")!.textContent).toBe("TODO(claim)");
      expect(el.getAttribute("title")).toMatch(/ikke målt/i);
    }
    const said = claims.map((el) => el.textContent).join(" ");
    expect(said).toMatch(/hvisk/i);
    expect(said).toContain(FEATURES.mixed.claim!.text);
  });

  it("shows no unmeasured claim in a production build", () => {
    expect(p().querySelectorAll("[data-claim]")).toHaveLength(0);
    const text = visibleText(p().querySelector("body")!);
    expect(text).not.toMatch(/TODO|hvisk/i);
    expect(text).not.toContain(FEATURES.mixed.claim!.text);
  });

  it("writes Danish without em dashes, exclamation marks or 'direkte' (spec 2.6, Appendix A)", () => {
    const text = visibleText(p().querySelector("body")!);
    expect(text).not.toMatch(/—/);
    expect(text).not.toMatch(/!/);
    expect(text).not.toMatch(/direkte/i);
    for (const el of p().querySelectorAll("[aria-label]"))
      expect(el.getAttribute("aria-label")).not.toMatch(/—|direkte/i);
  });

  it("ties self-corrections to the optional AI cleanup (spec 6.10, PRIV-04)", () => {
    for (const el of d().querySelectorAll("main p, main li"))
      if (/onsdag, nej, torsdag/.test(el.textContent))
        expect(el.textContent, el.textContent).toMatch(/AI-oprydning/);
  });

  it("says the text lands on the computer you sit at, never on the others (spec 12.1)", () => {
    const text = visibleText(d().querySelector("body")!);
    expect(text).toContain("den computer, du sidder ved");
    expect(text).not.toMatch(/historikken|alle dine computere/);
  });

  it("has a short FAQ that links to the rest", () => {
    const blocks = feature(d(), "faq");
    const text = blocks.map(visibleText).join(" ");
    for (const q of FAQ.filter((q) => !q.claim))
      expect(text, q.q).toContain(q.q);
    expect(
      blocks.some((b) => !!b.querySelector(`a[href="${PAGES.faq.path}"]`)),
    ).toBe(true);
  });

  it("keeps its rules to its own prefix and the shared one, after the design system, and stops for reduced motion", () => {
    const sheet = css(draft[c]!.dir, d());
    expect(sheet).toMatch(/prefers-reduced-motion/);
    const own = CONCEPT_INFO[c].prefix;
    for (const other of CONCEPTS.filter((o) => o !== c))
      expect(sheet, other).not.toContain("." + CONCEPT_INFO[other].prefix);
    expect(sheet).toContain("." + own);
    expect(sheet).toContain("." + SHARED_PREFIX);
    expect(sheet.indexOf(".wt-shiny")).toBeGreaterThanOrEqual(0);
    expect(sheet.indexOf(".wt-shiny")).toBeLessThan(
      sheet.indexOf("." + SHARED_PREFIX),
    );
    /* run 6's concepts are gone */
    expect(sheet).not.toMatch(/\.(ps|ho|ed)-[a-z]/);
  });

  it(`loads nothing from other origins and keeps its JavaScript under ${JS_BUDGET / 1024} KB`, () => {
    for (const el of d().querySelectorAll(
      '[src], link[href]:not([rel="canonical"])',
    )) {
      const url = el.getAttribute("src") ?? el.getAttribute("href")!;
      expect(url, url).not.toMatch(/^(https?:)?\/\//);
    }
    const js = scriptBytes(draft[c]!.dir, d());
    expect(js.bytes).toBeLessThanOrEqual(JS_BUDGET);
  });
});
