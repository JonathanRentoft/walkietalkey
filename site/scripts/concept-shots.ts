/* Screenshots of the front page's three final pages (run 8), for the owner and for the review rounds: each at 1440,
   1024 and 390 px wide, as the first screen (with motion, a moment into the page) and as the full page (reduced
   motion, so every demo stands finished), plus the first screen with reduced motion. Then one sheet per width and
   kind with the three side by side.
   Usage: bun scripts/concept-shots.ts <outDir> [page=url ...]
   Without urls it serves the local draft builds in .concepts/<page>/ (bun scripts/concepts.ts builds them).
   Output: <outDir>/<page>-<1440|1024|390>-<first|page|first-reduced>.png and <outDir>/compare-<width>-<kind>.png */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium } from "@playwright/test";
import { CONCEPTS, CONCEPT_INFO, type Concept } from "../src/lib/build";
import { SITE } from "./concepts";

const out = resolve(process.argv[2] || join(SITE, ".visual/concepts"));
mkdirSync(out, { recursive: true });
const given = Object.fromEntries(
  process.argv.slice(3).map((a) => a.split("=", 2) as [string, string]),
);
const only = process.env.SHOTS_ONLY
  ? CONCEPTS.filter((c) => process.env.SHOTS_ONLY!.split(",").includes(c))
  : CONCEPTS;

const servers: ReturnType<typeof spawn>[] = [];
async function urlFor(c: Concept, i: number): Promise<string> {
  if (given[c]) return given[c].replace(/\/$/, "");
  const dir = join(SITE, ".concepts", c);
  if (!existsSync(join(dir, "index.html")))
    throw new Error(`no build in ${dir}: run bun scripts/concepts.ts first`);
  const port = 4450 + i;
  servers.push(
    spawn("bun", [join(SITE, "scripts/serve.ts"), String(port), dir], {
      stdio: "ignore",
    }),
  );
  await new Promise((r) => setTimeout(r, 700));
  return `http://localhost:${port}`;
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

const browser = await chromium.launch({ channel: "chrome" });
try {
  for (const [i, c] of only.entries()) {
    const url = await urlFor(c, CONCEPTS.indexOf(c) + i * 0);
    for (const [w, opts] of Object.entries(WIDTHS)) {
      /* the first screen, with motion, after the hero's sequence has landed */
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
          path: join(out, `${c}-${w}-first${reduced ? "-reduced" : ""}.png`),
        });
        await ctx.close();
      }
      /* the whole page, calm, at 1x: a long page at 2x passes Chrome's 16,384 px capture limit */
      const calm = await browser.newContext({
        ...opts,
        deviceScaleFactor: 1,
        reducedMotion: "reduce",
      });
      const p2 = await calm.newPage();
      await p2.goto(url + "/");
      await p2.evaluate(async () => {
        for (let y = 0; y < document.documentElement.scrollHeight; y += 400) {
          scrollTo(0, y);
          await new Promise((r) => setTimeout(r, 120));
        }
        scrollTo(0, 0);
      });
      await p2.waitForTimeout(800);
      await p2.screenshot({
        path: join(out, `${c}-${w}-page.png`),
        fullPage: true,
      });
      await calm.close();
    }
  }
  /* side by side: one sheet per width and kind, the three pages in a row */
  if (only.length === CONCEPTS.length)
    for (const w of Object.keys(WIDTHS))
      for (const kind of ["first", "page"]) {
        const imgs = CONCEPTS.map((c) => {
          const b64 = readFileSync(join(out, `${c}-${w}-${kind}.png`)).toString(
            "base64",
          );
          return `<figure><figcaption>${CONCEPT_INFO[c].n} ${c} (${CONCEPT_INFO[c].title})</figcaption><img src="data:image/png;base64,${b64}"></figure>`;
        }).join("");
        const html = `<!doctype html><style>body{margin:0;display:flex;gap:24px;padding:24px;background:#d9d6d0;align-items:flex-start;font:600 22px system-ui}figure{margin:0;flex:1}img{width:100%;display:block;border:1px solid #0002}</style>${imgs}`;
        const file = join(out, `compare-${w}-${kind}.html`);
        writeFileSync(file, html);
        const ctx = await browser.newContext({
          viewport: { width: w === "390" ? 1300 : 2400, height: 900 },
        });
        const p = await ctx.newPage();
        await p.goto("file://" + file);
        await p.screenshot({
          path: join(out, `compare-${w}-${kind}.png`),
          fullPage: true,
        });
        await ctx.close();
      }
  console.log(`screenshots in ${out}`);
} finally {
  await browser.close();
  for (const s of servers) s.kill();
}
