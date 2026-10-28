import { expect, test, type Page } from "@playwright/test";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FakeApp, pcmOf, type Command } from "./fake-app";

/* Værkstedet with the app played by the spec (see studio.config.ts). The tests run in order
   against one server: a phone session, a Mac session, then the Data and Journal screens; run 11
   adds Lær det (VS Code is a stand-in) and the screens that are still empty on a first start. */

test.describe.configure({ mode: "serial" });

const work = () => process.env.WT_STUDIO_E2E!;
const speech = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../models/clips/da-fleurs-10s.wav",
);
const JOURNAL_PAGE = "2026-10-27-e2e-proeve";
const PHONE = {
  id: "cGhvbmUtaWQtMTIzNDU2Nw",
  name: "Jonathans iPhone",
  platform: "ios",
  online: true,
};
const TEXT = {
  s0001: "Vi merger PR'en, når buildet er grønt.",
  s0002: "Det regner i Aarhus i dag.",
  s0003: "Kan du deploye til staging?",
  s0004: "Hunden vil ikke ud, når det regner.",
};

/** The app's link once the studio has written a new one (each session has its own token). */
let lastUrl: string | null = null;
async function newApp(): Promise<FakeApp> {
  const file = join(work(), "app-url");
  const t0 = Date.now();
  for (;;) {
    const url = existsSync(file) ? readFileSync(file, "utf8").trim() : "";
    if (url.includes("#") && url !== lastUrl) {
      lastUrl = url;
      return new FakeApp(url);
    }
    if (Date.now() - t0 > 20_000) throw new Error("no new app link");
    await new Promise((r) => setTimeout(r, 100));
  }
}

const promptFor =
  (id: string) =>
  (c: Command): boolean =>
    (c.next as { prompt: string } | null)?.prompt === id;

/** A take from the clip: `length` seconds from `from`, scaled by `db` decibels, with 0.4 s of
    silence before and after (a take that starts or ends mid-word is "cut" and sent back). */
function takeOf(from: number, length: number, db = 0): Buffer {
  const pcm = pcmOf(speech, from, length);
  const pad = 0.4 * 16000 * 2;
  const out = Buffer.alloc(pcm.length + 2 * pad);
  const k = 10 ** (db / 20);
  for (let i = 0; i < pcm.length; i += 2)
    out.writeInt16LE(Math.round(pcm.readInt16LE(i) * k), pad + i);
  return out;
}

const phoneTake = (prompt: string) => ({
  prompt,
  source: "phone",
  phone: PHONE.id,
  microphone: "iPhone-mikrofon",
  missing: 0,
  duration_ms: 3000,
});

const row = (page: Page, id: string) => page.locator(`[data-row="${id}"]`);
const current = (page: Page) => page.locator(".current-text");

/** A row as the studio's state has it right now (the page polls; this looks at once). */
async function stateRow(id: string) {
  const r = await fetch(`http://127.0.0.1:8796/api/recording/state`);
  const state = (await r.json()) as {
    rows: {
      id: string;
      status: string;
      take: { transcribing: boolean } | null;
    }[];
  };
  return state.rows.find((x) => x.id === id)!;
}

let app: FakeApp;

