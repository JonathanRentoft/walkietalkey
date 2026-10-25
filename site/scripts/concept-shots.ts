/* Screenshots of the front page's three concepts, for the owner and for comparing them side by side (run 6): each at
   1440 px and 390 px wide, as the first screen (with motion, a moment into the page) and as the full page in its
   calm state (reduced motion). Then one sheet per width with the three side by side.
   Usage: bun scripts/concept-shots.ts <outDir> [concept=url ...]
   Without urls it serves the local draft builds in .concepts/<concept>/ (bun scripts/concepts.ts builds them).
   Output: <outDir>/<letter>-<concept>-<1440|390>-<first|page>.png and <outDir>/compare-<1440|390>-<first|page>.png */
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
  390: {
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  },
} as const;

const name = (c: Concept) => `${CONCEPT_INFO[c].letter}-${c}`;
const browser = await chromium.launch({ channel: "chrome" });
try {
  for (const [i, c] of CONCEPTS.entries()) {
    const url = await urlFor(c, i);
    for (const [w, opts] of Object.entries(WIDTHS)) {
      /* the first screen, with motion, two seconds in */
      const live = await browser.newContext({ ...opts });
      const p1 = await live.newPage();
      await p1.goto(url + "/");
      await p1.waitForTimeout(2000);
      await p1.screenshot({ path: join(out, `${name(c)}-${w}-first.png`) });
      await live.close();
      /* the whole page, calm, at 1x: a long page at 2x passes Chrome's 16,384 px capture limit */
      const calm = await browser.newContext({
        ...opts,
        deviceScaleFactor: 1,
        reducedMotion: "reduce",
      });
      const p2 = await calm.newPage();
      await p2.goto(url + "/");
      await p2.evaluate(async () => {
        for (let y = 0; y < document.documentElement.scrollHeight; y += 500) {
          scrollTo(0, y);
          await new Promise((r) => setTimeout(r, 60));
        }
        scrollTo(0, 0);
      });
      await p2.waitForTimeout(400);
      await p2.screenshot({
        path: join(out, `${name(c)}-${w}-page.png`),
        fullPage: true,
      });
      await calm.close();
    }
  }
  /* side by side: one sheet per width and kind, the three concepts in a row */
  for (const w of Object.keys(WIDTHS))
    for (const kind of ["first", "page"]) {
      const imgs = CONCEPTS.map((c) => {
        const b64 = readFileSync(
          join(out, `${name(c)}-${w}-${kind}.png`),
        ).toString("base64");
        return `<figure><figcaption>${CONCEPT_INFO[c].letter.toUpperCase()} ${CONCEPT_INFO[c].title}</figcaption><img src="data:image/png;base64,${b64}"></figure>`;
      }).join("");
      const html = `<!doctype html><style>body{margin:0;display:flex;gap:24px;padding:24px;background:#d9d6d0;align-items:flex-start;font:600 22px system-ui}figure{margin:0;flex:1}img{width:100%;display:block;border:1px solid #0002}</style>${imgs}`;
      const file = join(out, `compare-${w}-${kind}.html`);
      writeFileSync(file, html);
      const ctx = await browser.newContext({
        viewport: { width: w === "1440" ? 2400 : 1300, height: 900 },
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
