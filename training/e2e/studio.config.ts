import { defineConfig } from "@playwright/test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  copyFileSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/* End-to-end check of Værkstedet (wt-train studio: training/wt_train/studio/ and the page in
   training/studio/). One studio server runs on 127.0.0.1:8796, outside the 8780 to 8799 range a
   real Værkstedet takes by default only in that it is given its port, with every path a
   temporary folder: sentences, plan and mix, exam, pilot, spelling, configs, recordings, pilot
   takes, journal, the learning notebooks and the work folder; run 12 adds a made-up dictation
   history, the owner's own words' folder, the test set's lock and its use log. Nothing touches
   training/data/, training/work/ or the app's own history, VS Code is never opened (WT_OPEN is a
   stand-in that logs its arguments) and nothing is measured (WT_STUDIO_EVAL is a stand-in too).

   The spec plays the WalkieTalkey app: the studio writes the app's link with its token to a
   file (--app-url-file) instead of handing it to a running app, and the spec talks to the app
   API as the desktop module does (e2e/fake-app.ts), uploading a Danish FLEURS clip as the take.
   Edda is the stand-in binary of training/tests/fake_app.py (--app-bin) with its batch
   interface: a take's transcript is its sentence (the take's .txt) upper-cased, so it matches.

   From the repository root: bun run test:studio (it builds the page first). */
const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const STUDIO_PORT = 8796;

// The config is loaded in every worker too; they inherit the runner's folder through the env.
process.env.WT_STUDIO_E2E ??= mkdtempSync(join(tmpdir(), "wt-studio-e2e-"));
const work = process.env.WT_STUDIO_E2E;
for (const d of [
  "recordings",
  "pilot",
  "journal",
  "configs",
  "work",
  "models",
  "notebooks",
])
  mkdirSync(join(work, d), { recursive: true });

