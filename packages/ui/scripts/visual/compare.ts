/* Screenshots every preview with the kit and with the port in Chrome (Playwright), at the same moments of a
   fake clock and with the same seeded Math.random, and compares them pixel by pixel.
   Run scripts/visual/build.ts first. Usage: bun scripts/visual/compare.ts [Name ...] [--reduced]
   Output: .visual/shots/<Name>-<t>-{kit,port,diff}.png and .visual/report.json */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium, type Page } from "@playwright/test";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";

const pkg = resolve(import.meta.dir, "../..");
const out = join(pkg, ".visual");
const shots = join(out, "shots");
mkdirSync(shots, { recursive: true });

const args = process.argv.slice(2);
const reduced = args.includes("--reduced");
const only = args.filter((a) => !a.startsWith("--"));
const cards: { name: string; height: number; page: boolean }[] = JSON.parse(readFileSync(join(out, "cards.json"), "utf8"));
const MOMENTS = reduced ? [1500] : [400, 2600, 6200, 9100];
const WIDTH = 1280;
const LIMIT = 0.002; /* at most 0.2 % of the pixels may differ for a frame to count as the same */

/* the same pseudo random numbers on both sides */
const SEED = `(() => { let a = 1234567; Math.random = function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a);
  t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; })();`;

async function shoot(page: Page, file: string, height: number): Promise<Buffer[]> {
  const t0 = new Date("2026-10-22T10:24:00Z").getTime();
  await page.clock.install({ time: t0 });
  await page.clock.pauseAt(t0 + 1000); /* time stands still while the page loads; only runFor moves it */
  await page.goto("file://" + file);
  await page.evaluate(() => document.fonts.ready);
  const frames: Buffer[] = [];
  let at = 0;
  for (const t of MOMENTS) {
    await page.clock.runFor(t - at);
    at = t;
    await page.waitForTimeout(60);
    /* SVG SMIL animations (logo gradient, glans sheen) run on their own timeline: pin it to the fake clock */
    await page.evaluate((sec) => { document.querySelectorAll("svg").forEach((s) => { if (!s.ownerSVGElement) { s.pauseAnimations(); s.setCurrentTime(sec); } }); }, t / 1000);
    frames.push(await page.screenshot({ animations: "disabled", clip: { x: 0, y: 0, width: WIDTH, height }, caret: "hide" }));
  }
  return frames;
}

const browser = await chromium.launch({ channel: "chrome", args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--force-color-profile=srgb", "--allow-file-access-from-files"] });
const report: Record<string, { moment: number; ratio: number; pixels: number }[]> = {};
const errors: Record<string, string[]> = {};
for (const card of cards) {
  if (only.length && !only.includes(card.name)) continue;
  const height = Math.min(card.height, 7000);
  const res: Buffer[][] = [];
  for (const side of ["kit", "port"] as const) {
    const ctx = await browser.newContext({ viewport: { width: WIDTH, height }, deviceScaleFactor: 1, reducedMotion: reduced ? "reduce" : "no-preference" });
    await ctx.addInitScript(SEED);
    const page = await ctx.newPage();
    page.on("pageerror", (e) => { (errors[card.name + ":" + side] ||= []).push(String(e)); });
    page.on("console", (m) => { if (m.type() === "error") (errors[card.name + ":" + side] ||= []).push(m.text()); });
    res.push(await shoot(page, join(out, "pages", side, card.name + ".html"), height));
    await ctx.close();
  }
  report[card.name] = MOMENTS.map((moment, k) => {
    const a = PNG.sync.read(res[0][k]), b = PNG.sync.read(res[1][k]);
    const diff = new PNG({ width: a.width, height: a.height });
    const pixels = pixelmatch(a.data, b.data, diff.data, a.width, a.height, { threshold: 0.1 });
    const tag = `${card.name}-${reduced ? "r" : ""}${moment}`;
    writeFileSync(join(shots, tag + "-kit.png"), res[0][k]);
    writeFileSync(join(shots, tag + "-port.png"), res[1][k]);
    if (pixels) writeFileSync(join(shots, tag + "-diff.png"), PNG.sync.write(diff));
    return { moment, ratio: pixels / (a.width * a.height), pixels };
  });
  const worst = Math.max(...report[card.name].map((r) => r.ratio));
  console.log(`${worst <= LIMIT ? "same" : "DIFF"}  ${card.name.padEnd(20)} worst ${(worst * 100).toFixed(3)} %  [${report[card.name].map((r) => r.pixels).join(", ")}]`);
}
await browser.close();
writeFileSync(join(out, reduced ? "report-reduced.json" : "report.json"), JSON.stringify({ limit: LIMIT, report, errors }, null, 2));
if (Object.keys(errors).length) console.log("page errors:", JSON.stringify(errors, null, 2));
const failed = Object.entries(report).filter(([, r]) => r.some((x) => x.ratio > LIMIT)).map(([n]) => n);
console.log(failed.length ? `different: ${failed.join(", ")}` : "all previews match");
process.exit(failed.length ? 1 : 0);
