/* Usage: bun scripts/gen-tokens.ts [--check]
   Writes src/styles/tokens.css and src/tokens.ts from tokens/tokens.json (a copy of the design system's tokens.json).
   With --check it only verifies that the committed files are up to date. */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { generate, type TokensJson } from "./tokens-lib";

const root = fileURLToPath(new URL("..", import.meta.url));
const json = JSON.parse(readFileSync(root + "tokens/tokens.json", "utf8")) as TokensJson;
const out = generate(json);
const targets: [string, string][] = [
  [root + "src/styles/tokens.css", out.css],
  [root + "src/tokens.ts", out.ts],
];

if (process.argv.includes("--check")) {
  const stale = targets.filter(([file, text]) => {
    try { return readFileSync(file, "utf8") !== text; } catch { return true; }
  });
  if (stale.length) {
    console.error("Out of date: " + stale.map(([f]) => f.slice(root.length)).join(", ") + ". Run bun run gen:tokens.");
    process.exit(1);
  }
  console.log("tokens up to date");
} else {
  for (const [file, text] of targets) writeFileSync(file, text);
  console.log("wrote " + targets.map(([f]) => f.slice(root.length)).join(", "));
}
