/* Screenshots of the front page for review rounds: at 1440, 1024 and 390 px wide, the first screen with motion (after
   the hero's sequence has landed) and with reduced motion, and the full page with reduced motion (every demo standing
   finished). Usage: bun scripts/front-shots.ts <outDir> [url]
   Without a url it serves the local build in dist/ (bun run build first).
   Output: <outDir>/home-<1440|1024|390>-<first|first-reduced|page>.png */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium } from "@playwright/test";

const site = resolve(import.meta.dir, "..");
const out = resolve(process.argv[2] || join(site, ".visual/front"));
mkdirSync(out, { recursive: true });

let server: ReturnType<typeof spawn> | undefined;
let url = process.argv[3]?.replace(/\/$/, "");
if (!url) {
  if (!existsSync(join(site, "dist/index.html")))
    throw new Error("no build in dist/: run bun run build first");
  const port = 4460;
  server = spawn("bun", [join(site, "scripts/serve.ts"), String(port)], {
    stdio: "ignore",
  });
  await new Promise((r) => setTimeout(r, 700));
  url = `http://localhost:${port}`;
}

const WIDTHS = {
  1440: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
  1024: { viewport: { width: 1024, height: 768 }, deviceScaleFactor: 1 },
  390: {
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  },
} as const;

const browser = await chromium.launch({
  channel: "chrome",
  args: ["--enable-unsafe-swiftshader"],
});
try {
  for (const [w, opts] of Object.entries(WIDTHS)) {
    for (const reduced of [false, true]) {
      const ctx = await browser.newContext({
        ...opts,
        reducedMotion: reduced ? "reduce" : "no-preference",
      });
      const p = await ctx.newPage();
      await p.goto(url + "/");
      await p.waitForLoadState("load");
      await p.waitForTimeout(reduced ? 1200 : 8000);
      await p.screenshot({
        path: join(out, `home-${w}-first${reduced ? "-reduced" : ""}.png`),
      });
      await ctx.close();
    }
    /* the whole page, calm, at 1x: a long page at 2x passes Chrome's 16,384 px capture limit */
    const calm = await browser.newContext({
      ...opts,
      deviceScaleFactor: 1,
      reducedMotion: "reduce",
    });
    const p = await calm.newPage();
    await p.goto(url + "/");
    await p.evaluate(async () => {
      for (let y = 0; y < document.documentElement.scrollHeight; y += 400) {
        scrollTo(0, y);
        await new Promise((r) => setTimeout(r, 120));
      }
      scrollTo(0, 0);
    });
    await p.waitForTimeout(800);
    await p.screenshot({
      path: join(out, `home-${w}-page.png`),
      fullPage: true,
    });
    await calm.close();
  }
  console.log(`screenshots in ${out}`);
} finally {
  await browser.close();
  server?.kill();
}