test("a phone session: start, a take heard by Edda, a quiet one, skip, Tag om, pause and resume", async ({
  page,
}) => {
  await page.goto("/optag");
  await expect(
    page.getByRole("heading", { name: "Vælg, hvad du vil optage" }),
  ).toBeVisible();
  await page.locator('input[value="condition:phone-whisper"]').check();
  await page.getByRole("button", { name: "Start optagelsen" }).click();
  await expect(page.locator(".session h2")).toHaveText("Telefonen, hvisket");

  // The app says hello; the page names the phone.
  app = await newApp();
  expect((await app.hello([PHONE])).status).toBe(200);
  await expect(page.locator(".link")).toHaveText(
    "Forbundet. Sætningerne vises på Jonathans iPhone",
  );

  // The first prompt reaches the phone and the page.
  const first = await app.next("prompt", promptFor("s0001"));
  expect(first.next).toEqual({ prompt: "s0001", text: TEXT.s0001 });
  await expect(current(page)).toHaveText(TEXT.s0001);

  // The phone records; the take arrives, is received, then approved with what Edda heard.
  await app.event({ type: "recording", prompt: "s0001", source: "phone" });
  await expect(row(page, "s0001").locator(".badge")).toHaveText("Optager");
  // A whisper: the clip 15 dB down sits in the whisper's good band.
  const saved = await app.take(phoneTake("s0001"), takeOf(0, 3, -15));
  expect(saved).toMatchObject({ saved: true, check: "ok" });
  // Received at once (Edda has not heard it yet), approved once Edda has.
  const received = await stateRow("s0001");
  expect(received.status).toBe("received");
  expect(received.take?.transcribing).toBe(true);
  await expect(row(page, "s0001").locator(".badge")).toHaveText("Godkendt");
  await expect(row(page, "s0001").locator(".heard")).toContainText(
    "Edda hørte",
  );
  await expect(row(page, "s0001").locator(".heard")).toContainText(
    "Alle ord rigtige",
  );
  await expect(
    row(page, "s0001").getByRole("img", { name: /Lydniveau/ }),
  ).toBeVisible();

  // A quiet take (the clip 40 dB down) is kept but sent back: Tag om, with the check named.
  await app.next("prompt", promptFor("s0002"));
  await expect(current(page)).toHaveText(TEXT.s0002);
  const quiet = await app.take(phoneTake("s0002"), takeOf(0, 3, -40));
  expect(quiet).toMatchObject({ saved: true, check: "quiet" });
  await expect(row(page, "s0002").locator(".badge")).toHaveText("Tag om");
  await expect(row(page, "s0002").locator(".chip--back")).toContainText(
    "For svag",
  );
  await expect(
    row(page, "s0002").getByRole("button", { name: /Godkend alligevel/ }),
  ).toBeVisible();

  // The phone's own "Spring over" (an empty take on skip:<id>, cancelled) moves on, and the
  // take sent back comes round again.
  await app.next("prompt", promptFor("s0003"));
  await expect(current(page)).toHaveText(TEXT.s0003);
  await app.event({ type: "recording", prompt: "skip:s0003", source: "phone" });
  await app.event({ type: "cancelled", prompt: "skip:s0003", source: "phone" });
  await app.next("prompt", promptFor("s0002"));
  await expect(current(page)).toHaveText(TEXT.s0002);
  await expect(row(page, "s0003").getByText("Sprunget over")).toBeVisible();

  // "Tag om" on a row makes it the current one, on the phone too.
  await row(page, "s0001").getByRole("button", { name: "Tag om" }).click();
  await expect(current(page)).toHaveText(TEXT.s0001);
  await expect(row(page, "s0001")).toHaveAttribute("aria-current", "step");
  await app.next("prompt", promptFor("s0001"));

  // Pause ends the app's session; resume hands a new one (a new link with a new token).
  await page.getByRole("button", { name: "Pause" }).click();
  await app.next("end");
  await expect(page.getByRole("button", { name: "Fortsæt" })).toBeVisible();
  await expect(page.locator(".link")).toContainText("På pause");
  await page.getByRole("button", { name: "Fortsæt" }).click();
  const resumed = await newApp();
  expect((await resumed.hello([PHONE])).status).toBe(200);
  await resumed.next("prompt", promptFor("s0001"));
  await expect(page.locator(".link")).toHaveText(
    "Forbundet. Sætningerne vises på Jonathans iPhone",
  );
  app = resumed;
});

