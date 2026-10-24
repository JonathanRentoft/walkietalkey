/* Screenshots of the front page's three hero variants, for the owner to compare (run 5): each at desktop width (1280)
   and phone width (390, 2x), as a full page in its calm final state (reduced motion) and as the first screen while the
   signature animation plays (the phone recording, the words appearing on the Mac). The site has a light theme only.
   Usage: bun scripts/hero-shots.ts <outDir> [variant=url ...]
   Without urls it serves the local builds in .variants/<variant>/ (bun scripts/deploy-previews.ts or the unit tests
   build them). Output: <outDir>/<variant>-<desktop|phone>-<page|first-screen|animation>.png */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium } from "@playwright/test";
import { HERO_VARIANTS, type HeroVariant } from "../src/lib/hero";

const out = resolve(
  process.argv[2] || join(import.meta.dir, "../.visual/heroes"),
);
mkdirSync(out, { recursive: true });
const given = Object.fromEntries(
  process.argv.slice(3).map((a) => a.split("=", 2) as [string, string]),
);

const servers: ReturnType<typeof spawn>[] = [];
async function urlFor(v: HeroVariant, i: number): Promise<string> {
  if (given[v]) return given[v].replace(/\/$/, "");
  const dir = resolve(import.meta.dir, "../.variants", v);
  if (!existsSync(join(dir, "index.html")))
    throw new Error(
      `no build in ${dir}: run bun scripts/deploy-previews.ts or the unit tests first`,
    );
  const port = 4440 + i;
  servers.push(
    spawn("bun", [join(import.meta.dir, "serve.ts"), String(port), dir], {
      stdio: "ignore",
    }),
  );
  await new Promise((r) => setTimeout(r, 600));
  return `http://localhost:${port}`;
}

const SIZES = {
  desktop: { viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 },
  phone: {
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  },
} as const;

const browser = await chromium.launch({ channel: "chrome" });
try {
  for (const [i, v] of HERO_VARIANTS.entries()) {
    const base = await urlFor(v, i);
    for (const [size, opts] of Object.entries(SIZES)) {
      /* the whole page, still */
      const still = await browser.newContext({
        ...opts,
        reducedMotion: "reduce",
      });
      const p1 = await still.newPage();
      await p1.goto(base + "/");
      await p1.evaluate(() => document.fonts.ready);
      await p1.screenshot({
        path: join(out, `${v}-${size}-page.png`),
        fullPage: true,
      });
      await still.close();
      /* the first screen while the phone records and the words appear */
      const moving = await browser.newContext({ ...opts });
      const p2 = await moving.newPage();
      await p2.goto(base + "/");
      await p2
        .locator('[data-stage][data-step="rec"]')
        .waitFor({ timeout: 15000 });
      await p2.waitForTimeout(3200);
      await p2.screenshot({ path: join(out, `${v}-${size}-first-screen.png`) });
      /* and the signature animation itself at that moment */
      await p2
        .locator("[data-stage]")
        .screenshot({ path: join(out, `${v}-${size}-animation.png`) });
      await moving.close();
      console.log(`${v} ${size}: ${base}`);
    }
  }
} finally {
  await browser.close();
  for (const s of servers) s.kill();
}
console.log("screenshots in " + out);
