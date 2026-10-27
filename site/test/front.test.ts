/* Run 10: the final front page's contract, checked on the built HTML (run `bun run build` first). The owner's pick:
     - the hero from run 8's page 2: the light stage on 40 BarField bars, still until the visitor moves;
     - below it, page 1's sections, with every feature in a row of its own: the words on one side and the feature's
       box on the other, the box right, then left, then right, all the way down; never two boxes side by side;
     - nothing pending on the page: no TODO, no "mangler at blive bekræftet", no unmeasured claim (whispering,
       English words), and the speed only as it was measured;
     - no stray words: no "Tal.", "Slip." or "Indsæt." on their own, and every heading a whole phrase;
     - the devices row without a card frame (its scene comes from the design system);
     - one living background at a time, still frames with reduced motion, Danish without em dashes, nothing from
       other origins (SITE-04, SITE-06).
   e2e/front.spec.ts checks the same page in a browser: the layout at 1440, 1024 and 390 px, the bars, the
   backgrounds and reduced motion. */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parse, type HTMLElement } from "node-html-parser";
import { describe, expect, it } from "vitest";
import {
  CTA,
  FAQ,
  FEATURES,
  FINE_PRINT,
  ONE_LINER,
  PLANS,
  PRIVACY_FACTS,
  ROW_ORDER,
  SHOWCASE,
  SHOWCASE_INTRO,
  SHOWCASE_ORDER,
  SLOGAN,
  SPEED,
  STEPS,
  TRY,
  boxSide,
} from "../src/lib/features";
import { CONTACT_URL, PAGES, REPO_URL } from "../src/lib/site";

/** The page's whole JavaScript, inline and from files with their imports, uncompressed: React and the design
    system's islands (the backgrounds and the demos; React DOM alone is about 280 KB), all loaded when idle or in
    view. This keeps them from growing by accident. */
const JS_BUDGET = 440 * 1024;

const dist = resolve(__dirname, "../dist");
const d = parse(readFileSync(join(dist, "index.html"), "utf8"));
const main = d.querySelector("main")!;

/** visible text: no scripts, styles or aria-hidden decoration */
function visibleText(root: HTMLElement): string {
  const clone = parse(`<body>${root.toString()}</body>`);
  clone
    .querySelectorAll("script, style, template, [aria-hidden=true]")
    .forEach((n) => n.remove());
  return clone.querySelector("body")!.textContent.replace(/\s+/g, " ");
}

function scriptBytes(root: HTMLElement): number {
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
  for (const s of root.querySelectorAll("script")) {
    const src = s.getAttribute("src");
    if (src) load(join(dist, src));
    else bytes += Buffer.byteLength(s.textContent);
  }
  for (const i of root.querySelectorAll("astro-island"))
    for (const a of ["component-url", "renderer-url"]) {
      const u = i.getAttribute(a);
      if (u) load(join(dist, u));
    }
  return bytes;
}

const css = () =>
  d
    .querySelectorAll('link[rel="stylesheet"]')
    .map((l) => readFileSync(join(dist, l.getAttribute("href")!), "utf8"))
    .join("\n");

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
const hero = () => d.querySelector('[data-section="hero"]')!;
const rows = () => main.querySelectorAll("[data-row]");
const row = (key: string) => main.querySelector(`[data-row="${key}"]`)!;

