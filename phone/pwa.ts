/**
 * Build-time PWA pieces (PHONE-01): the web app manifest, a service worker that caches the app
 * shell (never audio: the app never fetches audio, and the worker caches only the files listed
 * here), `p.html` and `p/index.html` for the pairing path `/p`, the font licence (spec 11), and
 * the e2e variant of public/_headers.
 */
import { createHash } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, relative, sep } from "node:path";
import {
  FONT_LICENCE_FILE,
  copyFontLicence,
  removeReadmes,
} from "@walkietalkey/ui/build/assets";
import type { Plugin, ResolvedConfig } from "vite";
import { IOS_MANIFEST_FILE } from "./src/lib/platform";

export const MANIFEST = {
  name: "WalkieTalkey",
  short_name: "WalkieTalkey",
  // Manifest description
  description: "Tal ind i telefonen. Teksten lander på din computer.",
  lang: "da",
  dir: "ltr",
  id: "./",
  start_url: "./",
  scope: "./",
  display: "standalone",
  orientation: "portrait",
  background_color: "#faf8f4",
  theme_color: "#faf8f4",
  categories: ["productivity", "utilities"],
  icons: [
    {
      src: "icons/icon-192.png",
      sizes: "192x192",
      type: "image/png",
      purpose: "any",
    },
    {
      src: "icons/icon-512.png",
      sizes: "512x512",
      type: "image/png",
      purpose: "any",
    },
    {
      src: "icons/icon-512.png",
      sizes: "512x512",
      type: "image/png",
      purpose: "maskable",
    },
  ],
};

/**
 * Run 2, Phase 5: what an iPhone's Safari tab links to. The same app without `start_url`, so the
 * start URL of the home-screen app is the URL of the page it was added from (W3C manifest:
 * a missing start_url is the document's URL). Opened from a pairing link, that page keeps the
 * link in its address bar, so the home-screen app pairs on its first launch without a second
 * scan. Either way iOS picks the start URL (the manifest's or the page's), it gets the link.
 */
export { IOS_MANIFEST_FILE };
export const IOS_MANIFEST = (() => {
  const { start_url: _start, ...rest } = MANIFEST;
  return rest;
})();

/**
 * public/_headers is the production policy: connect-src allows any wss:// relay (RelayUrl is a
 * managed setting, RELAY-14). The e2e build also allows ws:// to localhost (SEC-06).
 */
function e2eHeaders(text: string): string {
  return text.replace(
    "connect-src 'self' wss:",
    "connect-src 'self' wss: ws://127.0.0.1:* ws://localhost:*",
  );
}

/** Never cached by the service worker. */
const NOT_SHELL = [
  "sw.js",
  "_headers",
  "_redirects",
  "p.html",
  "p/index.html",
  "index.html",
];

/**
 * The app page for `p/index.html`. Servers such as nginx and IIS answer `/p` by redirecting to
 * `/p/` (browsers keep the `#` fragment) and serving `p/index.html`, so the page's relative URLs
 * would point into `p/`. `<base href="../">` points them back at the app root, wherever the app
 * lives (PhoneAppUrl may include a folder). Served at `/p` itself, `../` is the root as well.
 */
export function nestedPairingPage(html: string): string {
  const base = '<base href="../" />';
  const charset = html.match(/<meta charset[^>]*>/i);
  if (charset) return html.replace(charset[0], charset[0] + base);
  return html.replace(/<head[^>]*>/i, (head) => head + base);
}

function swSource(version: string, shell: string[]): string {
  return `/* WalkieTalkey service worker (PHONE-01): caches the app shell so the app opens without a
   network. Only the files below are ever cached; audio never passes through here (PHONE-33). */
const VERSION = ${JSON.stringify(version)};
const CACHE = "walkietalkey-shell-" + VERSION;
const SHELL = ${JSON.stringify(shell, null, 2)};

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("walkietalkey-shell-") && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

const scope = new URL(self.registration.scope);
const shellUrls = new Set(SHELL.map((p) => new URL(p, scope).href));

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== scope.origin || !url.href.startsWith(scope.href)) return;
  if (req.mode === "navigate") {
    // Network first, so updates arrive; the cached shell when offline. The fragment of a
    // pairing link never reaches here (browsers do not send it).
    event.respondWith(
      fetch(req).catch(() => caches.match(new URL("./", scope).href, { cacheName: CACHE }).then((r) => r || Response.error())),
    );
    return;
  }
  url.hash = "";
  if (!shellUrls.has(url.href)) return;
  event.respondWith(caches.match(url.href, { cacheName: CACHE }).then((r) => r || fetch(req)));
});
`;
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

export function pwa(): Plugin {
  let config: ResolvedConfig;
  return {
    name: "walkietalkey-pwa",
    apply: "build",
    configResolved(c) {
      config = c;
    },
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "manifest.webmanifest",
        source: JSON.stringify(MANIFEST, null, 2),
      });
      this.emitFile({
        type: "asset",
        fileName: IOS_MANIFEST_FILE,
        source: JSON.stringify(IOS_MANIFEST, null, 2),
      });
    },
    closeBundle() {
      const out = config.build.outDir.startsWith("/")
        ? config.build.outDir
        : join(config.root, config.build.outDir);
      // `/p#<payload>` (spec 5.3) is the same app: Cloudflare Pages serves p.html at /p, and a
      // plain static server (nginx, IIS) serves p/index.html at /p/ (SITE-03, PRIV-03).
      copyFileSync(join(out, "index.html"), join(out, "p.html"));
      mkdirSync(join(out, "p"), { recursive: true });
      writeFileSync(
        join(out, "p", "index.html"),
        nestedPairingPage(readFileSync(join(out, "index.html"), "utf8")),
      );
      // Spec 11: the Albert Sans licence next to the font. Spec 14.8: the trademark READMEs of
      // public/ stay in the repository.
      copyFontLicence(out);
      removeReadmes(out);
      if (config.mode === "e2e")
        writeFileSync(
          join(out, "_headers"),
          e2eHeaders(readFileSync(join(out, "_headers"), "utf8")),
        );
      const files = walk(out)
        .map((f) => relative(out, f).split(sep).join("/"))
        .filter(
          (f) =>
            !NOT_SHELL.includes(f) &&
            !f.startsWith(".well-known/") &&
            f.split("/").pop() !== FONT_LICENCE_FILE &&
            !f.endsWith(".map"),
        )
        .sort();
      const shell = ["./", ...files.map((f) => `./${f}`)];
      const hash = createHash("sha256");
      for (const f of ["index.html", ...files])
        hash.update(f).update(readFileSync(join(out, f)));
      writeFileSync(
        join(out, "sw.js"),
        swSource(hash.digest("hex").slice(0, 12), shell),
      );
    },
  };
}
