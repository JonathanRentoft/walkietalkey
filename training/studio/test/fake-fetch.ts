/* fetch, answered by the fake studio (src/api/fixtures.ts) without its timers, with every call
   recorded so tests can check what the page sent. The long poll answers at once here. */
import { vi } from "vitest";
import { createFakeStudio, type FakeStudio } from "../src/api/fixtures";

export interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

export function fakeFetch(): {
  studio: FakeStudio;
  calls: Call[];
  posts: (path?: string) => Call[];
  restore: () => void;
} {
  const studio = createFakeStudio({ simulate: false });
  const calls: Call[] = [];
  const original = globalThis.fetch;
  const fn = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    const method = (init.method ?? "GET").toUpperCase();
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => (headers[k] = v));
    const body =
      typeof init.body === "string" && init.body ? JSON.parse(init.body) : null;
    calls.push({ method, url, headers, body });
    const out = await studio.handle(
      method,
      url.replace(/([?&])since=\d+&?/, "$1"),
      headers,
      body,
    );
    if (out.json !== undefined)
      return new Response(JSON.stringify(out.json), {
        status: out.status,
        headers: { "Content-Type": "application/json" },
      });
    return new Response(typeof out.body === "string" ? out.body : "", {
      status: out.status,
    });
  });
  globalThis.fetch = fn as unknown as typeof fetch;
  return {
    studio,
    calls,
    posts: (path?: string) =>
      calls.filter((c) => c.method === "POST" && (!path || c.url === path)),
    restore: () => {
      globalThis.fetch = original;
      studio.stop();
    },
  };
}
