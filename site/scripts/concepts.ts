/* Run 6: builds the front page's concepts (lib/build.ts) into .concepts/<name>/, for the tests, the screenshots and the
   preview deploys. A draft build (the default) also shows the unmeasured claims, marked TODO(claim); --prod builds
   what production would show into .concepts/<name>-prod/.
   Usage: bun scripts/concepts.ts [--prod] [concept ...]   (default: all three) */
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { CONCEPTS, pickConcept, type Concept } from "../src/lib/build";

export const SITE = resolve(import.meta.dirname ?? __dirname, "..");

/** Where a concept's build goes. */
export function conceptOut(c: Concept, draft = true): string {
  return join(SITE, ".concepts", draft ? c : `${c}-prod`);
}

/** Builds one concept; returns its folder. */
export function buildConcept(c: Concept, draft = true, quiet = false): string {
  const out = conceptOut(c, draft);
  rmSync(out, { recursive: true, force: true });
  execFileSync("bunx", ["astro", "build", "--outDir", out, ...(quiet ? ["--silent"] : [])], {
    cwd: SITE,
    stdio: quiet ? "pipe" : "inherit",
    env: {
      ...process.env,
      SITE_CONCEPT: c,
      SITE_DRAFT: draft ? "1" : "0",
      ASTRO_TELEMETRY_DISABLED: "1",
    },
  });
  return out;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const draft = !args.includes("--prod");
  const named = args.filter((a) => !a.startsWith("--"));
  const wanted = named.length ? named.map((v) => pickConcept(v)!) : [...CONCEPTS];
  for (const c of wanted) console.log(`${c}: ${buildConcept(c, draft)}`);
}
