/* Builds the front page's three final pages as draft previews and deploys each to its own Cloudflare Pages preview
   branch of the project walkietalkey-site (run 8), so the owner can pick one. Production is never touched: the
   branches are final-1, final-2 and final-3, never main, and nothing here runs `wrangler deploy` (walkietalkey.com and
   www are Workers on custom domains) or changes the project's settings.
   Usage: bun scripts/deploy-previews.ts [page ...]   (default: all three; needs `wrangler login`)
   Each build goes to .concepts/<concept>/ with SITE_CONCEPT=<concept> and SITE_DRAFT=1 (lib/build.ts). */
import { execFileSync } from "node:child_process";
import {
  CONCEPTS,
  pickConcept,
  previewBranch,
  type Concept,
} from "../src/lib/build";
import { SITE, buildConcept } from "./concepts";

const PROJECT = "walkietalkey-site";
const wanted: Concept[] = process.argv.slice(2).length
  ? process.argv.slice(2).map((v) => pickConcept(v)!)
  : [...CONCEPTS];

for (const c of wanted) {
  const branch = previewBranch(c);
  if (!/^final-[123]$/.test(branch))
    throw new Error(`refusing to deploy to the branch "${branch}"`);
  console.log(`\n== ${c}: build`);
  const out = buildConcept(c, true);
  console.log(`== ${c}: deploy to the preview branch ${branch}`);
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
      cwd: SITE,
      stdio: "inherit",
      env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
    },
  );
  console.log(`== ${c}: https://${branch}.${PROJECT}.pages.dev`);
}
