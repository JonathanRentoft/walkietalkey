import { defineConfig, devices } from "@playwright/test";
import { ensureTestWav } from "./e2e/audio";

/* PHONE tests of spec 15.1 against a local relay (`wrangler dev --env integration`, high per-IP
   limits) and the e2e build (ws:// to localhost allowed, SEC-06), served like Cloudflare Pages.
   Chromium uses the installed Chrome with a fake microphone that plays a 16 kHz WAV; WebKit gets
   an init script instead (e2e/fake-media.ts). */
const APP_PORT = Number(process.env.E2E_APP_PORT || 4173);
const RELAY_PORT = Number(process.env.E2E_RELAY_PORT || 8787);
const wav = ensureTestWav();

export default defineConfig({
  testDir: "./e2e",
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: true,
  workers: Number(process.env.E2E_WORKERS || 3),
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${APP_PORT}`,
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Pixel 7"],
        browserName: "chromium",
        channel: "chrome",
        permissions: ["microphone", "camera"],
        launchOptions: {
          args: [
            "--use-fake-ui-for-media-stream",
            "--use-fake-device-for-media-stream",
            `--use-file-for-fake-audio-capture=${wav}`,
            "--autoplay-policy=no-user-gesture-required",
          ],
        },
      },
    },
    {
      name: "webkit",
      use: { ...devices["iPhone 15"], browserName: "webkit" },
    },
  ],
  webServer: [
    {
      command: `bun run build:e2e && bun scripts/serve.ts dist-e2e ${APP_PORT}`,
      url: `http://127.0.0.1:${APP_PORT}/`,
      reuseExistingServer: !!process.env.E2E_REUSE,
      timeout: 120_000,
    },
    {
      command: `bunx wrangler dev --env integration --ip 127.0.0.1 --port ${RELAY_PORT} --persist-to ../phone/e2e/.tmp/wrangler --show-interactive-dev-session=false`,
      cwd: "../relay",
      url: `http://127.0.0.1:${RELAY_PORT}/v1/health`,
      reuseExistingServer: true,
      timeout: 120_000,
      env: { WRANGLER_SEND_METRICS: "false" },
    },
  ],
});
