import {
  b64uEncode,
  randomBytes,
  type DevicePayload,
  type TrainingCheck,
} from "@walkietalkey/protocol";
import { bytesToInt16, rms } from "./audio";
import { ScriptedComputer } from "./computer";
import {
  expect,
  hold,
  holdButton,
  label,
  pairByLink,
  preparePage,
  test,
} from "./helpers";

/* Training takes for the fine-tuning workbench (wt-train record, Værkstedet; PROTOCOL.md 8.4,
   PRIV-05): the computer's prompt shows the training screen, the sentence is recorded through the
   dictation capture and arrives as audio_start_training with the prompt, the next prompt shows
   the check, "Tag om" records the last sentence again, "Spring over" asks the computer to pass
   over the sentence (PHONE-52), and the end returns the phone to normal. */

const SENTENCE = "Vi merger PR'en, når buildet er grønt.";
const NEXT = "Kan du deploye til staging?";

function prompt(
  training: Uint8Array,
  next: [string, string] | null,
  last: [string, string, TrainingCheck] | null,
  done: number,
): DevicePayload {
  return {
    type: "training_prompt",
    training,
    style: "whisper",
    done,
    total: 416,
    ...(next ? { next: { prompt: next[0], text: next[1] } } : {}),
    ...(last
      ? { last: { prompt: last[0], text: last[1], check: last[2] } }
      : {}),
  };
}

const text = (page: import("@playwright/test").Page) =>
  page.locator(".wt-training-text");
const skip = (page: import("@playwright/test").Page) =>
  page.getByRole("button", { name: "Spring over" });

