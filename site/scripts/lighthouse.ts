/* Runs Lighthouse (mobile, the default simulated throttling) in the installed Google Chrome and prints the scores
   and the audits that cost points (SITE-06). Usage: bun scripts/lighthouse.ts [url] */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const url = process.argv[2] || "https://walkietalkey-site.pages.dev/";
const out = join(resolve(import.meta.dir, ".."), ".visual");
mkdirSync(out, { recursive: true });
const file = join(out, "lighthouse.json");
execFileSync(
  "bunx",
  [
    "lighthouse@13",
    url,
    "--quiet",
    "--output=json",
    `--output-path=${file}`,
    "--only-categories=performance,accessibility,best-practices,seo",
    "--chrome-flags=--headless=new",
  ],
  { stdio: "inherit" },
);

const r = JSON.parse(readFileSync(file, "utf8"));
for (const c of Object.values<{ title: string; score: number }>(r.categories))
  console.log(`${c.title.padEnd(16)} ${Math.round(c.score * 100)}`);
for (const k of [
  "first-contentful-paint",
  "largest-contentful-paint",
  "total-blocking-time",
  "cumulative-layout-shift",
  "speed-index",
]) {
  console.log(`  ${k.padEnd(26)} ${r.audits[k].displayValue}`);
}
const weak = Object.values<{
  id: string;
  title: string;
  score: number | null;
  scoreDisplayMode: string;
}>(r.audits).filter(
  (a) =>
    a.score !== null &&
    a.score < 0.9 &&
    ["binary", "numeric", "metricSavings"].includes(a.scoreDisplayMode),
);
if (weak.length)
  console.log(
    "below 0.9:\n" +
      weak.map((a) => `  ${a.id}: ${a.title} (${a.score})`).join("\n"),
  );
