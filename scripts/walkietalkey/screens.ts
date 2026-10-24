// Captures every desktop screen and state (onboarding, every settings
// section, history, pairing, dialogs, the pill) against the mocked Tauri
// backend of the Playwright tests (tests/walkietalkey/mock.ts), in light and
// dark, at 1x and 2x. Window sizes come from the Rust sources, so the shots
// match the real windows.
//
//   bun scripts/walkietalkey/screens.ts --out <dir> [--only <text>] [--scales 1,2]
//
// Files: <out>/<screen>-<state>-<theme>@<scale>x.png. A Vite dev server is
// started on WT_SCREENS_PORT (default 1437) unless one already answers there.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium, type Browser, type Page } from "@playwright/test";
import {
  EDDA,
  emit,
  installMock,
  type MockOptions,
} from "../../tests/walkietalkey/mock";
import { onboardingSteps } from "../../src/walkietalkey/lib/helpers";

const root = resolve(import.meta.dir, "../..");
const args = process.argv.slice(2);
const arg = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const out = resolve(arg("--out") ?? join(root, ".screens"));
const only = arg("--only");
const scales = (arg("--scales") ?? "1,2").split(",").map(Number);
const port = Number(process.env.WT_SCREENS_PORT ?? 1437);
const base = `http://localhost:${port}`;

/** A size from the Rust sources, or the fallback. */
function rustSize(
  file: string,
  pattern: RegExp,
  fallback: [number, number],
): [number, number] {
  try {
    const m = readFileSync(join(root, file), "utf8").match(pattern);
    if (m) return [Math.round(Number(m[1])), Math.round(Number(m[2]))];
  } catch {
    /* fall back */
  }
  return fallback;
}
const MAIN = rustSize(
  "src-tauri/src/lib.rs",
  /\.inner_size\(([\d.]+),\s*([\d.]+)\)/,
  [1040, 720],
);
const PILL = rustSize(
  "src-tauri/src/overlay.rs",
  /const OVERLAY_WIDTH: f64 = ([\d.]+);\s*const OVERLAY_HEIGHT: f64 = ([\d.]+);/,
  [320, 64],
);

/* ---------------------------------------------------------------- Data */

const T0 = Math.floor(new Date("2026-10-24T09:41:00+02:00").getTime() / 1000);
const HISTORY = [
  {
    id: 4,
    timestamp: T0 - 90,
    source: "Jonathans iPhone",
    text: "Husk at købe mælk og havregryn på vej hjem, og ring til mor om søndagen.",
    cleaned: false,
    cleanup: null,
    has_audio: false,
  },
  {
    id: 3,
    timestamp: T0 - 1800,
    source: "tast",
    text: "Vi deployer til staging i eftermiddag, og så laver jeg en pull request, når testene er grønne.",
    cleaned: true,
    cleanup: {
      provider: "OpenAI",
      sent_text:
        "Vi deployer til staging i eftermiddag, øh, og så laver jeg en pull request når testene er grønne.",
      duration_ms: 640,
    },
    has_audio: false,
  },
  {
    id: 2,
    timestamp: T0 - 7200,
    source: "tast",
    text: "Mødet er flyttet til torsdag klokken ti.",
    cleaned: false,
    cleanup: null,
    has_audio: false,
  },
  {
    id: 1,
    timestamp: T0 - 90000,
    source: "tast",
    text: "Hej, det her er min første diktering.",
    cleaned: false,
    cleanup: null,
    has_audio: false,
  },
];

const PHONES = {
  enabled: true,
  connected: true,
  pairing_active: false,
  phones: [
    {
      id: "p1",
      name: "Jonathans iPhone",
      platform: "ios",
      online: true,
      last_seen_day: null,
    },
    {
      id: "p2",
      name: "Arbejdstelefon",
      platform: "android",
      online: false,
      last_seen_day: Math.floor((T0 - 86400 * 3) / 86400),
    },
  ],
};

/** A QR-like code (finder patterns and seeded modules) for the pairing shots. */
function fakeQr(): string {
  const n = 29;
  let seed = 7;
  const rand = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  const cells: boolean[][] = Array.from({ length: n }, () =>
    Array.from({ length: n }, () => rand() > 0.52),
  );
  const finder = (x: number, y: number) => {
    for (let i = -1; i <= 7; i++)
      for (let j = -1; j <= 7; j++) {
        const cx = x + i;
        const cy = y + j;
        if (cx < 0 || cy < 0 || cx >= n || cy >= n) continue;
        const ring = Math.max(Math.abs(i - 3), Math.abs(j - 3));
        cells[cy][cx] = ring !== 2 && ring !== 4;
      }
  };
  finder(0, 0);
  finder(n - 7, 0);
  finder(0, n - 7);
  let rects = "";
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++)
      if (cells[y][x])
        rects += `<rect x="${x}" y="${y}" width="1" height="1"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-2 -2 ${n + 4} ${n + 4}" shape-rendering="crispEdges"><rect x="-2" y="-2" width="${n + 4}" height="${n + 4}" fill="#fff"/><g fill="#1b1a19">${rects}</g></svg>`;
}

