/* Serves a build the way Cloudflare Pages does: /p answers p.html, /x.html redirects to /x,
   unknown paths get index.html (single-page app, no 404.html), and _headers is applied.
   Usage: bun scripts/serve.ts [dir=dist] [port=4173] */
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, resolve } from "node:path";

const dist = resolve(import.meta.dir, "..", process.argv[2] || "dist");
const port = Number(process.argv[3] || process.env.PORT || 4173);

const rules: { re: RegExp; headers: [string, string][] }[] = [];
if (existsSync(join(dist, "_headers"))) {
  let cur: (typeof rules)[number] | null = null;
  for (const line of readFileSync(join(dist, "_headers"), "utf8").split("\n")) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    if (!/^\s/.test(line)) {
      cur = { re: new RegExp("^" + line.trim().replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$"), headers: [] };
      rules.push(cur);
    } else if (cur) {
      const i = line.indexOf(":");
      cur.headers.push([line.slice(0, i).trim(), line.slice(i + 1).trim()]);
    }
  }
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
};

function file(path: string): string | null {
  const p = join(dist, decodeURIComponent(path));
  if (!p.startsWith(dist)) return null;
  if (existsSync(p) && statSync(p).isFile()) return p;
  if (existsSync(p + ".html")) return p + ".html";
  if (existsSync(join(p, "index.html"))) return join(p, "index.html");
  return null;
}

const server = Bun.serve({
  port,
  hostname: "127.0.0.1",
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname.endsWith(".html")) return Response.redirect(url.origin + (url.pathname.replace(/(index)?\.html$/, "") || "/"), 308);
    const f = file(url.pathname) ?? join(dist, "index.html");
    const headers = new Headers({ "content-type": TYPES[extname(f)] || "application/octet-stream" });
    for (const r of rules) if (r.re.test(url.pathname)) for (const [k, v] of r.headers) headers.set(k, v);
    return new Response(Bun.file(f), { headers });
  },
});
console.log(`serving ${dist} on http://127.0.0.1:${server.port}`);
