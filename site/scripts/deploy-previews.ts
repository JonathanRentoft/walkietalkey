/* Builds the front page's three hero variants as draft previews and deploys each to its own Cloudflare Pages preview
   branch of the project walkietalkey-site (run 5), so the owner can compare them. Production is never touched: the
   branches are hero-fn, hero-phone and hero-privacy, never main, and nothing here runs `wrangler deploy` (walkietalkey.com
   and www are Workers on custom domains) or changes the project's settings.
   Usage: bun scripts/deploy-previews.ts [variant ...]   (default: all three; needs `wrangler login`)
   Each build goes to .variants/<variant>/ with SITE_HERO=<variant> and SITE_DRAFT=1 (lib/hero.ts). */
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  HERO_VARIANTS,
  pickHero,
  previewBranch,
  type HeroVariant,
} from "../src/lib/hero";

const PROJECT = "walkietalkey-site";
const site = resolve(import.meta.dir, "..");
const wanted: HeroVariant[] = process.argv.slice(2).length
  ? process.argv.slice(2).map((v) => pickHero(v))
  : [...HERO_VARIANTS];

for (const v of wanted) {
  const branch = previewBranch(v);
  if (!/^hero-[a-z]+$/.test(branch))
    throw new Error(`refusing to deploy to the branch "${branch}"`);
  const out = join(site, ".variants", v);
  rmSync(out, { recursive: true, force: true });
  console.log(`\n== ${v}: build into ${out}`);
  execFileSync("bunx", ["astro", "build", "--outDir", out], {
    cwd: site,
    stdio: "inherit",
    env: {
      ...process.env,
      SITE_HERO: v,
      SITE_DRAFT: "1",
      ASTRO_TELEMETRY_DISABLED: "1",
    },
  });
  console.log(`== ${v}: deploy to the preview branch ${branch}`);
  execFileSync(
    "bunx",
    [
      "wrangler",
      "pages",
      "deploy",
      out,
      "--project-name",
      PROJECT,
      "--branch",
      branch,
      "--commit-dirty=true",
    ],
    {
      cwd: site,
      stdio: "inherit",
      env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
    },
  );
}
