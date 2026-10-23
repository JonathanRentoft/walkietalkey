/* Records the hero animation (RelayDemo on the homepage) as docs/assets/hero.gif for the README (spec 14.3).
   Playwright records Chrome's screencast (a screenshot on every repaint, with its timestamp) through one loop in
   real time; ffmpeg (Homebrew) crops them to the demo and turns them into a GIF with the measured frame timings.
   Usage: bun scripts/hero-gif.ts [baseURL] (default: the local server, bun scripts/serve.ts). GIF_WIDTH sets the width. */
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium } from "@playwright/test";

const base = process.argv[2] || "http://localhost:4329";
const site = resolve(import.meta.dir, "..");
const frames = join(site, ".visual/gif");
const target = resolve(site, "../docs/assets/hero.gif");
const LOOP_MS = 14400; /* the sum of RelayDemo's steps */
rmSync(frames, { recursive: true, force: true });
mkdirSync(frames, { recursive: true });
mkdirSync(resolve(target, ".."), { recursive: true });

const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage({ viewport: { width: 1280, height: 1000 }, deviceScaleFactor: 1 });
await page.goto(base + "/");
await page.evaluate(() => document.fonts.ready);
const demo = page.locator(".demo");
await page.evaluate(() => { const d = document.querySelector(".demo")!; window.scrollTo(0, d.getBoundingClientRect().top + window.scrollY - 40); });
/* wait for the island to hydrate, then for the loop to come round to its first step */
await page.locator(".wt-relay-stage").evaluate((el) => new Promise<void>((done) => { const t = setInterval(() => { if (getComputedStyle(el).visibility === "visible") { clearInterval(t); done(); } }, 20); }));
await page.locator(".wt-relay.wt-relay--reset").waitFor({ timeout: 20000 });
await page.locator(".wt-relay.wt-relay--home").waitFor({ timeout: 5000 });

const box = (await demo.boundingBox())!;
const cdp = await page.context().newCDPSession(page);
const shots: { file: string; at: number }[] = [];
let first = 0;
cdp.on("Page.screencastFrame", (f) => {
  const ts = f.metadata.timestamp ?? Date.now() / 1000;
  if (!first) first = ts;
  const file = join(frames, `f${String(shots.length).padStart(4, "0")}.jpg`);
  writeFileSync(file, Buffer.from(f.data, "base64"));
  shots.push({ file, at: (ts - first) * 1000 });
  void cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId });
});
await cdp.send("Page.startScreencast", { format: "jpeg", quality: 95, everyNthFrame: 1 });
await page.waitForTimeout(LOOP_MS + 200);
await cdp.send("Page.stopScreencast");
await browser.close();

/* concat list with each frame's duration, cropped to the demo */
const kept = shots.filter((s) => s.at < LOOP_MS);
const list = kept.map((s, i) => `file '${s.file}'\nduration ${(((kept[i + 1]?.at ?? LOOP_MS) - s.at) / 1000).toFixed(3)}`).join("\n") + `\nfile '${kept[kept.length - 1].file}'\n`;
writeFileSync(join(frames, "list.txt"), list);
const crop = `crop=${Math.round(box.width)}:${Math.round(box.height)}:${Math.round(box.x)}:${Math.round(box.y)}`;
const width = Number(process.env.GIF_WIDTH || 760);
execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", join(frames, "list.txt"),
  "-vf", `${crop},fps=15,scale=${width}:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff:max_colors=160[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`,
  "-loop", "0", target], { stdio: "inherit" });
console.log(`${kept.length} frames in ${LOOP_MS} ms -> ${target} (${(statSync(target).size / 1024 / 1024).toFixed(2)} MB)`);