const installed: MockOptions = {
  downloaded: [EDDA],
  app: {
    selected_model: EDDA,
    onboarding_completed: true,
    shortcut_activation: "hold_or_toggle",
  },
  permissions: {
    accessibility: true,
    microphone: true,
    input_monitoring: true,
  },
  notification: "granted",
  history: HISTORY,
  relay: PHONES,
  qrSvg: fakeQr(),
};

/* --------------------------------------------------------------- Shots */

interface Shot {
  name: string;
  window: "main" | "pill";
  mock?: MockOptions;
  /** Reaches the state after the window has loaded. */
  act?: (page: Page) => Promise<void>;
  themes?: ("light" | "dark")[];
}

const wait = (page: Page, ms: number) => page.waitForTimeout(ms);

async function section(page: Page, name: string) {
  await page
    .getByRole("navigation")
    .getByRole("button", { name, exact: true })
    .click();
  await page.getByRole("heading", { level: 1, name }).waitFor();
  await wait(page, 350);
}

const SECTIONS: [string, string][] = [
  ["history", "Historik"],
  ["general", "Generelt"],
  ["key", "Tast"],
  ["text", "Tekst"],
  ["vocabulary", "Ordliste"],
  ["cleanup", "Ryd op med AI"],
  ["phone", "Telefon"],
  ["model", "Model"],
  ["updates", "Opdateringer"],
  ["advanced", "Avanceret"],
  ["about", "Om"],
];

function onboardingShots(): Shot[] {
  const shots: Shot[] = [];
  const fresh: MockOptions = {
    relay: { ...PHONES, phones: [] },
    qrSvg: fakeQr(),
  };
  for (const platform of ["macos", "windows"] as const) {
    const steps = onboardingSteps(platform, { phonePairing: true });
    for (const step of steps) {
      const prefix = platform === "macos" ? "onboarding" : "onboarding-windows";
      // Windows: only the steps that differ from the Mac.
      if (platform === "windows" && step === "welcome") continue;
      shots.push({
        name: `${prefix}-${step}`,
        window: "main",
        themes: platform === "windows" ? ["light"] : undefined,
        mock: {
          ...fresh,
          platform,
          wt: { onboarding_resume_step: step === "welcome" ? null : step },
          app: { shortcut_activation: "hold_or_toggle" },
        },
        act: async (page) => {
          // The background download shows its progress (once the screens
          // listen for it).
          await wait(page, 400);
          await page
            .evaluate(() =>
              (window as any).__WT_MOCK__.emit?.("model-download-progress", {
                model_id: "walkietalkey/edda-v0.2-gguf/edda-v0.2-Q8_0.gguf",
                downloaded: 38,
                total: 100,
                percentage: 38,
              }),
            )
            .catch(() => {});
          // The welcome's logo intro plays once before the shot.
          await wait(page, step === "welcome" ? 2600 : 900);
        },
      });
    }
  }
  // States inside the steps.
  const mac = { ...fresh, platform: "macos" as const };
  shots.push(
    {
      name: "onboarding-microphone-granted",
      window: "main",
      mock: {
        ...mac,
        permissions: { microphone: true },
        wt: { onboarding_resume_step: "microphone" },
      },
      act: (p) => wait(p, 900),
    },
    {
      name: "onboarding-accessibility-granted",
      window: "main",
      mock: {
        ...mac,
        permissions: { microphone: true, accessibility: true },
        wt: { onboarding_resume_step: "accessibility" },
      },
      act: (p) => wait(p, 900),
    },
    {
      name: "onboarding-try-needsfix",
      window: "main",
      mock: {
        ...mac,
        permissions: { microphone: true, accessibility: true },
        globeKey: { fn_is_key: true, usage: 1, needs_fix: true },
        wt: { onboarding_resume_step: "try" },
      },
      act: (p) => wait(p, 900),
    },
    {
      name: "onboarding-try-listening",
      window: "main",
      mock: {
        ...mac,
        permissions: { microphone: true, accessibility: true },
        downloaded: [EDDA],
        wt: { onboarding_resume_step: "try" },
      },
      act: async (p) => {
        await emit(p, "wt-key-state", true).catch(() => {});
        await wait(p, 600);
      },
    },
    {
      name: "onboarding-try-done",
      window: "main",
      mock: {
        ...mac,
        permissions: { microphone: true, accessibility: true },
        downloaded: [EDDA],
        wt: { onboarding_resume_step: "try" },
      },
      act: async (p) => {
        await p
          .locator("textarea")
          .first()
          .fill("Hej, det her er min første diktering.");
        await emit(p, "wt-pill-end", { state: "pasted", shortcut: "⌘V" });
        await wait(p, 600);
      },
    },
    {
      name: "onboarding-phone-code",
      window: "main",
      mock: { ...mac, wt: { onboarding_resume_step: "phone" } },
      act: async (p) => {
        await p
          .getByRole("button", { name: /Vis koden|Par en telefon/ })
          .first()
          .click()
          .catch(() => {});
        await wait(p, 900);
      },
    },
  );
  return shots;
}

