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
