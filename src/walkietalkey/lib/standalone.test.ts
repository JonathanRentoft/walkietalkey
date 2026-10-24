// WalkieTalkey is its own product (DESK-01, OSS-02, run 3). The docs, the
// site, the project files and the Danish and English UI never call it a fork
// or say it is built on Handy, and the monthly sync with Handy is gone. Handy
// is named only where its MIT notice belongs: next to a licence (NOTICE,
// licenses/, the licence lists). Run with `bun test src/walkietalkey`.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));

/** Text files under `dir` (relative to the repository) with one of `exts`. */
function filesUnder(dir: string, exts: string[]): string[] {
  const abs = join(ROOT, dir);
  if (!existsSync(abs)) return [];
  if (statSync(abs).isFile()) return [dir];
  const out: string[] = [];
  for (const name of readdirSync(abs)) {
    if (name === "node_modules" || name === "dist" || name.startsWith("."))
      continue;
    const rel = join(dir, name);
    if (statSync(join(ROOT, rel)).isDirectory())
      out.push(...filesUnder(rel, exts));
    else if (exts.some((e) => name.endsWith(e))) out.push(rel);
  }
  return out;
}

const SCANNED = [
  ...[
    "README.md",
    "CONTRIBUTING.md",
    "AGENTS.md",
    "CLAUDE.md",
    "BUILD.md",
    "CHANGELOG.md",
    "TRADEMARKS.md",
    "SECURITY.md",
    "CODE_OF_CONDUCT.md",
  ].filter((f) => existsSync(join(ROOT, f))),
  ...filesUnder("docs", [".md"]),
  ...filesUnder(".github", [".md", ".yml"]),
  ...filesUnder("site/src", [".astro", ".ts", ".tsx", ".md"]),
  ...filesUnder("models", ["README.md"]),
  "src/i18n/locales/da/translation.json",
  "src/i18n/locales/en/translation.json",
];

/** Wording that presents WalkieTalkey as a fork, or the old upstream sync. */
const FORK_WORDING = [
  /\bfork of handy\b/i,
  /\bhandy fork\b/i,
  /\bforked from handy\b/i,
  /\b(based|built|builds) on handy\b/i,
  /\bbygge[rt]? (oven )?på handy\b/i,
  /\bbaseret på handy\b/i,
  /\(from handy\)/i,
  /\bhandy's folders\b/i,
  /\bsync med handy\b/i,
  /\bkeeping up with handy\b/i,
  /\bgit fetch upstream\b/i,
  /\bupstream (merges?|remote)\b/i,
  /\bmerges? from handy\b/i,
];

/** "Handy" as a name (Handy, Handy's, Handys), not handy-keys and friends. */
const HANDY_NAME = /\bHandys?\b/;
const LICENCE_CONTEXT = /MIT|licen[cs]/i;

function lines(file: string): string[] {
  return readFileSync(join(ROOT, file), "utf8").split("\n");
}

describe("WalkieTalkey stands on its own (DESK-01, OSS-02)", () => {
  test("the scan covers the project files, the docs, the site and the UI", () => {
    for (const f of [
      "README.md",
      "AGENTS.md",
      "CONTRIBUTING.md",
      "docs/SPEC.md",
      "site/src/pages/open-source.astro",
      "src/i18n/locales/da/translation.json",
    ])
      assert.ok(SCANNED.includes(f), `${f} is not scanned`);
  });

  test("nothing calls WalkieTalkey a fork or describes a sync with Handy", () => {
    const hits: string[] = [];
    for (const file of SCANNED)
      lines(file).forEach((line, i) => {
        for (const re of FORK_WORDING)
          if (re.test(line)) hits.push(`${file}:${i + 1}: ${line.trim()}`);
      });
    assert.deepEqual(hits, []);
  });

  test("Handy is named only next to a licence", () => {
    const hits: string[] = [];
    for (const file of SCANNED)
      lines(file).forEach((line, i) => {
        if (HANDY_NAME.test(line) && !LICENCE_CONTEXT.test(line))
          hits.push(
            `${relative(ROOT, join(ROOT, file))}:${i + 1}: ${line.trim()}`,
          );
      });
    assert.deepEqual(hits, []);
  });

  test("Handy's licence notice stays where its licence requires it", () => {
    assert.match(
      readFileSync(join(ROOT, "licenses/Handy-MIT.txt"), "utf8"),
      /Permission is hereby granted/,
    );
    assert.match(readFileSync(join(ROOT, "NOTICE"), "utf8"), /Handy \(MIT/);
    const da = JSON.parse(
      readFileSync(join(ROOT, "src/i18n/locales/da/translation.json"), "utf8"),
    );
    assert.match(da.wt.about.credit.handy, /MIT/);
  });

  test("the Nix packaging is gone", () => {
    for (const f of ["flake.nix", "flake.lock", "nix", ".nix"])
      assert.equal(existsSync(join(ROOT, f)), false, `${f} still exists`);
  });

  test("the app links to WalkieTalkey's own help, not Handy's", () => {
    const src = readFileSync(
      join(ROOT, "src/components/SecureInputWarning.tsx"),
      "utf8",
    );
    assert.doesNotMatch(src, /handy\.computer/);
    assert.match(src, /https:\/\/walkietalkey\.com\//);
  });
});
