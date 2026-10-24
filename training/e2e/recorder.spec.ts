import { expect, test } from "@playwright/test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/* The recorder page with Chromium's fake microphone (see playwright.config.ts). */

const folder = (project: string) => join(process.env.WT_RECORDER_E2E!, project);

type Wav = {
  format: number;
  channels: number;
  rate: number;
  bits: number;
  samples: Int16Array;
};

/** A RIFF/WAVE file's format and its 16-bit samples. */
function readWav(path: string): Wav {
  const b = readFileSync(path);
  expect(b.toString("ascii", 0, 4)).toBe("RIFF");
  expect(b.toString("ascii", 8, 12)).toBe("WAVE");
  let fmt: Omit<Wav, "samples"> | undefined;
  for (let at = 12; at + 8 <= b.length;) {
    const id = b.toString("ascii", at, at + 4);
    const size = b.readUInt32LE(at + 4);
    const body = at + 8;
    if (id === "fmt ") {
      fmt = {
        format: b.readUInt16LE(body),
        channels: b.readUInt16LE(body + 2),
        rate: b.readUInt32LE(body + 4),
        bits: b.readUInt16LE(body + 14),
      };
    } else if (id === "data" && fmt) {
      const samples = new Int16Array(size / 2);
      for (let i = 0; i < samples.length; i++)
        samples[i] = b.readInt16LE(body + i * 2);
      return { ...fmt, samples };
    }
    at = body + size + (size % 2);
  }
  throw new Error(`${path}: no fmt and data chunks`);
}

function rms(x: Int16Array): number {
  let s = 0;
  for (const v of x) s += (v / 32768) ** 2;
  return Math.sqrt(s / Math.max(1, x.length));
}

test("records a take, saves 16 kHz mono 16-bit WAV with its text, redoes it and resumes @speech", async ({
  page,
}) => {
  const recordings = folder("speech");
  await page.goto("/");
  await expect(page.locator("#sentence")).toHaveText(
    "Vi merger PR'en, når buildet er grønt.",
  );
  await expect(page.locator("#progress")).toHaveText("0 af 3 indtalt");
  await expect(page.locator("#device option")).not.toHaveCount(0);
  await expect(page.locator("#record")).toBeEnabled();
  // The fake microphone plays speech: the meter moves, and no silence warning shows.
  await expect.poll(() => page.locator("#db").textContent()).not.toBe("-∞ dB");

  await page.keyboard.press("Space");
  await expect(page.locator("#record")).toHaveText("Stop");
  await page.waitForTimeout(3000);
  await expect(page.locator("#warning")).toBeHidden();
  await page.keyboard.press("Space");
  await expect(page.locator("#message")).toContainText("s0001 er gemt");
  await expect(page.locator("#progress")).toHaveText("1 af 3 indtalt");
  await expect(page.locator("#sentence")).toHaveText(
    "Det regner i Aarhus i dag.",
  );

  const wav = readWav(join(recordings, "s0001.wav"));
  expect([wav.format, wav.channels, wav.rate, wav.bits]).toEqual([
    1, 1, 16000, 16,
  ]);
  const seconds = wav.samples.length / wav.rate;
  expect(seconds).toBeGreaterThan(1.0);
  expect(seconds).toBeLessThan(3.6);
  expect(rms(wav.samples)).toBeGreaterThan(0.005);
  expect(readFileSync(join(recordings, "s0001.txt"), "utf8")).toBe(
    "Vi merger PR'en, når buildet er grønt.\n",
  );

  // R goes back to the take just saved and records it again; the old take is kept aside.
  await page.keyboard.press("r");
  await expect(page.locator("#sentence")).toHaveText(
    "Vi merger PR'en, når buildet er grønt.",
  );
  await expect(page.locator("#record")).toHaveText("Stop");
  await page.waitForTimeout(2000);
  await page.keyboard.press("Space");
  await expect(page.locator("#message")).toContainText(
    "den gamle er gemt til side",
  );
  expect(
    readdirSync(join(recordings, ".replaced")).filter((n) =>
      n.endsWith(".wav"),
    ),
  ).toHaveLength(1);

  // P plays the saved take back from the server.
  const played = page.waitForResponse((r) =>
    r.url().includes("/api/takes/s0001.wav"),
  );
  await page.keyboard.press("p");
  expect((await played).status()).toBe(200);

  // A reload resumes at the first sentence without a take.
  await page.reload();
  await expect(page.locator("#sentence")).toHaveText(
    "Det regner i Aarhus i dag.",
  );
  await expect(page.locator("#progress")).toHaveText("1 af 3 indtalt");
});

test("a dead input is flagged at once, and its take is refused @silence", async ({
  page,
}) => {
  const recordings = folder("silence");
  await page.goto("/");
  await expect(page.locator("#warning")).toBeVisible();
  await expect(page.locator("#warning")).toContainText("sender kun stilhed");

  await page.keyboard.press("Space");
  await expect(page.locator("#record")).toHaveText("Stop");
  await page.waitForTimeout(2000);
  await page.keyboard.press("Space");
  await expect(page.locator("#message")).toContainText(
    "tavs og blev ikke gemt",
  );
  await expect(page.locator("#progress")).toHaveText("0 af 3 indtalt");
  await expect(page.locator("#sentence")).toHaveText(
    "Vi merger PR'en, når buildet er grønt.",
  );
  expect(existsSync(join(recordings, "s0001.wav"))).toBe(false);
});
