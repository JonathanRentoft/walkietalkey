/* Builds the visual comparison pages: every components/<Name>/preview.html of the design system, once with the
   kit's bundle.js + bundle.css and once with this package (bundled as window.WalkieTalkey) + its CSS.
   Both get the same generated tokens.css and the same font, so any difference comes from the component port.

   Usage: bun scripts/visual/build.ts [--kit <design-system dir>]   (or WT_KIT=...)
   Output: .visual/pages/{kit,port}/<Name>.html */
import { execSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

const pkg = resolve(import.meta.dir, "../..");
const out = join(pkg, ".visual");

export function kitDir(): string {
  const arg = process.argv.indexOf("--kit");
  if (arg > 0) return resolve(process.argv[arg + 1]);
  if (process.env.WT_KIT) return resolve(process.env.WT_KIT);
  /* the kit sits next to the main checkout (it is git-ignored), so look beside the common git dir too */
  const roots = [resolve(pkg, "../..")];
  try {
    roots.push(
      dirname(
        resolve(
          pkg,
          execSync("git rev-parse --git-common-dir", { cwd: pkg })
            .toString()
            .trim(),
        ),
      ),
    );
  } catch {
    /* not a git checkout */
  }
  for (const r of roots)
    if (existsSync(join(r, "_kit/design-system/components/bundle.js")))
      return join(r, "_kit/design-system");
  throw new Error("Design system not found. Pass --kit <dir> or set WT_KIT.");
}

const BLOBS: Record<string, string> =
  {}; /* /_blob/<hash> in previews -> asset file */

async function main() {
  const kit = kitDir();
  const ds = JSON.parse(readFileSync(join(kit, "design-system.json"), "utf8"));
  for (const [group, g] of Object.entries<{
    files: Record<string, { blob: string; name: string }>;
  }>(ds.assetGroups)) {
    for (const f of Object.values(g.files))
      BLOBS[f.blob] = join(pkg, "assets", group, f.name);
  }

  mkdirSync(join(out, "pages/kit"), { recursive: true });
  mkdirSync(join(out, "pages/port"), { recursive: true });

  const built = await Bun.build({
    entrypoints: [join(import.meta.dir, "entry.tsx")],
    format: "iife",
    target: "browser",
    minify: false,
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
  });
  if (!built.success) {
    console.error(built.logs);
    process.exit(1);
  }
  writeFileSync(join(out, "port.js"), await built.outputs[0].text());

  const nm = (p: string) => {
    const [scope, ...rest] = p.split("/");
    return join(
      dirname(require.resolve(scope + "/package.json", { paths: [pkg] })),
      ...rest,
    );
  };
  const styles = join(pkg, "src/styles");
  const common = [
    `<link rel="stylesheet" href="file://${join(styles, "fonts.css")}">`,
    `<link rel="stylesheet" href="file://${join(styles, "tokens.css")}">`,
  ];
  const head = {
    kit: [
      ...common,
      `<link rel="stylesheet" href="file://${join(kit, "components/bundle.css")}">`,
      `<script src="file://${nm("react/umd/react.production.min.js")}"></script>`,
      `<script src="file://${nm("react-dom/umd/react-dom.production.min.js")}"></script>`,
      `<script src="file://${join(kit, "components/bundle.js")}"></script>`,
    ],
    port: [
      ...common,
      `<link rel="stylesheet" href="file://${join(styles, "components.css")}">`,
      `<link rel="stylesheet" href="file://${join(styles, "extensions.css")}">`,
      `<script src="file://${join(out, "port.js")}"></script>`,
    ],
  };

  const cards: { name: string; height: number; page: boolean }[] = [];
  for (const name of readdirSync(join(kit, "components")).sort()) {
    const file = join(kit, "components", name, "preview.html");
    if (!existsSync(file)) continue;
    let html = readFileSync(file, "utf8");
    const card = /@dsCard[^>]*height=(\d+)/.exec(html);
    cards.push({
      name,
      height: card ? Number(card[1]) : 600,
      page: /@dsCard[^>]*\bpage\b/.test(html),
    });
    html = html.replace(/\/_blob\/([0-9a-f]{32})/g, (m, h: string) =>
      BLOBS[h] ? "file://" + BLOBS[h] : m,
    );
    for (const side of ["kit", "port"] as const) {
      const page = html.replace(/<head>/i, "<head>\n" + head[side].join("\n"));
      writeFileSync(join(out, "pages", side, name + ".html"), page);
    }
  }
  writeFileSync(join(out, "cards.json"), JSON.stringify(cards, null, 2));
  console.log(`built ${cards.length} previews into ${out}/pages (kit: ${kit})`);
}

if (import.meta.main) await main();
