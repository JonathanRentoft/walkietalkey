import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { fakeApi } from "./fake-api.ts";

// Værkstedet is served by `wt-train studio` at the root of 127.0.0.1:<port> (training/studio/API.md).
// `--mode fake` serves the API from src/api/fixtures.ts instead, so every screen can be seen
// without the Python server; otherwise the dev server forwards the API to a running studio.
const STUDIO = process.env.WT_STUDIO_URL ?? "http://127.0.0.1:8780";

export default defineConfig(({ mode }) => ({
  base: "/",
  plugins: [react(), ...(mode === "fake" ? [fakeApi()] : [])],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2022",
    sourcemap: false,
    // The page's CSP allows fonts and images from 'self' only, so nothing is inlined as data:.
    assetsInlineLimit: 0,
  },
  server: {
    host: "127.0.0.1",
    port: 5190,
    proxy:
      mode === "fake"
        ? undefined
        : Object.fromEntries(
            ["/api", "/reports", "/files"].map((prefix) => [
              prefix,
              {
                target: STUDIO,
                changeOrigin: true,
                // The studio refuses a POST whose Origin is not its own; the dev page has another.
                configure: (proxy: {
                  on: (
                    event: "proxyReq",
                    cb: (req: { removeHeader: (name: string) => void }) => void,
                  ) => void;
                }) => proxy.on("proxyReq", (req) => req.removeHeader("origin")),
              },
            ]),
          ),
  },
  preview: { host: "127.0.0.1", port: 5191 },
}));
