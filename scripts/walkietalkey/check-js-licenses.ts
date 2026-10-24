#!/usr/bin/env bun
/**
 * Licence check for every installed npm package (spec section 11: CI fails
 * when a dependency with an unknown or non-permissive licence is added).
 * Walks node_modules (bun workspaces hoist everything there) and checks each
 * package's SPDX licence against the allow list; an expression passes when
 * every alternative of some OR branch is allowed.
 *
 *   bun scripts/walkietalkey/check-js-licenses.ts
 */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const ALLOWED = new Set([
  "MIT",
  "MIT-0",
  "ISC",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "0BSD",
  "CC0-1.0",
  "Unlicense",
  "BlueOak-1.0.0",
  "Python-2.0",
  "Zlib",
  "MPL-2.0",
  "CC-BY-4.0",
  "OFL-1.1",
]);

/** Packages outside the list, with why they are acceptable. */
const EXCEPTIONS: Record<string, string> = {
  "@img/sharp-libvips-darwin-arm64":
    "LGPL libvips binary used by Astro's image build step; never shipped in the site or the apps",
  "@img/sharp-libvips-darwin-x64": "same, Intel macOS",
  "@img/sharp-libvips-linux-x64": "same, Linux CI",
  "@img/sharp-libvips-linuxmusl-x64": "same, Linux CI",
  "@img/sharp-libvips-linux-arm64": "same, Linux CI",
  "@img/sharp-libvips-win32-x64": "same, Windows",
};

function licenceOf(pkg: Record<string, unknown>): string | undefined {
  const lic = pkg.license ?? pkg.licenses;
  if (typeof lic === "string") return lic;
  if (Array.isArray(lic))
    return lic
      .map((l) => (typeof l === "string" ? l : (l as { type?: string }).type))
      .join(" OR ");
  if (lic && typeof lic === "object") return (lic as { type?: string }).type;
  return undefined;
}

export function allowed(expression: string): boolean {
  const cleaned = expression.replace(/[()]/g, " ").trim();
  return cleaned
    .split(/\s+OR\s+/i)
    .some((branch) =>
      branch.split(/\s+AND\s+/i).every((id) => ALLOWED.has(id.trim())),
    );
}

function* packages(dir: string): Generator<string> {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const path = join(dir, entry.name);
    if (entry.name.startsWith("@")) {
      yield* packages(path);
      continue;
    }
    if (existsSync(join(path, "package.json"))) yield path;
    yield* packages(join(path, "node_modules"));
  }
}

if (import.meta.main) {
  const roots = [
    "node_modules",
    "phone/node_modules",
    "site/node_modules",
    "relay/node_modules",
    "packages/ui/node_modules",
    "packages/protocol/node_modules",
  ];
  const failures: string[] = [];
  let checked = 0;
  for (const root of roots) {
    for (const path of packages(root)) {
      const pkg = JSON.parse(readFileSync(join(path, "package.json"), "utf8"));
      if (!pkg.name || pkg.private) continue;
      checked++;
      const licence = licenceOf(pkg);
      if (pkg.name in EXCEPTIONS) continue;
      if (!licence || !allowed(licence))
        failures.push(`${pkg.name}@${pkg.version}: ${licence ?? "no licence"}`);
    }
  }
  if (failures.length) {
    console.error(
      `Licences not allowed (${failures.length}):\n  ${[...new Set(failures)].join("\n  ")}`,
    );
    process.exit(1);
  }
  console.log(`licences ok (${checked} packages)`);
}
