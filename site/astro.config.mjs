// @ts-check
import react from "@astrojs/react";
import { defineConfig } from "astro/config";

/* Static output for Cloudflare Pages (SITE-01). build.format "file" writes hent.html, which Pages serves at /hent
   with a 200 (a folder would answer /hent with a redirect to /hent/). */
export default defineConfig({
  site: "https://walkietalkey.com",
  output: "static",
  trailingSlash: "never",
  compressHTML: true,
  build: { format: "file", inlineStylesheets: "never", assets: "_assets" },
  devToolbar: { enabled: false },
  integrations: [react()],
  vite: {
    ssr: { noExternal: ["@walkietalkey/ui"] },
    build: { assetsInlineLimit: 0 },
  },
});
