import { defineConfig } from "@playwright/test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/* End-to-end check of the recorder page (wt-train record, training/wt_train/recorder/).
   Chromium's fake microphone plays a Danish FLEURS clip (project "speech") or digital silence
   (project "silence", a dead input); the page records takes and the specs check the WAV files
   the local server saved. Two recorder servers run on 127.0.0.1, each with its own temporary
   sentence list and recordings folder; nothing touches training/data/recordings/.

   From the repository root: bun run test:recorder */
const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../..");
const speechWav = join(repo, "models/clips/da-fleurs-10s.wav");

// The config is loaded in every worker too; they inherit the runner's folder through the env.
process.env.WT_RECORDER_E2E ??= mkdtempSync(join(tmpdir(), "wt-recorder-e2e-"));
const work = process.env.WT_RECORDER_E2E;
mkdirSync(work, { recursive: true });

const SENTENCES = [
  ["s0001", "Vi merger PR'en, når buildet er grønt.", "terms"],
  ["s0002", "Det regner i Aarhus i dag.", "plain"],
  ["s0003", "Kan du deploye til staging?", "terms"],
] as const;
const csv = join(work, "sentences.csv");
writeFileSync(
  csv,
  [
    "id,text,kind",
    ...SENTENCES.map(([id, text, kind]) => `${id},"${text}",${kind}`),
  ].join("\n") + "\n",
);

/** Five seconds of digital silence, 16 kHz 16-bit mono: an interface with nothing plugged in. */
function silentWav(path: string): string {
  const samples = 16000 * 5;
  const out = Buffer.alloc(44 + samples * 2);
  out.write("RIFF", 0, "ascii");
  out.writeUInt32LE(36 + samples * 2, 4);
  out.write("WAVEfmt ", 8, "ascii");
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(1, 22);
  out.writeUInt32LE(16000, 24);
  out.writeUInt32LE(32000, 28);
  out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34);
  out.write("data", 36, "ascii");
  out.writeUInt32LE(samples * 2, 40);
  writeFileSync(path, out);
  return path;
}

const PORTS = { speech: 8791, silence: 8792 };
const MIC = {
  speech: speechWav,
  silence: silentWav(join(work, "silence.wav")),
};

const server = (name: keyof typeof PORTS) => ({
  command: [
    "uv run --project",
    JSON.stringify(join(repo, "training")),
    "wt-train record --no-browser --port",
    PORTS[name],
    "--sentences",
    JSON.stringify(csv),
    "--recordings",
    JSON.stringify(join(work, name)),
  ].join(" "),
  url: `http://127.0.0.1:${PORTS[name]}/`,
  reuseExistingServer: false,
  timeout: 300_000,
});

const project = (name: keyof typeof PORTS) => ({
  name,
  grep: new RegExp(`@${name}`),
  use: {
    browserName: "chromium" as const,
    baseURL: `http://127.0.0.1:${PORTS[name]}`,
    permissions: ["microphone"],
    launchOptions: {
      args: [
        "--use-fake-ui-for-media-stream",
        "--use-fake-device-for-media-stream",
        `--use-file-for-fake-audio-capture=${MIC[name]}`,
        "--autoplay-policy=no-user-gesture-required",
      ],
    },
  },
});

export default defineConfig({
  testDir: ".",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  workers: 2,
  reporter: [["list"]],
  globalTeardown: "./teardown.ts",
  use: { trace: "retain-on-failure" },
  projects: [project("speech"), project("silence")],
  webServer: [server("speech"), server("silence")],
});
