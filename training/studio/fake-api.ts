/* `vite --mode fake`: the studio's API (training/studio/API.md) answered by the fake studio in
   src/api/fixtures.ts, so every screen can be seen without the Python server. Dev only.
   `vite preview --mode fake` also sends the real server's CSP, to check the built page under it.
   WT_FAKE_STILL=1 stops the simulation (for screenshots that do not move). */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";
import { createFakeStudio, type FakeStudio } from "./src/api/fixtures.ts";

const PAGE_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; media-src 'self'; " +
  "img-src 'self' data:; font-src 'self'; frame-src 'self'; base-uri 'none'; form-action 'none'; " +
  "frame-ancestors 'none'";
const REPORT_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; " +
  "media-src data:; frame-ancestors 'self'";

const PREFIXES = ["/api/", "/reports/", "/files/"];

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > 64 * 1024) reject(new Error("too large"));
      else chunks.push(c);
    });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      if (!text) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        resolve({});
      }
    });
    req.on("error", reject);
  });
}

function middleware(studio: FakeStudio, csp: boolean) {
  return async (
    req: IncomingMessage,
    res: ServerResponse,
    next: () => void,
  ) => {
    const url = req.url ?? "/";
    const isApi = PREFIXES.some((p) => url.startsWith(p));
    if (!isApi) {
      if (csp) res.setHeader("Content-Security-Policy", PAGE_CSP);
      return next();
    }
    try {
      const body = req.method === "POST" ? await readBody(req) : null;
      const headers: Record<string, string | undefined> = {};
      for (const [k, v] of Object.entries(req.headers))
        headers[k] = Array.isArray(v) ? v[0] : v;
      const out = await studio.handle(req.method ?? "GET", url, headers, body);
      res.statusCode = out.status;
      res.setHeader("Cache-Control", "no-store");
      if (url.startsWith("/reports/"))
        res.setHeader("Content-Security-Policy", REPORT_CSP);
      if (out.json !== undefined) {
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(JSON.stringify(out.json));
      } else {
        res.setHeader("Content-Type", out.type ?? "application/octet-stream");
        res.end(
          typeof out.body === "string"
            ? out.body
            : Buffer.from(out.body ?? new Uint8Array()),
        );
      }
    } catch (e) {
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "fake", message: String(e) }));
    }
  };
}

export function fakeApi(): Plugin {
  let studio: FakeStudio | null = null;
  const get = () =>
    (studio ??= createFakeStudio({
      simulate: process.env.WT_FAKE_STILL !== "1",
    }));
  return {
    name: "walkietalkey-studio-fake-api",
    apply: () => true,
    configureServer(server) {
      server.middlewares.use(middleware(get(), false));
      server.httpServer?.on("close", () => studio?.stop());
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware(get(), true));
      server.httpServer?.on("close", () => studio?.stop());
    },
  };
}