test.describe("training takes (PRIV-05)", () => {
  test("prompt, take, check, redo and the end", async ({
    page,
    browserName,
    newComputer,
  }) => {
    const computer = await newComputer("MacBook");
    await preparePage(page, browserName);
    await pairByLink(page, computer);
    const training = randomBytes(16);

    // The computer starts a session: the sentence replaces the main screen.
    await computer.toPhone(prompt(training, ["s0042", SENTENCE], null, 0));
    await expect(text(page)).toHaveText(SENTENCE);
    await expect(page.locator(".wt-training-progress")).toHaveText(
      "Hvisk · 0 af 416",
    );
    await expect(page.locator(".wt-training-title")).toHaveText(
      "Indtaling til MacBook",
    );
    await expect(label(page)).toHaveText("Hold for at tale");

    // The take goes through the dictation capture, tagged with the prompt.
    await hold(page, 1500);
    const s = await computer.waitEnded();
    expect(s.training).toMatchObject({
      id: b64uEncode(training),
      prompt: "s0042",
    });
    expect(s.end!.chunks).toBeGreaterThanOrEqual(7);
    expect(rms(bytesToInt16(ScriptedComputer.pcm(s)))).toBeGreaterThan(0.05);
    await expect(label(page)).toHaveText("Gemt");
    await expect(page.locator(".wt-app-sub")).toHaveText("");

    // The next prompt shows the check of the take just made, and offers a redo.
    await computer.toPhone(
      prompt(training, ["s0043", NEXT], ["s0042", SENTENCE, "quiet"], 1),
    );
    await expect(text(page)).toHaveText(NEXT);
    await expect(page.locator(".wt-training-check")).toContainText(
      "Optagelsen er svag",
    );
    await page.getByRole("button", { name: "Tag om" }).click();
    await expect(text(page)).toHaveText(SENTENCE);
    // A redo is not skipped.
    await expect(skip(page)).toBeDisabled();
    await hold(page, 1200);
    const redo = await computer.waitSession(
      (x) => x !== s && !!x.end && x.training?.prompt === "s0042",
      "the redo",
    );
    expect(redo.training!.id).toBe(b64uEncode(training));
    await computer.toPhone(
      prompt(training, ["s0043", NEXT], ["s0042", SENTENCE, "ok"], 1),
    );
    await expect(text(page)).toHaveText(NEXT);
    await expect(page.locator(".wt-training-check")).toHaveText("Gemt.");

    // The session ends: the main screen is back, and a press is a dictation again.
    await computer.toPhone({ type: "training_end", training });
    await expect(text(page)).toHaveCount(0);
    await expect(holdButton(page)).toBeVisible();
    await expect(label(page)).toHaveText("Hold for at tale");
    const before = computer.sessions.size;
    await hold(page, 800);
    const dictation = await computer.waitSession(
      (x) => !!x.end && !x.training && x.starts === 1,
      "a dictation",
    );
    expect(computer.sessions.size).toBe(before + 1);
    expect(dictation.training).toBeUndefined();
  });

  test("Spring over: an empty training take for skip:<prompt>, then the computer's next sentence (PHONE-52)", async ({
    page,
    browserName,
    newComputer,
  }) => {
    const computer = await newComputer("MacBook");
    await preparePage(page, browserName);
    await pairByLink(page, computer);
    const training = randomBytes(16);
    await computer.toPhone(prompt(training, ["s0042", SENTENCE], null, 16));
    await expect(text(page)).toHaveText(SENTENCE);

    // One calm row under the sentence, thumb-sized, above the hold button.
    const redo = page.getByRole("button", { name: "Tag om" });
    await expect(redo).toBeDisabled();
    await expect(skip(page)).toBeEnabled();
    const box = async (l: import("@playwright/test").Locator) =>
      (await l.boundingBox())!;
    const [r, k, t, b] = await Promise.all([
      box(redo),
      box(skip(page)),
      box(text(page)),
      box(holdButton(page)),
    ]);
    expect(Math.abs(r.y - k.y)).toBeLessThan(1);
    expect(Math.min(r.height, k.height)).toBeGreaterThanOrEqual(44);
    expect(r.y).toBeGreaterThanOrEqual(t.y + t.height);
    expect(r.y + r.height).toBeLessThanOrEqual(b.y);
    expect(k.x + k.width).toBeLessThanOrEqual(page.viewportSize()!.width + 0.5);

    await skip(page).click();
    const s = await computer.waitSession(
      (x) => x.cancelled && x.training?.prompt === "skip:s0042",
      "the skip",
    );
    expect(s.training!.id).toBe(b64uEncode(training));
    expect(s.blocks.size).toBe(0);
    expect(s.chunkFrames).toBe(0);
    expect(s.end).toBeNull();
    // Nothing new on the phone: the same sentence, waiting for the computer.
    await expect(skip(page)).toBeDisabled();
    await expect(text(page)).toHaveText(SENTENCE);
    await expect(label(page)).toHaveText("Hold for at tale");

    // The computer moves on by itself.
    await computer.toPhone(prompt(training, ["s0043", NEXT], null, 16));
    await expect(text(page)).toHaveText(NEXT);
    await expect(skip(page)).toBeEnabled();
    // A take after it is an ordinary training take.
    await hold(page, 1200);
    const take = await computer.waitSession(
      (x) => !!x.end && x.training?.prompt === "s0043",
      "the take after the skip",
    );
    expect(take.cancelled).toBe(false);
    expect(
      [...computer.sessions.values()].filter((x) => x.cancelled),
    ).toHaveLength(1);
  });

  test("Afslut leaves the training screen", async ({
    page,
    browserName,
    newComputer,
  }) => {
    const computer = await newComputer("MacBook");
    await preparePage(page, browserName);
    await pairByLink(page, computer);
    const training = randomBytes(16);
    await computer.toPhone(prompt(training, ["s0001", SENTENCE], null, 0));
    await expect(text(page)).toHaveText(SENTENCE);
    await page.getByRole("button", { name: "Afslut" }).click();
    await expect(text(page)).toHaveCount(0);
    await expect(label(page)).toHaveText("Hold for at tale");
    // The same session's prompts stay away.
    await computer.toPhone(prompt(training, ["s0002", NEXT], null, 0));
    await page.waitForTimeout(500);
    await expect(text(page)).toHaveCount(0);
  });
});