const SENTENCES = [
  ["s0001", "Vi merger PR'en, når buildet er grønt.", "terms", "phone-whisper"],
  ["s0002", "Det regner i Aarhus i dag.", "plain", "phone-whisper"],
  ["s0003", "Kan du deploye til staging?", "terms", "phone-whisper"],
  ["s0004", "Hunden vil ikke ud, når det regner.", "plain", "mac-normal"],
  ["s0005", "Featuren er slået fra indtil videre.", "terms", "mac-normal"],
  ["s0006", "Vi grillede pølser i haven i går.", "plain", "phone-normal"],
] as const;
const csvLine = (cells: readonly string[]) =>
  cells
    .map((c) => (/[",]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c))
    .join(",");
writeFileSync(
  join(work, "sentences.csv"),
  [
    "id,text,kind",
    ...SENTENCES.map(([id, text, kind]) => csvLine([id, text, kind])),
  ].join("\n") + "\n",
);
writeFileSync(
  join(work, "plan.csv"),
  ["id,condition", ...SENTENCES.map(([id, , , c]) => `${id},${c}`)].join("\n") +
    "\n",
);
writeFileSync(
  join(work, "mix.yaml"),
  "mix:\n  phone-whisper: 50\n  phone-normal: 25\n  mac-normal: 25\n  mac-whisper: 0\n",
);
writeFileSync(
  join(work, "exam.yaml"),
  "paragraphs:\n  - id: e01\n    title: Mandag\n    text: God morgen allesammen, vi starter standuppen nu.\n",
);
writeFileSync(
  join(work, "pilot.csv"),
  'id,text,kind\npilot-01,"Buildet fejler på CI\'en i dag.",terms\npilot-02,Mødet med kunden er flyttet til torsdag.,plain\n',
);
copyFileSync(
  join(repo, "training/data/spelling.yaml"),
  join(work, "spelling.yaml"),
);
for (const f of readdirSync(join(repo, "training/configs")).filter((f) =>
  f.endsWith(".yaml"),
))
  copyFileSync(join(repo, "training/configs", f), join(work, "configs", f));

// A journal page for the Journal screen to edit (studio.spec.ts names it too).
const JOURNAL_PAGE = "2026-10-27-e2e-proeve";
writeFileSync(
  join(work, "journal", `${JOURNAL_PAGE}.md`),
  [
    "# Prøveside (2026-10-27)",
    "",
    "Kørsel `e2e-proeve`.",
    "",
    "## Hypothesis",
    "",
    "## What I changed",
    "",
    "Ingenting.",
    "",
    "## What happened",
    "",
    "| Datasæt | WER |",
    "|---|---|",
    "| test | 12 % |",
    "",
    "## What I learned",
    "",
  ].join("\n"),
);

// Run 11: two learning notebooks by their contract (training/tests/test_notebooks.py), for Lær det.
const notebook = (n: number, title: string, summary: string) => ({
  nbformat: 4,
  nbformat_minor: 5,
  metadata: {
    kernelspec: {
      name: "python3",
      display_name: "Python 3",
      language: "python",
    },
    wt: { number: n, summary, minutes: 3 },
  },
  cells: [
    { cell_type: "markdown", metadata: {}, source: [`# 0${n} · ${title}`] },
    {
      cell_type: "code",
      metadata: {},
      source: ["print('hej')"],
      outputs: [],
      execution_count: null,
    },
  ],
});
writeFileSync(
  join(work, "notebooks", "01-lyden.ipynb"),
  JSON.stringify(notebook(1, "Lyden", "Hør en optagelse, som Edda får den.")),
);
writeFileSync(
  join(work, "notebooks", "02-edda-indefra.ipynb"),
  JSON.stringify(notebook(2, "Edda indefra", "Følg en sætning gennem Edda.")),
);

// Run 12: a made-up dictation history (never the app's own), written by the training project's
// Python as history.rs lays it out; the owner's own words go to local/.
mkdirSync(join(work, "app"), { recursive: true });
mkdirSync(join(work, "work"), { recursive: true });
execFileSync(join(repo, "training/.venv/bin/python"), [
  "-c",
  `
import sqlite3, sys
con = sqlite3.connect(sys.argv[1])
con.executescript("""
CREATE TABLE IF NOT EXISTS transcription_history (id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_name TEXT NOT NULL, timestamp INTEGER NOT NULL, saved BOOLEAN NOT NULL DEFAULT 0,
  title TEXT NOT NULL, transcription_text TEXT NOT NULL, post_processed_text TEXT,
  post_process_prompt TEXT, post_process_requested BOOLEAN NOT NULL DEFAULT 0);
DELETE FROM transcription_history;
""")
rows = [("Grafana er nede igen, så vi kigger på Grafanaen i morgen.", None),
        ("vi skal deploye terraform", "Vi skal deploye med Terraform, før Grafana virker."),
        ("Kibanaen viser en load balancer fejl, og load balancer er nede.", None),
        ("Mødet er flyttet til torsdag.", None)]
for n, (raw, post) in enumerate(rows):
    con.execute("INSERT INTO transcription_history (file_name, timestamp, title, transcription_text,"
                " post_processed_text) VALUES (?, ?, ?, ?, ?)", (f"wt-{n}.wav", 1761600000 + n, f"#{n}", raw, post))
con.commit()
`,
  join(work, "app", "history.db"),
]);

// Run 12: the frozen test set's lock, one use of it from the terminal, and a stand-in for
// `wt-train eval` (WT_STUDIO_EVAL) that writes down its arguments and, for the test set, logs a
// use as the real one does (with the source the studio gave it).
// The lock as testset.make_lock writes it: its parameters, a clip per take with its audio's hash,
// and the sha256 of the rest as canonical JSON (sorted keys, no spaces), so read_lock accepts it.
const canonical = (v: unknown): string =>
  Array.isArray(v)
    ? `[${v.map(canonical).join(",")}]`
    : v !== null && typeof v === "object"
      ? `{${Object.keys(v)
          .sort()
          .map(
            (k) =>
              `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`,
          )
          .join(",")}}`
      : JSON.stringify(v);
const lock: Record<string, unknown> = {
  created: "2026-10-28T21:04:00+01:00",
  build: "first-frozen-encoder",
  params: {
    seed: 1,
    validation_fraction: 0.1,
    test_fraction: 0.1,
    held_out_terms: [],
  },
  sentences: ["s0002", "s0005", "s0006"],
  clips: [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => ({
    id: `c${n}`,
    audio_sha256: "cd".repeat(32),
  })),
};
lock.sha256 = createHash("sha256").update(canonical(lock)).digest("hex");
writeFileSync(join(work, "test-lock.json"), JSON.stringify(lock));
writeFileSync(
  join(work, "work", "test-uses.jsonl"),
  JSON.stringify({
    at: "2026-10-27T12:42:10+01:00",
    runs: ["first-frozen-encoder-20261026-2112"],
    backend: "lora",
    build: null,
    eval_run: "lora-test-split-2026-10-27",
    source: "cli",
  }) + "\n",
);
const fakeEval = join(work, "fake-eval");
writeFileSync(
  fakeEval,
  [
    "#!/bin/sh",
    `log=${JSON.stringify(join(work, "eval.log"))}`,
    'printf \'%s\\n\' "source=$WT_TEST_USE_SOURCE" "$@" "---" >> "$log"',
    'case " $* " in *" --dataset test "*)',
    '  printf \'{"at": "2026-10-28T23:30:00+01:00", "runs": ["e2e-tiny-20261028-120000"], "backend": "lora", "build": null, "eval_run": "e2e-eval", "source": "%s"}\\n\' "$WT_TEST_USE_SOURCE" >> "$WT_WORK_DIR/test-uses.jsonl";;',
    "esac",
    "echo 'eval: done'",
    "",
  ].join("\n"),
);
chmodSync(fakeEval, 0o755);

// VS Code is never opened: a stand-in for `open` writes its arguments to open.log, one a line.
const fakeOpen = join(work, "fake-open");
writeFileSync(
  fakeOpen,
  `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(join(work, "open.log"))}\nexit 0\n`,
);
chmodSync(fakeOpen, 0o755);

// The stand-in for the walkietalkey binary, run by the training project's Python.
const script = readFileSync(
  join(repo, "training/tests/fake_app.py"),
  "utf8",
).match(/SCRIPT = r'''([\s\S]*?)'''/)?.[1];
if (!script) throw new Error("no SCRIPT in training/tests/fake_app.py");
const fakeApp = join(work, "fake-app");
writeFileSync(
  fakeApp,
  `#!${join(repo, "training/.venv/bin/python")}\n${script}`,
);
chmodSync(fakeApp, 0o755);

const flag = (name: string, value: string) =>
  `--${name} ${JSON.stringify(value)}`;
const server = {
  command: [
    `bun run --cwd ${JSON.stringify(join(repo, "training/studio"))} build &&`,
    `uv run --project ${JSON.stringify(join(repo, "training"))}`,
    `wt-train studio --no-browser --no-build --port ${STUDIO_PORT}`,
    flag("recordings", join(work, "recordings")),
    flag("pilot-dir", join(work, "pilot")),
    flag("sentences", join(work, "sentences.csv")),
    flag("plan", join(work, "plan.csv")),
    flag("exam-file", join(work, "exam.yaml")),
    flag("pilot-sentences", join(work, "pilot.csv")),
    flag("spelling", join(work, "spelling.yaml")),
    flag("configs", join(work, "configs")),
    flag("journal", join(work, "journal")),
    flag("notebooks", join(work, "notebooks")),
    flag("dist", join(repo, "training/studio/dist")),
    flag("app-bin", fakeApp),
    flag("app-url-file", join(work, "app-url")),
    flag("history-db", join(work, "app", "history.db")),
    flag("test-lock", join(work, "test-lock.json")),
  ].join(" "),
  url: `http://127.0.0.1:${STUDIO_PORT}/api/ping`,
  reuseExistingServer: false,
  timeout: 300_000,
  env: {
    WT_WORK_DIR: join(work, "work"),
    WT_APP_MODELS_DIR: join(work, "models"),
    WT_TRACKING: "0",
    WT_CAFFEINATE: "0",
    WT_OPEN: fakeOpen,
    WT_CODE: "",
    WT_APP_HISTORY_DB: join(work, "app", "history.db"),
    WT_LOCAL_DIR: join(work, "local"),
    WT_STUDIO_EVAL: fakeEval,
    FAKE_APP_BATCH: "1",
    FAKE_APP_LOG: join(work, "fake-app.log"),
    FAKE_APP_MODELS: "walkietalkey/edda-v0.2-gguf/edda-v0.2-Q8_0.gguf",
  },
};

export default defineConfig({
  testDir: ".",
  testMatch: "studio.spec.ts",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  workers: 1,
  reporter: [["list"]],
  globalTeardown: "./studio-teardown.ts",
  use: {
    browserName: "chromium",
    baseURL: `http://127.0.0.1:${STUDIO_PORT}`,
    viewport: { width: 1280, height: 900 },
    trace: "retain-on-failure",
  },
  webServer: [server],
});