function mainShots(): Shot[] {
  const shots: Shot[] = SECTIONS.map(([id, name]) => ({
    name: `settings-${id}`,
    window: "main" as const,
    mock: installed,
    act: (p: Page) => section(p, name),
  }));
  shots.push(
    {
      name: "history-empty",
      window: "main",
      mock: { ...installed, history: [] },
      act: (p) => section(p, "Historik"),
    },
    {
      name: "history-sent",
      window: "main",
      mock: installed,
      act: async (p) => {
        await section(p, "Historik");
        await p
          .getByRole("button", { name: "Vis hvad der blev sendt" })
          .last()
          .click();
        await wait(p, 300);
      },
    },
    {
      name: "pairing-code",
      window: "main",
      mock: installed,
      act: async (p) => {
        await section(p, "Telefon");
        await p.getByRole("button", { name: "Par en telefon" }).last().click();
        await wait(p, 900);
      },
    },
    {
      name: "pairing-expired",
      window: "main",
      mock: { ...installed, pairingExpiresInMs: 1200 },
      act: async (p) => {
        await section(p, "Telefon");
        await p.getByRole("button", { name: "Par en telefon" }).last().click();
        await wait(p, 2600);
      },
    },
    {
      name: "dialog-phone-joined",
      window: "main",
      mock: installed,
      act: async (p) => {
        await section(p, "Generelt");
        await emit(p, "wt-phone-joined", { id: "p3", name: "Jonathans iPad" });
        await wait(p, 500);
      },
    },
    {
      name: "dialog-delete-history",
      window: "main",
      mock: installed,
      act: async (p) => {
        await section(p, "Historik");
        await p
          .getByRole("button", { name: "Slet al historik" })
          .first()
          .click();
        await wait(p, 500);
      },
    },
    {
      name: "dialog-cleanup-consent",
      window: "main",
      mock: { ...installed, keys: ["openai"] },
      act: async (p) => {
        await section(p, "Ryd op med AI");
        const mode = p.getByRole("radio", { name: "Altid" });
        await mode.check({ force: true }).catch(() => {});
        await wait(p, 300);
        const select = p.locator("select").first();
        await select.selectOption("openai").catch(() => {});
        await wait(p, 500);
      },
    },
    {
      name: "settings-key-needsfix",
      window: "main",
      mock: {
        ...installed,
        globeKey: { fn_is_key: true, usage: 2, needs_fix: true },
      },
      act: (p) => section(p, "Tast"),
    },
    {
      name: "main-access-lost",
      window: "main",
      mock: {
        ...installed,
        permissions: { microphone: true, accessibility: false },
      },
      act: async (p) => {
        await section(p, "Historik");
        await emit(p, "wt-accessibility-lost", true).catch(() => {});
        await wait(p, 500);
      },
    },
    {
      name: "main-paused",
      window: "main",
      mock: { ...installed, paused: true },
      act: (p) => section(p, "Generelt"),
    },
    {
      name: "settings-cleanup-on",
      window: "main",
      mock: {
        ...installed,
        keys: ["openai"],
        wt: {
          cleanup_mode: "when_needed",
          cleanup_provider: "openai",
          cleanup_model: "gpt-4.1-mini",
          cleanup_consented: ["openai"],
        },
      },
      act: (p) => section(p, "Ryd op med AI"),
    },
  );
  return shots;
}

