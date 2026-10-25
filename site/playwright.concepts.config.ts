import { defineConfig, devices } from "@playwright/test";
import { CONCEPTS, type Concept } from "./src/lib/build";

/* Run 6: the front page's three concepts in a browser, each built into .concepts/<name>/ (bun scripts/concepts.ts)
   and served like Cloudflare Pages on its own port. One project per concept and device; a spec reads its concept
   from the project's metadata (e2e-concepts/helpers.ts). */
const PORT = 4341;
export const conceptPort = (c: Concept) => PORT + CONCEPTS.indexOf(c);

const DEVICES = {
  desktop: {
    ...devices["Desktop Chrome"],
    channel: "chrome",
    viewport: { width: 1440, height: 900 },
  },
  mobile: { ...devices["Pixel 7"], channel: "chrome" },
};

export default defineConfig({
  testDir: "./e2e-concepts",
  fullyParallel: true,
  reporter: [["list"]],
  projects: CONCEPTS.flatMap((c) =>
    Object.entries(DEVICES).map(([device, use]) => ({
      name: `${c}-${device}`,
      metadata: { concept: c, device },
      use: { ...use, baseURL: `http://localhost:${conceptPort(c)}` },
    })),
  ),
  webServer: CONCEPTS.map((c) => ({
    command: `bun scripts/serve.ts ${conceptPort(c)} .concepts/${c}`,
    url: `http://localhost:${conceptPort(c)}/`,
    reuseExistingServer: true,
  })),
});
