import { defineConfig, devices } from "@playwright/test";
import { CONCEPTS, pickConcept, type Concept } from "./src/lib/build";

/* Run 8: the front page's three final pages in a browser, each built into .concepts/<name>/ (bun scripts/concepts.ts)
   and served like Cloudflare Pages on its own port. One project per page and device (a 1440 px desktop and a 390 px
   phone); a spec reads its page from the project's metadata (e2e-concepts/helpers.ts). CONCEPT=<name> runs one page
   only, with its own server. */
const PORT = 4341;
const only = process.env.CONCEPT ? pickConcept(process.env.CONCEPT) : null;
const RUN = only ? [only] : CONCEPTS;
export const conceptPort = (c: Concept) => PORT + CONCEPTS.indexOf(c);

/* The final pages draw LightWaves and FluidMesh with WebGL. CI's runners have no GPU, and Chrome no longer falls back
   to software WebGL by itself; this flag lets it (SwiftShader), so the backgrounds draw there too. */
const WEBGL = { args: ["--enable-unsafe-swiftshader"] };

const DEVICES = {
  desktop: {
    ...devices["Desktop Chrome"],
    channel: "chrome",
    viewport: { width: 1440, height: 900 },
    launchOptions: WEBGL,
  },
  mobile: {
    ...devices["Pixel 7"],
    channel: "chrome",
    viewport: { width: 390, height: 844 },
    screen: { width: 390, height: 844 },
    launchOptions: WEBGL,
  },
};

export default defineConfig({
  testDir: "./e2e-concepts",
  fullyParallel: true,
  reporter: [["list"]],
  projects: RUN.flatMap((c) =>
    Object.entries(DEVICES).map(([device, use]) => ({
      name: `${c}-${device}`,
      metadata: { concept: c, device },
      use: { ...use, baseURL: `http://localhost:${conceptPort(c)}` },
    })),
  ),
  webServer: RUN.map((c) => ({
    command: `bun scripts/serve.ts ${conceptPort(c)} .concepts/${c}`,
    url: `http://localhost:${conceptPort(c)}/`,
    reuseExistingServer: true,
  })),
});