test("a Mac session: the space bar starts and stops a take, and it shows", async ({
  page,
}) => {
  await page.goto("/optag");
  await page.getByRole("button", { name: "Vælg en anden optagelse" }).click();
  // (A pilot setup has the same Danish name; this is the condition.)
  await page.locator('input[value="condition:mac-normal"]').check();
  await page.getByRole("button", { name: "Start optagelsen" }).click();
  await expect(page.locator(".session h2")).toHaveText(
    "Mac'en, almindelig stemme",
  );
  // A new pick: the phone session's token is refused at once.
  const old = app;
  const mac = await newApp();
  expect((await mac.hello([])).status).toBe(200);
  expect((await old.hello([PHONE])).status).toBe(401);
  await expect(page.locator(".link")).toHaveText(
    "Forbundet til WalkieTalkey på Mac'en",
  );
  await expect(current(page)).toHaveText(TEXT.s0004);

  // Run 12: connected and idle, the session arms the Mac's input before any press; the app
  // records, and the page still offers "Optag".
  const start = await mac.next("mac_start");
  expect(start.prompt).toBe("s0004");
  await mac.event({
    type: "recording",
    prompt: "s0004",
    source: "mac",
    input: "MacBook Pro-mikrofon",
  });
  await expect(page.getByRole("button", { name: /^Optag$/ })).toBeVisible();
  await page.keyboard.press("Space");
  await expect(
    page.getByRole("button", { name: /Stop optagelsen/ }),
  ).toBeVisible();
  await page.keyboard.press("Space");
  // From the stop on the take is being saved; mac_stop follows half a second later.
  await expect(
    page.getByRole("button", { name: /Gemmer optagelsen/ }),
  ).toBeDisabled();
  await mac.next("mac_stop");
  const r = await mac.take(
    {
      prompt: "s0004",
      source: "mac",
      microphone: "MacBook Pro-mikrofon",
      missing: 0,
      duration_ms: 3000,
    },
    takeOf(5, 3),
  );
  expect(r).toMatchObject({ saved: true });
  await expect(row(page, "s0004").locator(".badge")).toHaveText("Godkendt");
  await expect(row(page, "s0004").locator(".heard")).toContainText(
    "Alle ord rigtige",
  );
  await expect(page.locator(".session-meta")).toContainText(
    "Mikrofon: MacBook Pro-mikrofon",
  );
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Vælg, hvad du vil optage" }),
  ).toBeVisible();
});

test("the Data screen shows the splits of the takes", async ({ page }) => {
  await page.goto("/data");
  const stats = page.locator(".stats");
  await expect(stats).toContainText("Sætninger");
  await expect(stats).toContainText("6");
  const split = page.locator(".bars--stacked");
  // s0004 counts; s0001 (Tag om) and s0002 (too quiet) are marked for a new take and left out.
  await expect(
    split
      .locator(".bar-row", { hasText: "Mac'en, almindelig stemme" })
      .locator(".bar-value"),
  ).toHaveText("1");
  await expect(
    split
      .locator(".bar-row", { hasText: "Telefonen, hvisket" })
      .locator(".bar-value"),
  ).toHaveText("0");
  await expect(page.getByText("2 optagelser er ikke med")).toBeVisible();
  await page.getByText("Vis tallene som tabel").click();
  await expect(page.locator(".table-view table")).toContainText(
    "Telefonen, hvisket",
  );
  await expect(page.locator(".leak")).toContainText(
    "Træning, validering og test deler ingen sætninger",
  );
});

test("the Journal saves the hypothesis into the Markdown file", async ({
  page,
}) => {
  await page.goto("/journal");
  await page.getByRole("link", { name: /Prøveside/ }).click();
  await expect(
    page.getByRole("heading", { name: "Prøveside (2026-10-27)" }),
  ).toBeVisible();
  await expect(page.locator(".markdown table")).toContainText("12 %");
  const hypothesis = "Hvis kun decoderen trænes, lærer Edda fagordene.";
  await page.getByRole("textbox", { name: /Hypotese/ }).fill(hypothesis);
  await expect(page.getByText("Ikke gemt")).toBeVisible();
  await page.getByRole("button", { name: "Gem" }).click();
  await expect(page.getByText("Gemt", { exact: true })).toBeVisible();
  const md = readFileSync(
    join(work(), "journal", `${JOURNAL_PAGE}.md`),
    "utf8",
  );
  expect(md).toContain(
    `## Hypothesis\n\n${hypothesis}\n\n## What I changed\n\nIngenting.`,
  );
  expect(md).toContain("| test | 12 % |");
});

