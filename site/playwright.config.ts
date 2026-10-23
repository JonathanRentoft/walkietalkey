import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.PORT || 4329);

/* Runs against the built site served like Cloudflare Pages (scripts/serve.ts), or against BASE_URL (e.g. the deploy). */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  reporter: [["list"]],
  use: {
    baseURL: process.env.BASE_URL || `http://localhost:${port}`,
    channel: "chrome",
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], channel: "chrome", viewport: { width: 1280, height: 900 } } },
    { name: "mobile", use: { ...devices["Pixel 7"], channel: "chrome" } },
  ],
  webServer: process.env.BASE_URL ? undefined : {
    command: `bun scripts/serve.ts ${port}`,
    url: `http://localhost:${port}/`,
    reuseExistingServer: true,
  },
});
