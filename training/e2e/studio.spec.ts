import { expect, test, type Page } from "@playwright/test";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
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

  await page.keyboard.press("Space");
  const start = await mac.next("mac_start");
  expect(start.prompt).toBe("s0004");
  await mac.event({
    type: "recording",
    prompt: "s0004",
    source: "mac",
    input: "MacBook Pro-mikrofon",
  });
  await expect(
    page.getByRole("button", { name: /Stop optagelsen/ }),
  ).toBeVisible();
  await page.keyboard.press("Space");
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