test("Lær det opens a working copy in VS Code, and starts over after a confirm", async ({
  page,
}) => {
  await page.goto("/laer");
  await expect(
    page.getByRole("heading", { name: "Lær det", level: 1 }),
  ).toBeVisible();
  const list = page.getByRole("list", { name: "Notesbøgerne" });
  await expect(list.getByRole("heading")).toHaveText([
    "01 Lyden",
    "02 Edda indefra",
  ]);
  const lyden = list.locator("li", { hasText: "Lyden" });
  await expect(lyden).toContainText("Ikke åbnet endnu");

  await lyden.getByRole("button", { name: "Åbn Lyden i VS Code" }).click();
  await expect(lyden).toContainText("Åbnet i VS Code som din egen kopi.");
  // The server resolves the work folder (/var is /private/var on macOS).
  const copy = join(
    realpathSync(join(work(), "work")),
    "notebooks",
    "01-lyden.ipynb",
  );
  expect(existsSync(copy)).toBe(true);
  // By bundle id, with the training folder as the workspace and the copy as the file.
  const args = readFileSync(join(work(), "open.log"), "utf8")
    .trim()
    .split("\n");
  expect(args).toEqual([
    "-b",
    "com.microsoft.VSCode",
    join(dirname(fileURLToPath(import.meta.url)), ".."),
    copy,
  ]);
  await expect(lyden).toContainText("Ikke kørt endnu");

  await lyden.getByRole("button", { name: "Start Lyden forfra" }).click();
  await expect(lyden.getByRole("group")).toContainText("lægges til side");
  await lyden.getByRole("button", { name: "Ja, start forfra" }).click();
  await expect(lyden).toContainText(
    "Startet forfra med den originale notesbog.",
  );
  expect(
    readdirSync(join(work(), "work", "notebooks", ".replaced")),
  ).toHaveLength(1);
});

test("a first start: Evaluering, Versioner and Træning say what comes, and after which step", async ({
  page,
}) => {
  await page.goto("/evaluering");
  await expect(
    page.getByText(
      "Her kommer målingerne af modellerne: ordfejl, tegnfejl og hvor sikre tallene er.",
    ),
  ).toBeVisible();
  await page.goto("/versioner");
  await expect(
    page.getByText("Her kommer dine finjusterede versioner af Edda."),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "Til Træning" })).toHaveAttribute(
    "href",
    "/traening",
  );
  await page.goto("/traening");
  await expect(page.getByText("Start med disse fire")).toBeVisible();
  await expect(page.locator(".essential .setting-key")).toHaveText([
    "training.learning_rate",
    "training.epochs",
    "lora.rank",
    "rehearsal.share",
  ]);
  const all = page.locator("details.all-settings");
  await expect(all).not.toHaveAttribute("open", "");
  await expect(all.locator(".settings")).toBeHidden();
  await all.locator("summary").click();
  await expect(all.locator(".settings")).toBeVisible();
  await expect(
    page.getByText(
      "Her kommer dine træninger med deres bedste epoke og ordfejl.",
    ),
  ).toBeVisible();
});

/* ------------------------------------------------------------------- run 12 */

