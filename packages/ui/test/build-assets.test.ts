/* Build helpers shared by the site, the phone app and the desktop UI: the Albert Sans licence travels with the font
   (spec 11), and the trademark READMEs next to logo copies in public folders are never deployed (spec 14.8). */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  FONT_LICENCE_FILE,
  FONT_LICENCE_PATH,
  copyFontLicence,
  fontLicence,
  removeReadmes,
} from "../build/assets";

const assets = resolve(__dirname, "../assets");
const ofl = readFileSync(join(assets, "fonts/OFL.txt"), "utf8");
const NOTE = "Ikke omfattet af kodelicensen. Se TRADEMARKS.md.";

const dirs: string[] = [];
function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "wt-ui-build-"));
  dirs.push(root);
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body);
  }
  return root;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("the Albert Sans licence ships with the font (spec 11)", () => {
  it("points at the OFL text next to the font in the package", () => {
    expect(FONT_LICENCE_FILE).toBe("OFL.txt");
    expect(readFileSync(FONT_LICENCE_PATH, "utf8")).toBe(ofl);
    expect(ofl).toMatch(/SIL OPEN FONT LICENSE Version 1\.1/);
    expect(ofl).toMatch(/Albert Sans/);
  });

  it("copies OFL.txt into every folder of a build that holds an Albert Sans font file", () => {
    const out = tree({
      "index.html": "<!doctype html>",
      "assets/albert-sans-latin-wght-normal-AbC123.woff2": "font",
      "assets/index-x.js": "",
      "nested/deep/albert-sans-latin-wght-normal.BJ0ssN8N.woff2": "font",
      "other/inter.woff2": "font",
    });
    const written = copyFontLicence(out).sort();
    expect(written).toEqual(
      [join(out, "assets/OFL.txt"), join(out, "nested/deep/OFL.txt")].sort(),
    );
    expect(readFileSync(join(out, "assets/OFL.txt"), "utf8")).toBe(ofl);
    expect(readFileSync(join(out, "nested/deep/OFL.txt"), "utf8")).toBe(ofl);
    expect(existsSync(join(out, "other/OFL.txt"))).toBe(false);
    expect(existsSync(join(out, "OFL.txt"))).toBe(false);
  });

  it("writes nothing for a build without the font", () => {
    const out = tree({ "index.html": "", "assets/app.js": "" });
    expect(copyFontLicence(out)).toEqual([]);
    expect(existsSync(join(out, "assets/OFL.txt"))).toBe(false);
  });

  it("is a Vite plugin that runs after the build has written its output", () => {
    const root = tree({
      "dist/assets/albert-sans-latin-wght-normal-1.woff2": "",
    });
    const plugin = fontLicence();
    expect(plugin.name).toBe("walkietalkey-font-licence");
    expect(plugin.apply).toBe("build");
    plugin.configResolved({ root, build: { outDir: "dist" } });
    plugin.closeBundle();
    expect(readFileSync(join(root, "dist/assets/OFL.txt"), "utf8")).toBe(ofl);
  });
});

describe("trademark notes (spec 14.8)", () => {
  it("removes README.md files from a build output and keeps everything else", () => {
    const out = tree({
      "README.md": NOTE,
      "icons/README.md": NOTE,
      "icons/icon-192.png": "png",
      "favicon.svg": "<svg/>",
      "notes.md": "kept",
    });
    expect(removeReadmes(out).sort()).toEqual(
      [join(out, "README.md"), join(out, "icons/README.md")].sort(),
    );
    expect(existsSync(join(out, "README.md"))).toBe(false);
    expect(existsSync(join(out, "icons/README.md"))).toBe(false);
    expect(existsSync(join(out, "icons/icon-192.png"))).toBe(true);
    expect(existsSync(join(out, "favicon.svg"))).toBe(true);
    expect(existsSync(join(out, "notes.md"))).toBe(true);
  });

  it.each(["App-ikoner", "Logo"])(
    "assets/%s carries the note in its README",
    (folder) => {
      expect(readFileSync(join(assets, folder, "README.md"), "utf8")).toContain(
        NOTE,
      );
    },
  );
});
