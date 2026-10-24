/* Full-page screenshots of Hent as a Mac, a Windows and a phone visitor, at desktop and mobile widths, 1x and 2x.
   Usage: bun scripts/hent-shots.ts [baseURL] [outDir]   Output: <outDir>/hent-<visitor>-<width>@<scale>x.png */
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium } from "@playwright/test";

const base = process.argv[2] || "http://localhost:4329";
const out = resolve(
  process.argv[3] || join(import.meta.dir, "..", ".visual/hent"),
);
mkdirSync(out, { recursive: true });

const visitors = {
  mac: {
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15",
    mobile: false,
  },
  windows: {
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
    mobile: false,
  },
  phone: {
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1",
    mobile: true,
  },
} as const;
const widths = [
  { name: "desktop", viewport: { width: 1280, height: 900 } },
  { name: "mobile", viewport: { width: 390, height: 844 } },
] as const;

const browser = await chromium.launch({ channel: "chrome" });
for (const [visitor, v] of Object.entries(visitors))
  for (const w of widths)
    for (const scale of [1, 2]) {
      const ctx = await browser.newContext({
        userAgent: v.userAgent,
        viewport: w.viewport,
        deviceScaleFactor: scale,
        isMobile: v.mobile && w.name === "mobile",
        hasTouch: v.mobile,
        reducedMotion: "reduce",
      });
      const page = await ctx.newPage();
      await page.goto(base + "/hent");
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(400);
      const file = join(out, `hent-${visitor}-${w.name}@${scale}x.png`);
      await page.screenshot({ path: file, fullPage: true });
      await ctx.close();
    }
await browser.close();
console.log("screenshots in " + out);
