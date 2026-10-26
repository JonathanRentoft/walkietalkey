/* Serves dist/ the way Cloudflare Pages does: /hent answers hent.html, /x.html redirects to /x, unknown paths get
   404.html, the headers from _headers are applied, and text is sent compressed to a client that accepts it (run 8:
   so a local Lighthouse run weighs the page as Pages delivers it). Usage: bun scripts/serve.ts [port] [folder] */
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, resolve } from "node:path";

const dist = process.argv[3]
  ? resolve(process.argv[3])
  : resolve(import.meta.dir, "../dist");
const port = Number(process.argv[2] || process.env.PORT || 4329);

/* _headers: blocks of "path pattern" followed by indented "Name: value" lines */
const rules: { re: RegExp; headers: [string, string][] }[] = [];
if (existsSync(join(dist, "_headers"))) {
  let cur: (typeof rules)[number] | null = null;
  for (const line of readFileSync(join(dist, "_headers"), "utf8").split("\n")) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    if (!/^\s/.test(line)) {
      cur = {
        re: new RegExp(
          "^" +
            line
              .trim()
              .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
              .replace(/\*/g, ".*") +
            "$",
        ),
        headers: [],
      };
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
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".woff2": "font/woff2",
  ".txt": "text/plain",
  ".xml": "application/xml",
  ".webmanifest": "application/manifest+json",
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
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname.endsWith(".html"))
      return Response.redirect(
        url.origin + (url.pathname.replace(/(index)?\.html$/, "") || "/"),
        308,
      );
    let f = file(url.pathname),
      status = 200;
    if (!f) {
      f = join(dist, "404.html");
      status = 404;
    }
    const headers = new Headers({
      "content-type": TYPES[extname(f)] || "application/octet-stream",
    });
    for (const r of rules)
      if (r.re.test(url.pathname))
        for (const [k, v] of r.headers) headers.set(k, v);
    const type = headers.get("content-type") || "";
    if (
      /gzip/.test(req.headers.get("accept-encoding") || "") &&
      /^(text\/|application\/(json|xml|manifest)|image\/svg)/.test(type)
    ) {
      headers.set("content-encoding", "gzip");
      headers.set("vary", "accept-encoding");
      return new Response(Bun.gzipSync(readFileSync(f)), { status, headers });
    }
    return new Response(Bun.file(f), { status, headers });
  },
});
console.log(`serving ${dist} on http://localhost:${server.port}`);