function pillShots(): Shot[] {
  // Speech-like bands: most energy low, a moving shimmer on top.
  const levels = (k: number) =>
    Array.from({ length: 16 }, (_, i) =>
      Math.min(
        1,
        Math.exp(-i / 11) * (0.6 + 0.4 * Math.abs(Math.sin(i * 1.3 + k * 1.7))),
      ),
    );
  const talk = async (p: Page) => {
    for (let k = 0; k < 8; k++) {
      await emit(p, "mic-level", levels(k));
      await wait(p, 60);
    }
  };
  const listen = async (p: Page) => {
    await emit(p, "show-overlay", "recording");
    await emit(p, "recording-ready");
    await talk(p);
  };
  const end =
    (state: string, shortcut = "⌘V") =>
    async (p: Page) => {
      await emit(p, "show-overlay", "recording");
      await emit(p, "wt-pill-end", { state, shortcut });
      await wait(p, 700);
    };
  return [
    {
      name: "pill-listening",
      window: "pill",
      act: async (p) => {
        await listen(p);
        await wait(p, 2300);
      },
    },
    {
      name: "pill-handsfree",
      window: "pill",
      act: async (p) => {
        await listen(p);
        await emit(p, "wt-pill-handsfree", true).catch(() => {});
        await talk(p).catch(() => {});
        await wait(p, 600);
      },
    },
    {
      name: "pill-countdown",
      window: "pill",
      act: async (p) => {
        await listen(p);
        await emit(p, "wt-pill-countdown", { seconds_left: 12 });
        await wait(p, 600);
      },
    },
    {
      name: "pill-processing",
      window: "pill",
      act: async (p) => {
        await emit(p, "show-overlay", "transcribing");
        await wait(p, 700);
      },
    },
    { name: "pill-pasted", window: "pill", act: end("pasted") },
    { name: "pill-clipboard", window: "pill", act: end("clipboard") },
    { name: "pill-nospeech", window: "pill", act: end("no_speech") },
    { name: "pill-raw", window: "pill", act: end("cleanup_skipped") },
    {
      name: "pill-notready",
      window: "pill",
      act: async (p) => {
        await emit(p, "show-overlay", "transcribing");
        await emit(p, "wt-pill-not-ready");
        await wait(p, 700);
      },
    },
  ];
}

/* ------------------------------------------------------------- Capture */

async function serverUp(): Promise<boolean> {
  try {
    return (await fetch(base)).ok;
  } catch {
    return false;
  }
}

async function startServer(): Promise<ChildProcess | null> {
  if (await serverUp()) return null;
  const child = spawn(
    join(root, "node_modules/.bin/vite"),
    ["--port", String(port), "--strictPort"],
    { cwd: root, stdio: "ignore" },
  );
  for (let i = 0; i < 120; i++) {
    if (await serverUp()) return child;
    await new Promise((r) => setTimeout(r, 250));
  }
  child.kill();
  throw new Error(`Vite did not start on ${base}`);
}

async function capture(browser: Browser, shot: Shot) {
  const pill = shot.window === "pill";
  const [width, height] = pill ? PILL : MAIN;
  for (const theme of shot.themes ?? ["light", "dark"]) {
    for (const scale of scales) {
      const context = await browser.newContext({
        viewport: { width, height },
        deviceScaleFactor: scale,
        colorScheme: theme,
        locale: "da-DK",
      });
      const page = await context.newPage();
      await installMock(page, {
        ...(shot.mock ?? {}),
        window: pill ? "recording_overlay" : "main",
      });
      await page.goto(base + (pill ? "/src/overlay/index.html" : "/"));
      if (pill) {
        // The overlay is transparent; a plain desk behind it shows the halo
        // and where the window clips it.
        await page.addStyleTag({
          content: `html, body { background: ${theme === "dark" ? "#24221f" : "#ece8e1"} !important; }`,
        });
      } else {
        await page.waitForSelector("main", { timeout: 15000 });
      }
      await page.evaluate(() => document.fonts.ready);
      try {
        await shot.act?.(page);
      } catch (e) {
        console.warn(`  ${shot.name}: ${String(e).split("\n")[0]}`);
      }
      const file = join(out, `${shot.name}-${theme}@${scale}x.png`);
      await page.screenshot({ path: file });
      await context.close();
      console.log(`  ${file.replace(root + "/", "")}`);
    }
  }
}

async function main() {
  mkdirSync(out, { recursive: true });
  const server = await startServer();
  const browser = await chromium.launch();
  try {
    const shots = [...onboardingShots(), ...mainShots(), ...pillShots()];
    for (const shot of shots) {
      if (only && !shot.name.includes(only)) continue;
      await capture(browser, shot);
    }
  } finally {
    await browser.close();
    server?.kill();
  }
  console.log(
    `Main window ${MAIN.join("x")}, pill window ${PILL.join("x")}; shots in ${out}`,
  );
  if (!existsSync(out)) process.exit(1);
}

await main();
