/* Compares the built homepage with the design system's ForsideKomplet preview at 1280px, with reduced motion (so
   both stand still). Needs the preview pages from packages/ui (bun run visual there) and a running site
   (bun scripts/serve.ts). Usage: bun scripts/compare-home.ts [baseURL]
   Output: .visual/home-{kit,site,diff}.png and the share of differing pixels per 200px band. */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium, type Page } from "@playwright/test";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";

const base = process.argv[2] || "http://localhost:4329";
const site = resolve(import.meta.dir, "..");
const kitPage = resolve(
  site,
  "../packages/ui/.visual/pages/kit/ForsideKomplet.html",
);
const out = join(site, ".visual");
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({
  channel: "chrome",
  args: [
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
    "--force-color-profile=srgb",
    "--allow-file-access-from-files",
  ],
});

async function shot(url: string): Promise<PNG> {
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    deviceScaleFactor: 1,
    reducedMotion: "reduce",
  });
  const page: Page = await ctx.newPage();
  await page.goto(url);
  await page.evaluate(() => document.fonts.ready);
  /* scroll through so every island hydrates, then back */
  await page.evaluate(async () => {
    for (let y = 0; y < document.body.scrollHeight; y += 400) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 50));
    }
    window.scrollTo(0, document.body.scrollHeight);
    await new Promise((r) => setTimeout(r, 800));
    window.scrollTo(0, 0);
  });
  await page.waitForTimeout(800);
  const png = PNG.sync.read(
    await page.screenshot({
      fullPage: true,
      animations: "disabled",
      caret: "hide",
    }),
  );
  await ctx.close();
  return png;
}

const kit = await shot("file://" + kitPage);
const mine = await shot(base + "/");
await browser.close();
const h = Math.min(kit.height, mine.height),
  w = 1280;
const crop = (p: PNG) => {
  const c = new PNG({ width: w, height: h });
  PNG.bitblt(p, c, 0, 0, w, h, 0, 0);
  return c;
};
const a = crop(kit),
  b = crop(mine),
  diff = new PNG({ width: w, height: h });
const total = pixelmatch(a.data, b.data, diff.data, w, h, { threshold: 0.1 });
writeFileSync(join(out, "home-kit.png"), PNG.sync.write(kit));
writeFileSync(join(out, "home-site.png"), PNG.sync.write(mine));
writeFileSync(join(out, "home-diff.png"), PNG.sync.write(diff));
console.log(
  `kit ${kit.height}px, site ${mine.height}px tall; ${((total / (w * h)) * 100).toFixed(2)} % of the common area differs`,
);
for (let y = 0; y < h; y += 200) {
  let n = 0;
  for (let yy = y; yy < Math.min(h, y + 200); yy++)
    for (let x = 0; x < w; x++) {
      const i = (yy * w + x) * 4;
      if (diff.data[i] === 255 && diff.data[i + 1] < 100) n++;
    }
  if (n > 50)
    console.log(
      `  ${String(y).padStart(5)}px  ${((n / (w * 200)) * 100).toFixed(2)} %`,
    );
}
