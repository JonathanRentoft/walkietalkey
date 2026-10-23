/**
 * Build steps for every app that ships the design system's files: the site (Astro), the phone app and the desktop UI
 * (Vite). They run on the finished output folder, after the bundler has written it.
 *
 * - Spec 11: Albert Sans is under the SIL Open Font License, whose text must travel with the font. `OFL.txt` is copied
 *   into every folder of the output that holds an Albert Sans font file.
 * - Spec 14.8: logo copies in a `public/` folder carry a README with the trademark note. Bundlers copy `public/` into
 *   the output as it is, so the README is removed again: it belongs in the repository, not on the web server.
 */
import { copyFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The licence text in this package, next to the font it covers. (Not `new URL(path, import.meta.url)`, which Vite
    rewrites into an asset URL when this file is bundled or tested for the browser.) */
export const FONT_LICENCE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "assets",
  "fonts",
  "OFL.txt",
);
/** The file name the licence gets in a build output. */
export const FONT_LICENCE_FILE = "OFL.txt";

const ALBERT_SANS = /^albert-sans.*\.woff2?$/i;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

/** Copies OFL.txt next to every Albert Sans font file under `outDir`. Returns the files written. */
export function copyFontLicence(outDir: string): string[] {
  const folders = new Set(
    walk(outDir)
      .filter((f) => ALBERT_SANS.test(basename(f)))
      .map((f) => dirname(f)),
  );
  return Array.from(folders, (folder) => {
    const target = join(folder, FONT_LICENCE_FILE);
    copyFileSync(FONT_LICENCE_PATH, target);
    return target;
  });
}

/** Deletes every README.md under `outDir` (the trademark notes copied in from `public/`). Returns the files removed. */
export function removeReadmes(outDir: string): string[] {
  const readmes = walk(outDir).filter((f) => basename(f) === "README.md");
  for (const f of readmes) rmSync(f);
  return readmes;
}

/** The part of Vite's resolved config the plugin reads. */
interface OutputConfig {
  root: string;
  build: { outDir: string };
}

/** Vite plugin: `copyFontLicence` on the output folder once the build has closed. */
export function fontLicence() {
  let outDir = "";
  return {
    name: "walkietalkey-font-licence",
    apply: "build" as const,
    configResolved(config: OutputConfig) {
      outDir = isAbsolute(config.build.outDir)
        ? config.build.outDir
        : join(config.root, config.build.outDir);
    },
    closeBundle() {
      copyFontLicence(outDir);
    },
  };
}
