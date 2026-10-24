// The silent microphone (DESK-59): the pill while recording and at the end,
// and the notice with "Brug {navn}" in the window, against the mocked
// backend.
import { expect, test, type Page } from "@playwright/test";
import { calls, EDDA, emit, installMock, type MockOptions } from "./mock";

const SCARLETT = "Scarlett Solo USB";
const BUILT_IN = "MacBook Pro-mikrofon";
const silent = (over: Record<string, unknown> = {}) => ({
  silent_input: SCARLETT,
  suggestion: null,
  probing: false,
  ...over,
});

async function openPill(page: Page, options: MockOptions = {}) {
  await installMock(page, { window: "recording_overlay", ...options });
  await page.goto("/src/overlay/index.html");
}

async function openApp(page: Page, options: MockOptions = {}) {
  await installMock(page, {
    downloaded: [EDDA],
    ...options,
    app: { selected_model: EDDA, onboarding_completed: true },
  });
  await page.goto("/");
  await expect(page.getByRole("navigation")).toBeVisible();
}

async function section(page: Page, name: string) {
  await page
    .getByRole("navigation")
    .getByRole("button", { name, exact: true })
    .click();
  await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();
}

const announced = async (page: Page) =>
  (await calls(page, "wt_announce")).map((c) => c.args.text);

test.describe("silent microphone: the pill (DESK-59)", () => {
  test("says so while it keeps recording, and sound clears it", async ({
    page,
  }) => {
    await openPill(page);
    await emit(page, "show-overlay", "recording");
    await emit(page, "recording-ready");
    const pill = page.getByTestId("pill");
    await expect(pill.locator(".wt-wave")).toBeVisible();

    await emit(page, "wt-mic-silent", { silent: true });
    await expect(page.getByText("Mikrofonen giver ingen lyd")).toBeVisible();
    await expect(pill).toHaveAttribute("data-mic-silent", "true");
    // Still recording: the time stays, the flat waveform gives way.
    await expect(pill.locator(".wt-pill--listening")).toBeVisible();
    await expect(pill.locator(".wt-pill-time")).toBeVisible();
    await expect(pill.locator(".wt-wave")).toHaveCount(0);
    await expect
      .poll(() => announced(page))
      .toContain("Lytter. Mikrofonen giver ingen lyd");

    await emit(page, "wt-mic-silent", { silent: false });
    await expect(page.getByText("Mikrofonen giver ingen lyd")).toHaveCount(0);
    await expect(pill.locator(".wt-wave")).toBeVisible();
    await expect(pill).not.toHaveAttribute("data-mic-silent", "true");
  });

  test("hands-free keeps the lock and shows the notice", async ({ page }) => {
    await openPill(page);
    await emit(page, "show-overlay", "recording");
    await emit(page, "wt-pill-handsfree", true);
    await emit(page, "wt-mic-silent", { silent: true });
    await expect(page.locator(".wt-pill-lock")).toBeVisible();
    await expect(page.getByText("Mikrofonen giver ingen lyd")).toBeVisible();
  });

  test("a silent take ends with its own state, then Prøv {navn}", async ({
    page,
  }) => {
    await openPill(page);
    await emit(page, "show-overlay", "recording");
    await emit(page, "recording-ready");
    await emit(page, "wt-mic-silent", { silent: true });
    await emit(page, "show-overlay", "transcribing");
    await emit(page, "wt-pill-end", { state: "mic_silent", shortcut: "⌘V" });
    const pill = page.locator(".wt-pill");
    await expect(pill).toHaveClass(/wt-pill--micsilent/);
    await expect(page.getByText("Mikrofonen giver ingen lyd")).toBeVisible();
    await expect(page.getByText("Hørte ikke noget")).toHaveCount(0);

    // The probe is still looking: nothing more yet.
    await emit(page, "wt-mic-check", silent({ probing: true }));
    await expect(page.locator(".wt-pill-note-hint")).toHaveCount(0);

    await emit(page, "wt-mic-check", silent({ suggestion: BUILT_IN }));
    await expect(page.getByText(`Prøv ${BUILT_IN}`)).toBeVisible();
    await expect
      .poll(() => announced(page))
      .toContain(`Mikrofonen giver ingen lyd. Prøv ${BUILT_IN}`);
  });

  test("when no other input works the pill says Tjek mikrofonen", async ({
    page,
  }) => {
    await openPill(page);
    await emit(page, "show-overlay", "recording");
    await emit(page, "wt-pill-end", { state: "mic_silent", shortcut: "⌘V" });
    await emit(page, "wt-mic-check", silent());
    await expect(page.getByText("Tjek mikrofonen")).toBeVisible();
  });

  test("a working microphone that heard nothing still says Hørte ikke noget", async ({
    page,
  }) => {
    await openPill(page);
    await emit(page, "show-overlay", "recording");
    await emit(page, "show-overlay", "transcribing");
    await emit(page, "wt-pill-end", { state: "no_speech", shortcut: "⌘V" });
    await expect(page.getByText("Hørte ikke noget")).toBeVisible();
    await expect(page.getByText("Mikrofonen giver ingen lyd")).toHaveCount(0);
  });

  test("the next dictation starts without the old notice", async ({ page }) => {
    await openPill(page);
    await emit(page, "show-overlay", "recording");
    await emit(page, "wt-mic-silent", { silent: true });
    await emit(page, "wt-pill-end", { state: "mic_silent", shortcut: "⌘V" });
    await emit(page, "wt-mic-check", silent({ suggestion: BUILT_IN }));
    await expect(page.getByText(`Prøv ${BUILT_IN}`)).toBeVisible();

    await emit(page, "show-overlay", "recording");
    await expect(page.getByText("Lytter")).toBeAttached();
    await expect(page.getByText("Mikrofonen giver ingen lyd")).toHaveCount(0);
    await expect(page.getByText(`Prøv ${BUILT_IN}`)).toHaveCount(0);
  });
});