describe("the front page (run 10)", () => {
  it("is the final page itself: no concept, draft or claim machinery left", () => {
    expect(d.querySelector("body")!.hasAttribute("data-concept")).toBe(false);
    expect(d.querySelectorAll("[data-claim], .claim, .claim-tag")).toHaveLength(
      0,
    );
    /* run 8's three pages had their own class prefixes */
    expect(d.toString()).not.toMatch(/\b(fw|fb|fm)-[a-z]/);
  });

  it("has one h1, the slogan, and the download as its first call to action", () => {
    expect(d.querySelectorAll("h1")).toHaveLength(1);
    expect(d.querySelector("h1")!.textContent.trim()).toBe(SLOGAN);
    const first = main.querySelector("a.wt-shiny")!;
    expect([first.textContent.trim(), first.getAttribute("href")]).toEqual([
      CTA.download,
      PAGES.hent.path,
    ]);
  });

  it("has page 2's light hero: the stage, the headline, the buttons and the fine print, all static HTML", () => {
    const h = hero();
    expect(h.getAttribute("data-fp-hero")).toBe("bars");
    expect(h.hasAttribute("data-theme")).toBe(false);
    const text = visibleText(h);
    expect(text).toContain(ONE_LINER);
    expect(text).toContain(FINE_PRINT);
    const links = h
      .querySelectorAll("a.wt-shiny")
      .map((a) => [a.textContent.trim(), a.getAttribute("href")]);
    expect(links).toEqual([
      [CTA.download, PAGES.hent.path],
      [CTA.how, "#funktioner"],
    ]);
    const stage = h.querySelector("[data-stage]")!;
    expect(stage.getAttribute("role")).toBe("img");
    expect(stage.getAttribute("aria-label")).toMatch(/slipper/);
    expect(stage.querySelector(".wt-laptop")).not.toBeNull();
    expect(stage.querySelector(".wt-phone")).not.toBeNull();
    /* the words land at release: the line is in the HTML, with the pill's three phases */
    for (const s of ["listening", "processing", "pasted"])
      expect(stage.querySelector(`.wt-pill--${s}`), s).not.toBeNull();
    expect(stage.querySelector("[data-stage-line]")!.textContent).toMatch(/\S/);
    expect(inside(stage, "astro-island")).toBe(false);
    expect(inside(h.querySelector("h1")!, "astro-island")).toBe(false);
  });

  it("puts 40 BarField bars behind the hero, interactive, started only after load", () => {
    expect(hero().querySelectorAll("[data-fp-bg]")).toHaveLength(1);
    const own = islands(hero());
    expect(own).toHaveLength(1);
    expect(own[0].client).toBe("idle");
    expect(own[0].props).toMatchObject({
      kind: "bars",
      mode: "wave",
      bars: 40,
      interactive: true,
    });
    const field = hero().querySelector(".wt-barfield")!;
    expect(field.classList.contains("wt-barfield--wave")).toBe(true);
    expect(field.classList.contains("wt-barfield--interactive")).toBe(true);
    expect(field.querySelectorAll(".wt-bf")).toHaveLength(40);
  });

  it("hydrates every island when idle or visible, never at once", () => {
    for (const i of islands(d))
      expect(["idle", "visible"], i.component).toContain(i.client);
  });

  it("lays every row out the same way: the words first, then the box, the box right, left, right, all the way down", () => {
    expect(rows().map((r) => r.getAttribute("data-row"))).toEqual(ROW_ORDER);
    rows().forEach((r, i) => {
      const key = r.getAttribute("data-row")!;
      expect(r.getAttribute("data-box"), key).toBe(
        i % 2 === 0 ? "right" : "left",
      );
      expect(r.getAttribute("data-box"), key).toBe(
        boxSide(key as (typeof ROW_ORDER)[number]),
      );
      const kids = r.querySelectorAll("[data-row-copy], [data-row-box]");
      expect(
        kids.map((k) => (k.hasAttribute("data-row-copy") ? "copy" : "box")),
        key,
      ).toEqual(["copy", "box"]);
      /* one heading per row, in its words */
      expect(
        kids[0].querySelectorAll("h2, h3").length,
        key,
      ).toBeGreaterThanOrEqual(1);
      expect(kids[1].querySelectorAll("h2").length, key).toBe(0);
    });
    /* no pairs, stacks or bento grids of boxes */
    expect(
      d.querySelectorAll(".bento, .fp-feat--stack, .fp-pair, .fp-plans"),
    ).toHaveLength(0);
  });

  it("gives every feature its row with its demo, in a CSS surface the page can hold still", () => {
    const intro = main
      .querySelectorAll("h2")
      .find((h) => h.textContent.trim() === SHOWCASE_INTRO.title);
    expect(intro, "the section intro").toBeTruthy();
    expect(visibleText(main)).toContain(SHOWCASE_INTRO.lead);
    for (const key of SHOWCASE_ORDER) {
      const f = SHOWCASE[key];
      const r = row(key);
      expect(r.getAttribute("data-showcase"), key).toBe(key);
      const text = visibleText(r.querySelector("[data-row-copy]")!);
      expect(text, key).toContain(f.title);
      expect(text, key).toContain(f.text);
      if (f.body) expect(text, key).toContain(f.body);
      if (key === "devices") continue;
      const demo = islands(r).find((i) => i.component === "ShowcaseCard");
      expect(demo, `${key}: its demo`).toBeTruthy();
      expect(demo!.props.scene, key).toBe(f.scene);
      expect(demo!.client).toBe("visible");
      expect(["liquid", "strips", "gradient", "barfield", "bars"]).toContain(
        demo!.props.surface,
      );
      expect(inside(demo!.el, "[data-row-box]"), key).toBe(true);
    }
  });

  it("gives the devices scene its row without a card frame", () => {
    const box = row("devices").querySelector("[data-row-box]")!;
    expect(box.hasAttribute("data-devices")).toBe(true);
    expect(box.querySelector(".wt-show, .wt-show-stage")).toBeNull();
    expect(box.querySelector("[data-fp-bg]")).toBeNull();
    /* a scene from the design system, hydrated when it comes into view */
    const scene = islands(box);
    expect(scene).toHaveLength(1);
    expect(scene[0].component).toBe("SpeakToDesk");
    expect(scene[0].client).toBe("visible");
  });

  it("drops the Danish-and-English feature and keeps only what is true of the word list", () => {
    expect(main.querySelector('[data-showcase="mixed"]')).toBeNull();
    expect(visibleText(row("words"))).toContain("Udviklerord");
    for (const i of islands(d)) expect(i.props.scene).not.toBe("sprog");
  });

  it("says the speed only as it was measured, naming the machine (DESK-43)", () => {
    const text = visibleText(main);
    expect(text).toContain(SPEED);
    for (const s of text.split(/(?<=\.)\s/))
      if (/sekund/.test(s)) expect(s, s).toMatch(/M1 Pro/);
  });

  it("shows nothing pending: no TODO, no confirmation note, no unmeasured claim", () => {
    const text = visibleText(d.querySelector("body")!);
    expect(text).not.toMatch(/TODO/);
    expect(text).not.toMatch(/bekræft/i);
    expect(text).not.toMatch(/mangler at blive/i);
    expect(text).not.toMatch(/ikke målt/i);
    expect(text).not.toMatch(/hvisk/i);
    expect(text).not.toMatch(/tale lavt/i);
    expect(text).not.toMatch(/engelske ord, som du siger/i);
    /* nor in the attributes a screen reader or a tooltip reads */
    for (const el of d.querySelectorAll("[aria-label], [title], [alt]"))
      for (const a of ["aria-label", "title", "alt"])
        expect(el.getAttribute(a) ?? "", a).not.toMatch(/TODO|bekræft/i);
  });

  it("has no stray words: the slogan's words never stand alone, and every heading is a whole phrase", () => {
    const labels = new Set(["Tal.", "Slip.", "Indsæt."]);
    for (const el of d.querySelectorAll("body *")) {
      if (["SCRIPT", "STYLE"].includes(el.tagName)) continue;
      const own = el.childNodes
        .filter((n) => n.nodeType === 3)
        .map((n) => n.textContent)
        .join("")
        .trim();
      expect(labels.has(own), `${el.tagName}: ${own}`).toBe(false);
    }
    for (const h of d.querySelectorAll("h1, h2, h3")) {
      const t = h.textContent.trim().replace(/\s+/g, " ");
      expect(t.split(" ").length, t).toBeGreaterThanOrEqual(2);
      expect(t, t).not.toMatch(/^(Eller|Og|Men|Til)\b/);
    }
  });

  it("writes Danish without em dashes, exclamation marks or 'direkte' (spec 2.6, Appendix A)", () => {
    const text = visibleText(d.querySelector("body")!);
    expect(text).not.toMatch(/—/);
    expect(text).not.toMatch(/!/);
    expect(text).not.toMatch(/direkte/i);
    for (const el of d.querySelectorAll("[aria-label]"))
      expect(el.getAttribute("aria-label")).not.toMatch(/—|direkte/i);
  });

  it("keeps the privacy picture and the open code on the night panel, with FluidMesh in Nat behind them", () => {
    const priv = row("privacy");
    expect(inside(priv, '[data-theme="dark"]')).toBe(true);
    const text = visibleText(priv);
    expect(text).toContain(FEATURES.privacy.title);
    for (const f of PRIVACY_FACTS) expect(text, f.title).toContain(f.title);
    const dia = priv.querySelector("[data-row-box] [data-relay-demo]")!;
    expect(dia.getAttribute("role")).toBe("img");
    expect(dia.querySelector(".wt-phone")).not.toBeNull();
    expect(dia.querySelector(".wt-laptop")).not.toBeNull();
    expect(dia.querySelectorAll("[data-packet]").length).toBeGreaterThan(0);
    expect(
      priv.querySelector(`a[href="${PAGES.privacy.path}"]`),
    ).not.toBeNull();
    const oss = row("oss");
    expect(visibleText(oss)).toContain(FEATURES.oss.title);
    expect(oss.querySelector(`a[href="${REPO_URL}"]`)).not.toBeNull();
    expect(inside(oss, '[data-theme="dark"]')).toBe(true);
    const mesh = islands(d).filter(
      (i) => i.props.kind === "mesh" && i.props.palette === "nat",
    );
    expect(mesh).toHaveLength(1);
    expect(mesh[0].client).toBe("visible");
    expect(inside(mesh[0].el, '[data-theme="dark"]')).toBe(true);
  });

  it("keeps getting started and the price as two demo boxes on GradientBars", () => {
    const start = row("start");
    const free = row("free");
    for (const [k, r] of [
      ["start", start],
      ["free", free],
    ] as const)
      expect(
        r.querySelector("[data-row-box] [data-fp-bg] .wt-bars--glow"),
        `${k} on GradientBars`,
      ).not.toBeNull();
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
    const many = TRY.many.replace("{n}", "1.000");
    expect(free.querySelector("[data-count]")!.textContent.trim()).toBe(many);
    expect(
      free.querySelector('input[type="range"]')!.getAttribute("aria-valuetext"),
    ).toBe(many);
    for (const t of [PLANS.free.title, PLANS.help.title, PLANS.footnote])
      expect(f, t).toContain(t);
    for (const href of [CONTACT_URL, PAGES.business.path, PAGES.hent.path])
      expect(free.querySelector(`a[href="${href}"]`), href).not.toBeNull();
  });

  it("never uses GradientRows, nor the dark brown as a section background", () => {
    expect(d.querySelector(".wt-rows")).toBeNull();
    for (const i of islands(d))
      expect(i.props.surface, i.component).not.toBe("rows");
    for (const el of d.querySelectorAll(".wt-gbg"))
      expect(inside(el, ".wt-show"), el.toString().slice(0, 80)).toBe(true);
    for (const el of d.querySelectorAll("section, [data-fp-bg]"))
      expect(el.getAttribute("style") ?? "").not.toMatch(/mokka|rav-dyb/);
  });

  it("ties self-corrections to the optional AI cleanup (spec 6.10, PRIV-04)", () => {
    for (const el of main.querySelectorAll("p, li"))
      if (/onsdag, nej, torsdag/.test(el.textContent))
        expect(el.textContent, el.textContent).toMatch(/AI-oprydning/);
  });

  it("says the text lands on the computer you sit at, never on the others (spec 5.5, 12.1)", () => {
    const text = visibleText(main);
    expect(text).toContain("den computer, du sidder ved");
    expect(text).not.toMatch(/historikken|alle dine computere/);
  });

  it("has a short FAQ without the unmeasured question, linking to the rest", () => {
    const faq = main.querySelector('[data-feature="faq"]')!;
    const text = visibleText(faq);
    for (const q of FAQ) expect(text, q.q).toContain(q.q);
    expect(faq.querySelectorAll("details")).toHaveLength(FAQ.length);
    expect(faq.querySelector(`a[href="${PAGES.faq.path}"]`)).not.toBeNull();
  });

  it("keeps its rules under one prefix, after the design system, and stops for reduced motion", () => {
    const sheet = css();
    expect(sheet).toMatch(/prefers-reduced-motion/);
    expect(sheet).toContain(".fp-row");
    expect(sheet.indexOf(".wt-shiny")).toBeGreaterThanOrEqual(0);
    expect(sheet.indexOf(".wt-shiny")).toBeLessThan(sheet.indexOf(".fp-"));
    expect(sheet).not.toMatch(/\.(fw|fb|fm|ps|ho|ed)-[a-z]/);
  });

  it(`loads nothing from other origins and keeps its JavaScript under ${JS_BUDGET / 1024} KB (SITE-04, SITE-06)`, () => {
    for (const el of d.querySelectorAll(
      '[src], link[href]:not([rel="canonical"])',
    )) {
      const url = el.getAttribute("src") ?? el.getAttribute("href")!;
      expect(url, url).not.toMatch(/^(https?:)?\/\//);
    }
    expect(scriptBytes(d)).toBeLessThanOrEqual(JS_BUDGET);
  });
});
