/* Full-page screenshots of every page on a phone and on a desktop, for a quick look.
   Usage: bun scripts/shots.ts [baseURL]   Output: .visual/shots/<page>-<device>.png */
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium, devices } from "@playwright/test";
import { PAGES } from "../src/lib/site";

const base = process.argv[2] || "http://localhost:4329";
const out = join(resolve(import.meta.dir, ".."), ".visual/shots");
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ channel: "chrome" });
for (const [device, opts] of [
  ["phone", devices["Pixel 7"]],
  ["desktop", { viewport: { width: 1280, height: 900 } }],
] as const) {
  const ctx = await browser.newContext({ ...opts, reducedMotion: "reduce" });
  const page = await ctx.newPage();
  for (const [key, p] of Object.entries(PAGES)) {
    await page.goto(base + p.path);
    await page.evaluate(async () => {
      for (let y = 0; y < document.body.scrollHeight; y += 400) {
        window.scrollTo(0, y);
        await new Promise((r) => setTimeout(r, 40));
      }
      window.scrollTo(0, 0);
    });
    await page.waitForTimeout(500);
    await page.screenshot({
      path: join(out, `${key}-${device}.png`),
      fullPage: true,
    });
  }
  await ctx.close();
}
await browser.close();
console.log("screenshots in " + out);
