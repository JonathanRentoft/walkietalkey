import { expect, test } from "@playwright/test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FakeApp, pcmOf } from "./fake-app";

/* The recorder page with the app played by the spec (see playwright.config.ts). */

const work = () => process.env.WT_RECORDER_E2E!;
const folder = (name: string) => join(work(), `${name}-recordings`);
const speech = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../models/clips/da-fleurs-10s.wav",
);
const PHONE = {
  id: "cGhvbmUtaWQtMTIzNDU2Nw",
  name: "Jonathans iPhone",
  platform: "ios",
  online: true,
};

type Wav = {
  format: number;
  channels: number;
  rate: number;
  bits: number;
  frames: number;
};

/** A RIFF/WAVE file's format. */
function readWav(path: string): Wav {
  const b = readFileSync(path);
  expect(b.toString("ascii", 0, 4)).toBe("RIFF");
  let fmt: Omit<Wav, "frames"> | undefined;
  for (let at = 12; at + 8 <= b.length;) {
    const id = b.toString("ascii", at, at + 4);
    const size = b.readUInt32LE(at + 4);
    const body = at + 8;
    if (id === "fmt ")
      fmt = {
        format: b.readUInt16LE(body),
        channels: b.readUInt16LE(body + 2),
        rate: b.readUInt32LE(body + 4),
        bits: b.readUInt16LE(body + 14),
      };
    else if (id === "data" && fmt) return { ...fmt, frames: size / 2 };
    at = body + size + (size % 2);
  }
  throw new Error(`${path}: no fmt and data chunks`);
}

test("a phone session: prompts, a saved take, a silent one, a redo, and resume @phone", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator("#link-text")).toContainText(
    "Venter på WalkieTalkey",
  );
  await expect(page.locator("#progress")).toHaveText("0 af 2 indtalt");

  const app = await FakeApp.fromFile(join(work(), "phone-app-url"));
  expect((await app.hello([PHONE])).status).toBe(200);
  await expect(page.locator("#link-text")).toHaveText(
    "Forbundet. Sætningerne vises på Jonathans iPhone.",
  );
  // The first prompt, for the phone.
  const first = await app.next("prompt");
  expect(first.next).toEqual({
    prompt: "s0001",
    text: "Vi merger PR'en, når buildet er grønt.",
  });
  await expect(page.locator("#sentence")).toHaveText(
    "Vi merger PR'en, når buildet er grønt.",
  );
  await expect(page.locator("#hint")).toContainText("Hvisk i telefonen");
  await expect(page.locator("#record")).toBeHidden();

  // The phone records: the page shows it, then the take arrives and is saved.
  await app.event({ type: "recording", prompt: "s0001", source: "phone" });
  await expect(page.locator("#hint")).toHaveText("Optager på telefonen");
  const saved = await app.take(
    {
      prompt: "s0001",
      source: "phone",
      session: "c2Vzc2lvbi1pZC0xMjM0NQ",
      phone: PHONE.id,
      microphone: "iPhone-mikrofon",
      chunks: 15,
      missing: 0,
      duration_ms: 3000,
    },
    pcmOf(speech, 0, 3),
  );
  expect(saved).toMatchObject({ saved: true, check: "ok", replaced: false });
  const next = await app.next("prompt", (c) => c.done === 1);
  expect(next.next).toMatchObject({ prompt: "s0002" });
  expect(next.last).toMatchObject({ prompt: "s0001", check: "ok" });
  await expect(page.locator("#progress")).toHaveText("1 af 2 indtalt");
  await expect(page.locator("#sentence")).toHaveText(
    "Det regner i Aarhus i dag.",
  );
  await expect(page.locator("#last")).toHaveText("s0001: Gemt.");

  const recordings = folder("phone");
  const wav = readWav(join(recordings, "phone-whisper", "s0001.wav"));
  expect([wav.format, wav.channels, wav.rate, wav.bits]).toEqual([
    1, 1, 16000, 16,
  ]);
  expect(wav.frames).toBe(3 * 16000);
  const meta = JSON.parse(
    readFileSync(join(recordings, "phone-whisper", "s0001.json"), "utf8"),
  );
  expect(meta).toMatchObject({
    id: "s0001",
    condition: "phone-whisper",
    device: "iphone",
    style: "whisper",
    microphone: "iPhone-mikrofon",
    take: 1,
    phone: { name: "Jonathans iPhone", platform: "ios" },
  });
  expect(meta.checks.check).toBe("ok");

  // A silent take is not saved, and the sentence stays.
  const silent = await app.take(
    { prompt: "s0002", source: "phone", missing: 0, duration_ms: 2000 },
    Buffer.alloc(2 * 16000 * 2),
  );
  expect(silent).toMatchObject({ saved: false, check: "silent" });
  await expect(page.locator("#last")).toHaveText(
    "s0002: Hørte ikke noget. Optag den igen.",
  );
  await expect(page.locator("#sentence")).toHaveText(
    "Det regner i Aarhus i dag.",
  );
  expect(existsSync(join(recordings, "phone-whisper", "s0002.wav"))).toBe(
    false,
  );

  // R goes back to the sentence last kept; the phone gets it as the prompt again.
  await page.keyboard.press("r");
  await expect(page.locator("#sentence")).toHaveText(
    "Vi merger PR'en, når buildet er grønt.",
  );
  await app.next(
    "prompt",
    (c) =>
      (c.next as { prompt: string } | null)?.prompt === "s0001" && c.done === 1,
  );
  const redo = await app.take(
    { prompt: "s0001", source: "phone", missing: 0, duration_ms: 2500 },
    pcmOf(speech, 3, 2.5),
  );
  expect(redo).toMatchObject({ saved: true, replaced: true });
  expect(
    readdirSync(join(recordings, ".replaced", "phone-whisper")).filter((n) =>
      n.endsWith(".wav"),
    ),
  ).toHaveLength(1);
  // P plays the take back from the server.
  const played = page.waitForResponse((r) =>
    r.url().includes("/api/takes/s0001.wav"),
  );
  await page.keyboard.press("p");
  expect((await played).status()).toBe(200);

  // The progress per condition shows on the page.
  await expect(page.locator("#conditions tr.current")).toContainText(
    "1 af 2 sætninger",
  );

  // A reload resumes where the session is.
  await page.reload();
  await expect(page.locator("#progress")).toHaveText("1 af 2 indtalt");
});

