// The DictationPill in Handy's overlay window (DESK-24, DESK-55, 6.17).
import { expect, test, type Page } from "@playwright/test";
import { calls, emit, installMock, type MockOptions } from "./mock";

async function openPill(page: Page, options: MockOptions = {}) {
  await installMock(page, { window: "recording_overlay", ...options });
  await page.goto("/src/overlay/index.html");
}

test.describe("pill", () => {
  test("Lytter with the time, then Renskriver, then Indsat", async ({
    page,
  }) => {
    await openPill(page);
    await emit(page, "show-overlay", "recording");
    const pill = page.getByRole("status").filter({ hasText: "Lytter" });
    await expect(pill).toBeVisible();
    await expect(pill).toHaveAttribute("aria-live", "polite");
    await expect(page.getByText("0:00")).toBeVisible();
    await emit(page, "recording-ready");
    await emit(
      page,
      "mic-level",
      [0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.2, 0.1],
    );
    await expect(page.getByTestId("pill")).toHaveAttribute(
      "data-level",
      /0\.[1-9]/,
    );
    await expect(page.getByText("0:01")).toBeVisible({ timeout: 3000 });

    await emit(page, "show-overlay", "transcribing");
    await expect(page.getByText("Renskriver")).toBeVisible();

    await emit(page, "wt-pill-end", { state: "pasted", shortcut: "⌘V" });
    await expect(page.getByText("Indsat")).toBeVisible();
    // VoiceOver hears every state through a native announcement (6.17).
    await expect
      .poll(async () =>
        (await calls(page, "wt_announce")).map((c) => c.args.text),
      )
      .toEqual(["Lytter", "Renskriver", "Indsat"]);

    await emit(page, "hide-overlay");
    await expect(page.getByTestId("pill")).toBeHidden();
  });

  test("the mark and a live waveform from the microphone level", async ({
    page,
  }) => {
    await openPill(page);
    await emit(page, "show-overlay", "recording");
    const pill = page.locator(".wt-pill");
    await expect(pill).toHaveClass(/wt-pill--lg/);
    await expect(pill.locator(".wt-pill-mark")).toBeVisible();
    const bars = pill.locator(".wt-wave i");
    await expect(bars).toHaveCount(15);
    const heights = () =>
      bars.evaluateAll((els) =>
        els.map((el) =>
          Number((el as HTMLElement).style.getPropertyValue("--v")),
        ),
      );
    const quiet = Math.max(...(await heights()));
    for (let i = 0; i < 4; i++)
      await emit(page, "mic-level", Array(16).fill(0.9));
    await expect
      .poll(async () => Math.max(...(await heights())))
      .toBeGreaterThan(quiet + 0.3);
    // Silence falls back slowly to a calm row of dots.
    for (let i = 0; i < 20; i++)
      await emit(page, "mic-level", Array(16).fill(0));
    await expect
      .poll(async () => Math.max(...(await heights())))
      .toBeLessThan(0.2);
  });

  test("hands-free: a lock and Tryk igen for at stoppe (Phase 1)", async ({
    page,
  }) => {
    await openPill(page);
    await emit(page, "show-overlay", "recording");
    await emit(page, "recording-ready");
    await expect(page.getByText("Tryk igen for at stoppe")).toHaveCount(0);
    await emit(page, "wt-pill-handsfree", true);
    await expect(page.getByText("Tryk igen for at stoppe")).toBeVisible();
    await expect(page.getByTestId("pill")).toHaveAttribute(
      "data-handsfree",
      "true",
    );
    await expect(page.locator(".wt-pill-lock")).toBeVisible();
    await expect
      .poll(async () =>
        (await calls(page, "wt_announce")).map((c) => c.args.text),
      )
      .toContain("Lytter. Tryk igen for at stoppe");
    // The next tap ends it like any dictation.
    await emit(page, "show-overlay", "transcribing");
    await expect(page.getByText("Renskriver")).toBeVisible();
    await expect(page.getByText("Tryk igen for at stoppe")).toHaveCount(0);
    await emit(page, "wt-pill-end", { state: "pasted", shortcut: "⌘V" });
    await expect(page.getByText("Indsat")).toBeVisible();
    // A new dictation starts held, not hands-free.
    await emit(page, "show-overlay", "recording");
    await expect(page.getByText("Tryk igen for at stoppe")).toHaveCount(0);
  });

  test("the overlay window leaves room for the halo in every state", async ({
    page,
  }) => {
    // overlay.rs: OVERLAY_WIDTH x OVERLAY_HEIGHT.
    await page.setViewportSize({ width: 480, height: 120 });
    await openPill(page);
    const fits = async () => {
      const box = await page.locator(".wt-pill").boundingBox();
      expect(box).not.toBeNull();
      // The halo and shadow reach about 30 px past the pill.
      expect(box!.x).toBeGreaterThanOrEqual(30);
      expect(box!.y).toBeGreaterThanOrEqual(30);
      expect(box!.x + box!.width).toBeLessThanOrEqual(450);
      expect(box!.y + box!.height).toBeLessThanOrEqual(90);
    };
    await emit(page, "show-overlay", "recording");
    await emit(page, "wt-pill-handsfree", true);
    await page.waitForTimeout(600);
    await fits();
    await emit(page, "wt-pill-countdown", { seconds_left: 12 });
    await page.waitForTimeout(600);
    await fits();
    await emit(page, "show-overlay", "transcribing");
    await emit(page, "wt-pill-not-ready");
    await page.waitForTimeout(600);
    await fits();
    await emit(page, "wt-pill-end", { state: "clipboard", shortcut: "Ctrl+V" });
    await page.waitForTimeout(600);
    await fits();
  });

  test("the end states of Appendix A", async ({ page }) => {
    await openPill(page);
    await emit(page, "show-overlay", "recording");
    await emit(page, "wt-pill-end", { state: "clipboard", shortcut: "Ctrl+V" });
    await expect(page.getByText("Tekst klar til at indsætte")).toBeVisible();
    await expect(page.getByText("Ctrl+V")).toBeVisible();
    await emit(page, "wt-pill-end", { state: "no_speech", shortcut: "⌘V" });
    await expect(page.getByText("Hørte ikke noget")).toBeVisible();
    await emit(page, "wt-pill-end", {
      state: "cleanup_skipped",
      shortcut: "⌘V",
    });
    await expect(page.getByText("Brugte teksten uden oprydning")).toBeVisible();
  });

  test("the countdown from 4:45", async ({ page }) => {
    await openPill(page);
    await emit(page, "show-overlay", "recording");
    await emit(page, "wt-pill-countdown", { seconds_left: 15 });
    await expect(page.getByText("0:15")).toBeVisible();
    await expect(page.getByText("15 sekunder tilbage")).toBeAttached();
    await emit(page, "wt-pill-countdown", { seconds_left: 14 });
    await expect(page.getByText("0:14")).toBeVisible();
  });

  test("Vis aldrig keeps the pill hidden", async ({ page }) => {
    await openPill(page, { wt: { pill_hidden: true } });
    await emit(page, "show-overlay", "recording");
    await page.waitForTimeout(200);
    await expect(page.getByTestId("pill")).toBeHidden();
  });

  test("holding the key before the model is ready says so", async ({
    page,
  }) => {
    await openPill(page);
    await emit(page, "show-overlay", "transcribing");
    await emit(page, "wt-pill-not-ready");
    await expect(
      page.getByText("Talemodellen er ikke klar endnu"),
    ).toBeVisible();
  });
});
