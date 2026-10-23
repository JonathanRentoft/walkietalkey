import { readFileSync } from "node:fs";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { pwa } from "./pwa";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string };

// Every URL in the build is relative (base "./"), so the same files run at any origin and path,
// including the iOS shell's custom URL scheme (PHONE-03).
export default defineConfig({
  base: "./",
  plugins: [react(), pwa()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  build: {
    target: ["es2022", "safari16"],
    sourcemap: false,
    assetsInlineLimit: 0,
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
  },
});
