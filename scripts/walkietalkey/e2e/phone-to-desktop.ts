#!/usr/bin/env bun
/**
 * End-to-end: a scripted phone pairs with the desktop app's relay client
 * through a relay, streams a Danish WAV in real time, and the transcript
 * arrives on the desktop side (DESK-61, DESK-64, PHONE-30..32).
 *
 * The desktop side is the real app binary in headless `--phone-receive` mode
 * (same live decode and text steps as the app); the phone side is
 * packages/protocol/scripts/scripted-phone.ts. Needs a built app and an
 * installed model, so it runs on a developer machine, not in CI.
 *
 *   bun scripts/walkietalkey/e2e/phone-to-desktop.ts \
 *     --app src-tauri/target/debug/walkietalkey \
 *     --model walkietalkey/edda-v0.2-gguf/edda-v0.2-Q8_0.gguf \
 *     --relay wss://relay.walkietalkey.com \
 *     --wav clip.wav --reference clip.txt [--max-wer 0.25]
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(name);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  if (fallback !== undefined) return fallback;
  console.error(`missing ${name}`);
  process.exit(2);
}

/** Lower case, punctuation stripped, as the models/eval harness normalises. */
export function normalise(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/** Word error rate: word-level edit distance over the reference length. */
export function wer(reference: string, hypothesis: string): number {
  const r = normalise(reference);
  const h = normalise(hypothesis);
  const d: number[][] = Array.from({ length: r.length + 1 }, (_, i) => [
    i,
    ...Array(h.length).fill(0),
  ]);
  for (let j = 1; j <= h.length; j++) d[0][j] = j;
  for (let i = 1; i <= r.length; i++)
    for (let j = 1; j <= h.length; j++)
      d[i][j] = Math.min(
        d[i - 1][j] + 1,
        d[i][j - 1] + 1,
        d[i - 1][j - 1] + (r[i - 1] === h[j - 1] ? 0 : 1),
      );
  return r.length === 0 ? 0 : d[r.length][h.length] / r.length;
}

async function main() {
  const repo = join(import.meta.dir, "..", "..", "..");
  const appBin = arg(
    "--app",
    join(repo, "src-tauri/target/debug/walkietalkey"),
  );
  const model = arg(
    "--model",
    "walkietalkey/edda-v0.2-gguf/edda-v0.2-Q8_0.gguf",
  );
  const relay = arg(
    "--relay",
    "wss://relay.walkietalkey.com",
  );
  const phoneApp = arg("--phone-app", "https://app.walkietalkey.com");
  const wav = arg("--wav");
  const reference = readFileSync(arg("--reference"), "utf8").trim();
  const maxWer = Number(arg("--max-wer", "0.25"));

  const desktop = spawn(
    appBin,
    [
      "--phone-receive",
      "--model",
      model,
      "--relay-url",
      relay,
      "--phone-app-url",
      phoneApp,
      "--count",
      "1",
      "--timeout-secs",
      "240",
    ],
    {
      stdio: ["ignore", "pipe", "inherit"],
    },
  );
  let transcript:
    | { text: string; wait_after_end_ms: number; audio_secs: number }
    | undefined;
  let phoneDone: { ok: boolean; reason?: string } | undefined;
  const started = Date.now();

  const phoneFinished = new Promise<void>((resolve) => {
    createInterface({ input: desktop.stdout! }).on("line", (line) => {
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      console.log(`[desktop] ${event.event}`);
      if (event.event === "transcript") transcript = event as never;
      if (event.event === "pairing") {
        const phone = spawn(
          "bun",
          [
            join(repo, "packages/protocol/scripts/scripted-phone.ts"),
            "stream",
            "--url",
            String(event.url),
            "--wav",
            wav,
            "--name",
            "E2E-telefon",
          ],
          {
            stdio: ["ignore", "pipe", "inherit"],
          },
        );
        createInterface({ input: phone.stdout! }).on("line", (l) => {
          try {
            const e = JSON.parse(l);
            console.log(`[phone] ${e.event}`);
            if (e.event === "done") phoneDone = e;
          } catch {
            /* not JSON */
          }
        });
        phone.on("exit", () => resolve());
      }
    });
  });

  const desktopExit = new Promise<number>((resolve) =>
    desktop.on("exit", (code) => resolve(code ?? 1)),
  );
  await phoneFinished;
  const code = await desktopExit;

  const score = transcript ? wer(reference, transcript.text) : 1;
  const summary = {
    relay,
    desktop_exit: code,
    phone_result: phoneDone,
    transcript: transcript?.text,
    reference,
    wer: Number(score.toFixed(3)),
    audio_secs: transcript?.audio_secs,
    wait_after_end_ms: transcript?.wait_after_end_ms,
    total_ms: Date.now() - started,
  };
  console.log(JSON.stringify(summary, null, 2));
  const pass =
    code === 0 &&
    phoneDone?.ok === true &&
    transcript !== undefined &&
    score <= maxWer;
  console.log(pass ? "PASS" : "FAIL");
  process.exit(pass ? 0 : 1);
}

if (import.meta.main) await main();