test.describe("silent microphone: the window (DESK-59)", () => {
  test("names the silent input, suggests one that works, and Brug switches", async ({
    page,
  }) => {
    await openApp(page, { micCheck: silent({ suggestion: BUILT_IN }) });
    const notice = page.getByTestId("mic-notice");
    await expect(notice).toHaveText(
      new RegExp(`${SCARLETT} giver ingen lyd\\. Prøv ${BUILT_IN}\\.`),
    );
    await notice.getByRole("button", { name: `Brug ${BUILT_IN}` }).click();
    await expect
      .poll(async () => (await calls(page, "wt_mic_use")).map((c) => c.args))
      .toEqual([{ name: BUILT_IN }]);
    // The new input delivered sound when probed: the notice goes.
    await expect(notice).toHaveCount(0);
  });

  test("Avanceret shows it once, at the microphone setting", async ({
    page,
  }) => {
    await openApp(page, { micCheck: silent({ suggestion: BUILT_IN }) });
    await section(page, "Avanceret");
    const notice = page.getByTestId("mic-notice");
    await expect(notice).toHaveCount(1);
    await expect(notice).toHaveClass(/wt-row/);
    // Right under Handy's microphone selector.
    const selector = page.getByText("Mikrofon", { exact: true }).first();
    const [a, b] = await Promise.all([
      selector.boundingBox(),
      notice.boundingBox(),
    ]);
    expect(a && b && b.y > a.y).toBeTruthy();
    await expect(
      notice.getByRole("button", { name: `Brug ${BUILT_IN}` }),
    ).toBeVisible();
  });

  test("while looking it says so; when none works it says so, with Tjek igen", async ({
    page,
  }) => {
    await openApp(page, { micCheck: silent({ probing: true }) });
    const notice = page.getByTestId("mic-notice");
    await expect(notice).toHaveText(
      `${SCARLETT} giver ingen lyd. Leder efter en mikrofon, der virker.`,
    );
    await expect(notice.getByRole("button")).toHaveCount(0);

    await emit(page, "wt-mic-check", silent());
    await expect(notice).toContainText(
      `${SCARLETT} giver ingen lyd, og det gør de andre mikrofoner heller ikke.`,
    );
    await notice.getByRole("button", { name: "Tjek igen" }).click();
    await expect
      .poll(async () => (await calls(page, "wt_mic_recheck")).length)
      .toBe(1);
    await expect(notice).toContainText("Leder efter en mikrofon, der virker.");
  });

  test("appears after a silent take and clears once the input gives sound", async ({
    page,
  }) => {
    await openApp(page);
    const notice = page.getByTestId("mic-notice");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(notice).toHaveCount(0);

    await emit(page, "wt-mic-check", silent({ suggestion: BUILT_IN }));
    await expect(notice).toBeVisible();
    await emit(page, "wt-mic-check", {
      silent_input: null,
      suggestion: null,
      probing: false,
    });
    await expect(notice).toHaveCount(0);
  });
});
