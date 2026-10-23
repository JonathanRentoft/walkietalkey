/**
 * Build-time PWA pieces (PHONE-01): the web app manifest, a service worker that caches the app
 * shell (never audio: the app never fetches audio, and the worker caches only the files listed
 * here), `p.html` for the pairing path `/p`, and Cloudflare Pages headers.
 */
import { createHash } from "node:crypto";
import { copyFileSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { Plugin, ResolvedConfig } from "vite";

export const MANIFEST = {
  name: "WalkieTalkey",
  short_name: "WalkieTalkey",
  // TODO(copy): manifest description
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
    { src: "icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
    { src: "icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
    { src: "icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
  ],
};

function headers(e2e: boolean): string {
  // connect-src: any wss:// relay (RelayUrl is a managed setting, RELAY-14); ws:// to localhost
  // only in the e2e build (SEC-06).
  const connect = e2e ? "'self' wss: ws://127.0.0.1:* ws://localhost:*" : "'self' wss:";
  const csp = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' blob: mediastream:",
    `connect-src ${connect}`,
    "worker-src 'self'",
    "manifest-src 'self'",
    "font-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'none'",
  ].join("; ");
  return `/*
  Content-Security-Policy: ${csp}
  Permissions-Policy: microphone=(self), camera=(self), screen-wake-lock=(self), geolocation=(), payment=(), usb=()
  Referrer-Policy: no-referrer
  X-Content-Type-Options: nosniff
  X-Frame-Options: DENY
  Cross-Origin-Opener-Policy: same-origin
/sw.js
  Cache-Control: no-cache
/manifest.webmanifest
  Content-Type: application/manifest+json
  Cache-Control: no-cache
/index.html
  Cache-Control: no-cache
/p
  Cache-Control: no-cache
/
  Cache-Control: no-cache
/assets/*
  Cache-Control: public, max-age=31536000, immutable
`;
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
      this.emitFile({ type: "asset", fileName: "manifest.webmanifest", source: JSON.stringify(MANIFEST, null, 2) });
      this.emitFile({ type: "asset", fileName: "_headers", source: headers(config.mode === "e2e") });
    },
    closeBundle() {
      const out = config.build.outDir.startsWith("/") ? config.build.outDir : join(config.root, config.build.outDir);
      // `/p#<payload>` (spec 5.3) is the same app: Cloudflare Pages serves p.html at /p.
      copyFileSync(join(out, "index.html"), join(out, "p.html"));
      const files = walk(out)
        .map((f) => relative(out, f).split(sep).join("/"))
        .filter((f) => !["sw.js", "_headers", "_redirects", "p.html", "index.html"].includes(f) && !f.endsWith(".map"))
        .sort();
      const shell = ["./", ...files.map((f) => `./${f}`)];
      const hash = createHash("sha256");
      for (const f of ["index.html", ...files]) hash.update(f).update(readFileSync(join(out, f)));
      writeFileSync(join(out, "sw.js"), swSource(hash.digest("hex").slice(0, 12), shell));
    },
  };
}
