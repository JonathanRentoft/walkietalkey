import { defineConfig } from "@playwright/test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/* End-to-end check of the recorder page (wt-train record, training/wt_train/recorder/). Three
   recorder servers run on 127.0.0.1, one for a phone condition, one for the Mac's and one for a
   pilot setup (wt-train pilot record), each with its own temporary sentence list, plan and
   recordings folder; nothing touches training/data/recordings/ or training/data/pilot/. The spec plays the WalkieTalkey app: the recorder writes the app's
   link with its token to a file (--app-url-file) instead of handing it to a running app, and the
   spec talks to the recorder's app API the way the desktop module does (e2e/fake-app.ts),
   uploading a Danish FLEURS clip as the take.

   From the repository root: bun run test:recorder */
const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// The config is loaded in every worker too; they inherit the runner's folder through the env.
process.env.WT_RECORDER_E2E ??= mkdtempSync(join(tmpdir(), "wt-recorder-e2e-"));
const work = process.env.WT_RECORDER_E2E;
mkdirSync(work, { recursive: true });

const SENTENCES = [
  ["s0001", "Vi merger PR'en, når buildet er grønt.", "terms", "phone-whisper"],
  ["s0002", "Det regner i Aarhus i dag.", "plain", "phone-whisper"],
  ["s0003", "Kan du deploye til staging?", "terms", "mac-normal"],
] as const;
const csv = join(work, "sentences.csv");
writeFileSync(
  csv,
  [
    "id,text,kind",
    ...SENTENCES.map(([id, text, kind]) => `${id},"${text}",${kind}`),
  ].join("\n") + "\n",
);
const plan = join(work, "plan.csv");
writeFileSync(
  plan,
  ["id,condition", ...SENTENCES.map(([id, , , c]) => `${id},${c}`)].join("\n") +
    "\n",
);
const exam = join(work, "exam.yaml");
writeFileSync(
  exam,
  "paragraphs:\n  - id: e01\n    title: Mandag\n    text: God morgen allesammen, vi starter standuppen nu.\n",
);

const PILOT = [
  ["pilot-01", "Buildet fejler på CI'en i dag.", "terms"],
  ["pilot-02", "Mødet med kunden er flyttet til torsdag.", "plain"],
] as const;
const pilotCsv = join(work, "pilot.csv");
writeFileSync(
  pilotCsv,
  [
    "id,text,kind",
    ...PILOT.map(([id, text, kind]) => `${id},"${text}",${kind}`),
  ].join("\n") + "\n",
);

const PORTS = { phone: 8791, mac: 8792, pilot: 8793 } as const;
const CONDITIONS = { phone: "phone-whisper", mac: "mac-normal" } as const;
// A Mac setup, whispered: the AirPods picked in the app.
const PILOT_SETUP = "airpods-whisper";

const server = (name: keyof typeof CONDITIONS) => ({
  command: [
    "uv run --project",
    JSON.stringify(join(repo, "training")),
    "wt-train record --no-browser --port",
    PORTS[name],
    "--condition",
    CONDITIONS[name],
    "--sentences",
    JSON.stringify(csv),
    "--plan",
    JSON.stringify(plan),
    "--exam-file",
    JSON.stringify(exam),
    "--recordings",
    JSON.stringify(join(work, `${name}-recordings`)),
    "--app-url-file",
    JSON.stringify(join(work, `${name}-app-url`)),
  ].join(" "),
  url: `http://127.0.0.1:${PORTS[name]}/`,
  reuseExistingServer: false,
  timeout: 300_000,
});

const pilotServer = {
  command: [
    "uv run --project",
    JSON.stringify(join(repo, "training")),
    "wt-train pilot record --no-browser --port",
    PORTS.pilot,
    "--setup",
    PILOT_SETUP,
    "--sentences",
    JSON.stringify(pilotCsv),
    "--pilot-dir",
    JSON.stringify(join(work, "pilot")),
    "--app-url-file",
    JSON.stringify(join(work, "pilot-app-url")),
  ].join(" "),
  url: `http://127.0.0.1:${PORTS.pilot}/`,
  reuseExistingServer: false,
  timeout: 300_000,
};

const project = (name: keyof typeof PORTS) => ({
  name,
  grep: new RegExp(`@${name}`),
  use: {
    browserName: "chromium" as const,
    baseURL: `http://127.0.0.1:${PORTS[name]}`,
  },
});

export default defineConfig({
  testDir: ".",
  // Værkstedet's spec has its own config (studio.config.ts, bun run test:studio).
  testIgnore: "studio.spec.ts",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  workers: 3,
  reporter: [["list"]],
  globalTeardown: "./teardown.ts",
  use: { trace: "retain-on-failure" },
  projects: [project("phone"), project("mac"), project("pilot")],
  webServer: [server("phone"), server("mac"), pilotServer],
});