test("the mix: a preview that writes nothing, then dealing again", async ({
  page,
}) => {
  const plan = join(work(), "plan.csv");
  const mix = join(work(), "mix.yaml");
  const before = [readFileSync(plan, "utf8"), readFileSync(mix, "utf8")];
  await page.goto("/optag");
  const panel = page.getByRole("region", { name: "Skift mixet" });
  const share = (label: string) =>
    panel.getByRole("spinbutton", { name: `Andel for ${label} i procent` });
  await expect(share("Telefonen, hvisket")).toHaveValue("50");
  await expect(panel.getByText("I alt 100 %")).toBeVisible();
  await expect(panel.getByText("pilotens tempo").first()).toBeVisible();

  await share("Telefonen, hvisket").fill("25");
  await expect(panel.getByRole("alert")).toContainText("Nu giver de 75 %");
  await share("Mac'en, hvisket").fill("25");
  await expect(panel.locator(".mix-moved")).toContainText("Det flytter");
  expect([readFileSync(plan, "utf8"), readFileSync(mix, "utf8")]).toEqual(
    before,
  );

  await panel.getByRole("button", { name: "Del ud igen" }).click();
  await expect(panel.getByText(/Sætningerne er delt ud igen/)).toBeVisible();
  expect(readFileSync(mix, "utf8")).toContain(
    "mix:\n  phone-whisper: 25\n  phone-normal: 25\n  mac-normal: 25\n  mac-whisper: 25\n",
  );
  // The sentences with a take keep their condition.
  const dealt = readFileSync(plan, "utf8");
  for (const line of [
    "s0001,phone-whisper",
    "s0002,phone-whisper",
    "s0004,mac-normal",
  ])
    expect(dealt).toContain(line);
  await expect(
    page.getByRole("region", { name: "Fremskridt mod mixet" }),
  ).toContainText("Mac'en, hvisket: 25 %");
});

test("Dine egne ord: the words of his own dictations, ticked, with a sentence of his own", async ({
  page,
}) => {
  const history = join(work(), "app", "history.db");
  const bytes = readFileSync(history);
  await page.goto("/ord");
  await expect(
    page.getByRole("heading", { name: "Dine egne ord", level: 1 }),
  ).toBeVisible();
  const list = page.getByRole("list", { name: "Nye ord at sætte flueben ved" });
  await expect(list.locator(".word-row").first()).toContainText(
    "Grafana3 gange · i 2 dikteringer · 50,0 % af dikteringerne",
  );
  await expect(list).toContainText("Terraform");
  await expect(list).toContainText("load balancer");
  await expect(page.getByText("Fundet i 4 dikteringer.")).toBeVisible();
  // Only words: no sentence of the history is on the page.
  const text = (await page.locator("main").textContent()) ?? "";
  for (const fragment of ["nede igen", "kigger på", "flyttet til torsdag"])
    expect(text).not.toContain(fragment);

  // The word moves to "Dine ord" at once, so the box itself never shows a tick.
  await list.getByRole("checkbox", { name: /Grafana/ }).click();
  const mine = page.getByRole("list", { name: "Ord med flueben" });
  await expect(mine.getByRole("heading", { name: "Grafana" })).toBeVisible();
  const local = join(work(), "local");
  expect(readFileSync(join(local, "own-words.yaml"), "utf8")).toMatch(
    /\nwords: \[Grafana\]\n$/,
  );

  await mine
    .getByRole("textbox", { name: "En sætning med Grafana" })
    .fill("Vi tjekker Grafana, før vi går hjem.");
  await mine.getByRole("button", { name: "Tilføj sætningen" }).click();
  await expect(mine.getByText("Sætningen er tilføjet.")).toBeVisible();
  await expect(mine).toContainText("own-0001");
  expect(readFileSync(join(local, "sentences.csv"), "utf8")).toBe(
    'id,text,kind\nown-0001,"Vi tjekker Grafana, før vi går hjem.",terms\n',
  );
  await mine
    .getByRole("textbox", { name: "En sætning med Grafana" })
    .fill("Grafana er nede.");
  await mine.getByRole("button", { name: "Tilføj sætningen" }).click();
  await expect(mine.getByRole("alert")).toHaveText(
    "En sætning skal have 4 til 20 ord.",
  );
  // The history is read, never written.
  expect(readFileSync(history).equals(bytes)).toBe(true);
  expect(readdirSync(local).sort()).toEqual([
    "own-words.yaml",
    "sentences.csv",
  ]);
});