test("a Mac session: the page starts and stops a take on the app's input @mac", async ({
  page,
}) => {
  await page.goto("/");
  const app = await FakeApp.fromFile(join(work(), "mac-app-url"));
  expect((await app.hello([])).status).toBe(200);
  await expect(page.locator("#link-text")).toContainText(
    "Forbundet til WalkieTalkey",
  );
  await expect(page.locator("#sentence")).toHaveText(
    "Kan du deploye til staging?",
  );
  await expect(page.locator("#hint")).toContainText(
    "Tryk mellemrum for at optage",
  );
  await expect(page.locator("#record")).toBeEnabled();

  await page.keyboard.press("Space");
  const start = await app.next("mac_start");
  expect(start.prompt).toBe("s0003");
  await app.event({
    type: "recording",
    prompt: "s0003",
    source: "mac",
    input: "MacBook Pro-mikrofon",
  });
  await expect(page.locator("#record")).toHaveText("Stop");
  await page.keyboard.press("Space");
  await app.next("mac_stop");
  const r = await app.take(
    {
      prompt: "s0003",
      source: "mac",
      microphone: "MacBook Pro-mikrofon",
      missing: 0,
      duration_ms: 3000,
    },
    pcmOf(speech, 5, 3),
  );
  expect(r).toMatchObject({ saved: true });
  await expect(page.locator("#progress")).toHaveText("1 af 1 indtalt");
  await expect(page.locator("#sentence")).toHaveText(
    "Alle er indtalt i denne betingelse. Tak.",
  );
  const meta = JSON.parse(
    readFileSync(join(folder("mac"), "mac-normal", "s0003.json"), "utf8"),
  );
  expect(meta).toMatchObject({
    condition: "mac-normal",
    device: "mac",
    style: "normal",
    microphone: "MacBook Pro-mikrofon",
    phone: null,
  });
  expect(meta.relay).toBeUndefined();
});

test("the app's API needs the session's token, and a web page cannot post to it @mac", async ({
  page,
}) => {
  const url = readFileSync(join(work(), "mac-app-url"), "utf8").trim();
  const [base, token] = url.split("#") as [string, string];
  expect((await fetch(`${base}/next?after=0&wait=0`)).status).toBe(401);
  // The page never gets the token; and a POST from a web page carries an Origin, which the
  // app's API refuses even with the right token.
  await page.goto("/");
  expect(await page.content()).not.toContain(token);
  const status = await page.evaluate(
    async ([u, t]) =>
      (
        await fetch(`${u}/events`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${t}`,
            "Content-Type": "application/json",
          },
          body: "{}",
        })
      ).status,
    [base, token],
  );
  expect(status).toBe(403);
});
