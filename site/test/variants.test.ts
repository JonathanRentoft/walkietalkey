/* Run 5: three hero variants over the same page, chosen at build time (SITE_HERO), each deployed to its own Cloudflare
   Pages preview (scripts/deploy-previews.ts). The previews are drafts (SITE_DRAFT=1): they show the claims nobody has
   measured yet, visibly marked TODO(claim), so the owner can judge them; production never shows them. */
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse, type HTMLElement } from "node-html-parser";
import { beforeAll, describe, expect, it } from "vitest";
import {
  HERO,
  HERO_VARIANTS,
  PREVIEW_BRANCHES,
  previewBranch,
  type HeroVariant,
} from "../src/lib/hero";

const site = resolve(__dirname, "..");
const out = (v: HeroVariant) => join(site, ".variants", v);
const home: Partial<Record<HeroVariant, HTMLElement>> = {};

beforeAll(() => {
  for (const v of HERO_VARIANTS) {
    rmSync(out(v), { recursive: true, force: true });
    execFileSync("bunx", ["astro", "build", "--outDir", out(v), "--silent"], {
      cwd: site,
      env: {
        ...process.env,
        SITE_HERO: v,
        SITE_DRAFT: "1",
        ASTRO_TELEMETRY_DISABLED: "1",
      },
      stdio: "pipe",
    });
    home[v] = parse(readFileSync(join(out(v), "index.html"), "utf8"));
  }
}, 180_000);

const hero = (v: HeroVariant) =>
  home[v]!.querySelector('[data-section="hero"]')!;
/** the HTML of everything but the hero copy: the stage, the four sections, the footer */
const rest = (v: HeroVariant) => {
  const d = parse(home[v]!.toString());
  d.querySelector(".hero-copy")!.remove();
  d.querySelector('[data-section="hero"]')!.removeAttribute("data-hero");
  return d.querySelector("body")!.toString();
};

describe("hero variants (run 5)", () => {
  it.each(HERO_VARIANTS)("%s builds its own hero", (v) => {
    expect(hero(v).getAttribute("data-hero")).toBe(v);
    expect(hero(v).querySelector("h1")!.textContent).toBe(HERO[v].title);
    expect(hero(v).querySelector(".hero-lead")!.textContent).toBe(
      HERO[v].lead.replace("{fn}", "fn"),
    );
    expect(hero(v).querySelector(".hero-fine")!.textContent).toBe(HERO[v].fine);
  });
  it("puts every variant over the same page and the same signature animation", () => {
    const [a, ...others] = HERO_VARIANTS;
    for (const v of others) expect(rest(v), v).toBe(rest(a));
    expect(home.fn!.querySelectorAll("[data-stage]")).toHaveLength(1);
  });
  it.each(HERO_VARIANTS)(
    "%s marks every unmeasured claim visibly as TODO(claim)",
    (v) => {
      const claims = home[v]!.querySelectorAll("[data-claim]");
      expect(claims.length).toBeGreaterThanOrEqual(2);
      for (const c of claims) {
        expect(c.querySelector(".claim-tag")!.textContent).toBe("TODO(claim)");
        expect(c.getAttribute("title")).toMatch(/ikke målt/i);
      }
    },
  );
  it("deploys each variant to its own preview branch, never to production", () => {
    expect(PREVIEW_BRANCHES).toEqual(["hero-fn", "hero-phone", "hero-privacy"]);
    for (const v of HERO_VARIANTS) {
      expect(previewBranch(v)).toMatch(/^hero-/);
      expect(previewBranch(v)).not.toMatch(/^(main|master|production)$/);
    }
  });
});
