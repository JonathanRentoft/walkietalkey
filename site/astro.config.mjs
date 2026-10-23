// @ts-check
import { fileURLToPath } from "node:url";
import react from "@astrojs/react";
import { copyFontLicence, removeReadmes } from "@walkietalkey/ui/build/assets";
import { defineConfig } from "astro/config";
import { SITE_URL } from "./src/lib/site.ts";

/* Static output for Cloudflare Pages (SITE-01). build.format "file" writes hent.html, which Pages serves at /hent
   with a 200 (a folder would answer /hent with a redirect to /hent/). */
export default defineConfig({
  site: SITE_URL,
  output: "static",
  trailingSlash: "never",
  compressHTML: true,
  build: { format: "file", inlineStylesheets: "never", assets: "_assets" },
  devToolbar: { enabled: false },
  integrations: [
    react(),
    {
      /* Spec 11: the Albert Sans licence next to the font in dist/_assets. Spec 14.8: the trademark README in
         public/ stays in the repository and is never deployed. */
      name: "walkietalkey-build-files",
      hooks: {
        "astro:build:done": ({ dir }) => {
          const out = fileURLToPath(dir);
          copyFontLicence(out);
          removeReadmes(out);
        },
      },
    },
  ],
  vite: {
    ssr: { noExternal: ["@walkietalkey/ui"] },
    build: { assetsInlineLimit: 0 },
  },
});