test("Evaluering: measure on the validation, the test set only after a confirm, every use shown", async ({
  page,
}) => {
  // A finished training with an adapter and both splits, and a build of a config for Edda.
  const run = join(work(), "work", "runs", "train", "e2e-tiny-20261028-120000");
  mkdirSync(join(run, "adapter"), { recursive: true });
  mkdirSync(join(run, "dataset"), { recursive: true });
  writeFileSync(join(run, "config.json"), "{}");
  writeFileSync(join(run, "adapter", "adapter_config.json"), "{}");
  writeFileSync(join(run, "best.json"), '{"epoch": 1, "validation_wer": 0.12}');
  for (const s of ["validation", "test"])
    writeFileSync(join(run, "dataset", `${s}.jsonl`), "");
  mkdirSync(join(work(), "work", "builds", "first-frozen-encoder"), {
    recursive: true,
  });
  writeFileSync(
    join(work(), "work", "builds", "first-frozen-encoder", "validation.jsonl"),
    "",
  );

  await page.goto("/evaluering");
  const measure = page.getByRole("region", { name: "Mål en model" });
  await expect(measure.getByRole("combobox", { name: "Model" })).toContainText(
    "Edda finjusteret (e2e-tiny)",
  );
  await measure.getByRole("button", { name: "Mål på valideringen" }).click();
  await expect(measure.locator(".job-title")).toHaveText(
    "Måling på valideringen: Edda finjusteret (e2e-tiny)",
  );
  await expect(
    measure.getByText("Målingen er færdig. Den står i listen nedenfor."),
  ).toBeVisible();

  const testset = page.getByRole("region", { name: "Testsættet" });
  await expect(testset).toContainText(
    "Låst den 28. okt. 2026: 3 sætninger og 9 klip.",
  );
  await expect(testset.getByRole("heading", { level: 3 })).toHaveText(
    "Brugt 1 gang",
  );
  await measure.getByRole("button", { name: "Mål på testsættet" }).click();
  await expect(
    measure.getByRole("group", { name: "Brug testsættet" }),
  ).toContainText("Testsættet er til den endelige måling.");
  await measure.getByRole("button", { name: "Ja, mål på testsættet" }).click();
  await expect(measure.locator(".job-title")).toHaveText(
    "Måling på testsættet: Edda finjusteret (e2e-tiny)",
  );
  await expect(testset.getByRole("heading", { level: 3 })).toHaveText(
    "Brugt 2 gange",
  );
  await expect(testset.getByText("fra Værkstedet")).toBeVisible();

  // Edda on the build, without FLEURS.
  await measure.getByRole("combobox", { name: "Model" }).selectOption("edda");
  await measure
    .getByRole("combobox", { name: "Datasæt" })
    .selectOption("first-frozen-encoder");
  await measure.getByRole("checkbox", { name: /Spring FLEURS over/ }).check();
  await measure.getByRole("button", { name: "Mål på valideringen" }).click();
  await expect(measure.locator(".job-title")).toHaveText(
    "Måling på valideringen: Edda, original · first-frozen-encoder",
  );
  await expect(measure.getByText(/Målingen er færdig/)).toBeVisible();

  const calls = readFileSync(join(work(), "eval.log"), "utf8")
    .split("---\n")
    .filter(Boolean)
    .map((c) => c.trim().split("\n"));
  const spelling = join(work(), "spelling.yaml");
  expect(calls).toEqual([
    [
      "source=studio",
      "--backend",
      "lora",
      "--run",
      "e2e-tiny-20261028-120000",
      "--dataset",
      "validation",
      "--spelling",
      spelling,
    ],
    [
      "source=studio",
      "--backend",
      "lora",
      "--run",
      "e2e-tiny-20261028-120000",
      "--dataset",
      "test",
      "--spelling",
      spelling,
    ],
    [
      "source=studio",
      "--backend",
      "hf",
      "--build",
      "first-frozen-encoder",
      "--dataset",
      "validation",
      "--spelling",
      spelling,
      "--no-fleurs",
    ],
  ]);
});
