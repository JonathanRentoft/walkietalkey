/* The build step in pwa.ts (PHONE-01): the pairing path `/p` on any static server (SITE-03, PRIV-03), the font
   licence (spec 11) and the trademark notes that stay out of the deployment (spec 14.8). */
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
  IOS_MANIFEST,
  IOS_MANIFEST_FILE,
  MANIFEST,
  nestedPairingPage,
  pwa,
} from "../pwa";

const INDEX = `<!doctype html>
<html lang="da">
  <head>
    <meta charset="utf-8" />
    <link rel="manifest" href="./manifest.webmanifest" />
    <link rel="icon" href="./favicon.svg" type="image/svg+xml" />
    <script type="module" crossorigin src="./assets/index-abc.js"></script>
    <link rel="stylesheet" crossorigin href="./assets/index-abc.css">
  </head>
  <body><div id="root"></div></body>
</html>
`;
const NOTE = "Ikke omfattet af kodelicensen. Se TRADEMARKS.md.";
const ofl = readFileSync(
  resolve(__dirname, "../../packages/ui/assets/fonts/OFL.txt"),
  "utf8",
);

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Runs the plugin's build step on a fake Vite output folder. */
function build(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "wt-phone-pwa-"));
  dirs.push(root);
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, "dist", path)), { recursive: true });
    writeFileSync(join(root, "dist", path), body);
  }
  const plugin = pwa() as unknown as {
    configResolved(c: unknown): void;
    closeBundle(): void;
  };
  plugin.configResolved({
    root,
    mode: "production",
    build: { outDir: "dist" },
  });
  plugin.closeBundle();
  return join(root, "dist");
}

function shell(out: string): string[] {
  const sw = readFileSync(join(out, "sw.js"), "utf8");
  return JSON.parse(sw.match(/const SHELL = (\[[\s\S]*?\]);/)![1]);
}

describe("the pairing page in a folder (SITE-03)", () => {
  it("adds one base element before the first URL, and changes nothing else", () => {
    const page = nestedPairingPage(INDEX);
    expect(page.match(/<base /g)).toHaveLength(1);
    expect(page).toContain('<base href="../" />');
    expect(page.indexOf("<base ")).toBeGreaterThan(
      page.indexOf("<meta charset"),
    );
    expect(page.indexOf("<base ")).toBeLessThan(page.indexOf("<link"));
    expect(page.replace(/\s*<base href="\.\.\/" \/>/, "")).toBe(INDEX);
  });

  it("falls back to the start of <head> when there is no charset meta", () => {
    const page = nestedPairingPage(
      '<html><head><link rel="manifest" href="./m"></head></html>',
    );
    expect(page).toBe(
      '<html><head><base href="../" /><link rel="manifest" href="./m"></head></html>',
    );
  });

  it.each([
    ["https://app.example.dk/p/", "https://app.example.dk/"],
    ["https://app.example.dk/p", "https://app.example.dk/"],
    ["https://intra.example.dk/diktat/p/", "https://intra.example.dk/diktat/"],
  ])(
    "served at %s, the app's relative URLs resolve to %s",
    (pageUrl, appRoot) => {
      const base = new URL("../", pageUrl);
      expect(new URL("./assets/index-abc.js", base).href).toBe(
        appRoot + "assets/index-abc.js",
      );
      expect(new URL("./sw.js", base).href).toBe(appRoot + "sw.js");
    },
  );
});

describe("the build step (PHONE-01)", () => {
  const files = {
    "index.html": INDEX,
    _headers: "/*\n  X-Frame-Options: DENY\n",
    "assets/index-abc.js": "console.log(1)",
    "assets/index-abc.css": "body{}",
    "assets/albert-sans-latin-wght-normal-Xy12.woff2": "font",
    "favicon.svg": "<svg/>",
    "README.md": NOTE,
    "icons/README.md": NOTE,
    "icons/icon-192.png": "png",
    ".well-known/apple-app-site-association": "{}",
  };

  it("serves /p from p.html (Cloudflare Pages) and from p/index.html (nginx, IIS)", () => {
    const out = build(files);
    expect(readFileSync(join(out, "p.html"), "utf8")).toBe(INDEX);
    expect(readFileSync(join(out, "p/index.html"), "utf8")).toBe(
      nestedPairingPage(INDEX),
    );
  });

  it("ships the font licence next to the font (spec 11)", () => {
    const out = build(files);
    expect(readFileSync(join(out, "assets/OFL.txt"), "utf8")).toBe(ofl);
  });

  it("never deploys the trademark READMEs of public/ (spec 14.8)", () => {
    const out = build(files);
    expect(existsSync(join(out, "README.md"))).toBe(false);
    expect(existsSync(join(out, "icons/README.md"))).toBe(false);
    expect(existsSync(join(out, "icons/icon-192.png"))).toBe(true);
    expect(existsSync(join(out, "favicon.svg"))).toBe(true);
  });

  it("caches the app shell, but not the HTML pages, the licence text or the READMEs", () => {
    const s = shell(build(files));
    expect(s).toEqual([
      "./",
      "./assets/albert-sans-latin-wght-normal-Xy12.woff2",
      "./assets/index-abc.css",
      "./assets/index-abc.js",
      "./favicon.svg",
      "./icons/icon-192.png",
    ]);
  });
});

describe("the manifest an iPhone adds to its home screen (Phase 5)", () => {
  it("is the same app without start_url, so the start URL is the page's own URL with the pairing link", () => {
    const { start_url, ...rest } = MANIFEST;
    expect(start_url).toBe("./");
    expect(IOS_MANIFEST).toEqual(rest);
    expect("start_url" in IOS_MANIFEST).toBe(false);
    expect(IOS_MANIFEST.id).toBe("./");
    expect(IOS_MANIFEST_FILE).toBe("manifest-ios.webmanifest");
  });

  it("_headers serves it as a manifest that is never cached", () => {
    const headers = readFileSync(
      join(resolve(__dirname, "../public"), "_headers"),
      "utf8",
    );
    expect(headers).toMatch(
      /^\/manifest-ios\.webmanifest\n {2}Content-Type: application\/manifest\+json\n {2}Cache-Control: no-cache$/m,
    );
  });
});

describe("public/ (spec 14.8, SITE-03)", () => {
  const pub = resolve(__dirname, "../public");
  it.each(["README.md", "icons/README.md"])(
    "public/%s carries the trademark note",
    (f) => {
      expect(readFileSync(join(pub, f), "utf8")).toContain(NOTE);
    },
  );
  it("_headers keeps both pairing paths out of the HTTP cache", () => {
    const headers = readFileSync(join(pub, "_headers"), "utf8");
    expect(headers).toMatch(/^\/p\n {2}Cache-Control: no-cache$/m);
    expect(headers).toMatch(/^\/p\/\n {2}Cache-Control: no-cache$/m);
  });
});
