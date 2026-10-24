// The silent-microphone states of the pill (DESK-59) fit the overlay window
// with room for the glow, like every other state (DESK-55, pill-glow.spec.ts).
// Named pill-glow-* so it runs in WebKit (the Mac's WKWebView) too.
import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { emit, installMock } from "./mock";

const geometry = readFileSync(
  new URL("../../src-tauri/src/walkietalkey/pill_window.rs", import.meta.url),
  "utf8",
);
const constant = (name: string) =>
  Number(new RegExp(`const ${name}: f64 = ([\\d.]+);`).exec(geometry)![1]);
const PILL_MAX_WIDTH = constant("PILL_MAX_WIDTH");
const GLOW_MARGIN = constant("GLOW_MARGIN");
const PILL_HEIGHT = constant("PILL_HEIGHT");

/** The pill keeps the glow margin and draws all its text inside itself. */
async function fits(page: Page) {
  // The pill's width eases to its content; measure the settled state.
  await page.waitForTimeout(1200);
  const box = (await page.locator(".wt-pill").boundingBox())!;
  expect(box.width).toBeLessThanOrEqual(PILL_MAX_WIDTH);
  expect(box.height).toBeLessThanOrEqual(PILL_HEIGHT + 0.5);
  expect(box.x).toBeGreaterThanOrEqual(GLOW_MARGIN - 0.5);
  expect(box.y).toBeGreaterThanOrEqual(GLOW_MARGIN - 0.5);
  const inside = await page
    .locator(".wt-pill-inner")
    .evaluate(
      (inner) =>
        inner.getBoundingClientRect().width <=
        inner.parentElement!.getBoundingClientRect().width + 0.5,
    );
  expect(inside).toBe(true);
}

test("the silent-microphone states fit the pill window (DESK-59, DESK-55)", async ({
  page,
}) => {
  await page.setViewportSize({
    width: PILL_MAX_WIDTH + 2 * GLOW_MARGIN,
    height: PILL_HEIGHT + 2 * GLOW_MARGIN,
  });
  await installMock(page, { window: "recording_overlay" });
  await page.goto("/src/overlay/index.html");
  // The pill measures its text when its state changes; a web font that
  // arrives later (a cold WebKit) would make that measure stale.
  await page.evaluate(() => document.fonts.ready.then(() => undefined));

  await emit(page, "show-overlay", "recording");
  await emit(page, "recording-ready");
  await emit(page, "wt-mic-silent", { silent: true });
  await expect(page.getByText("Mikrofonen giver ingen lyd")).toBeVisible();
  await fits(page);

  await emit(page, "wt-pill-handsfree", true);
  await emit(page, "wt-mic-silent", { silent: true });
  await fits(page);

  await emit(page, "wt-pill-end", { state: "mic_silent", shortcut: "⌘V" });
  await fits(page);

  // A long device name is cut short; the pill keeps its size.
  await emit(page, "wt-mic-check", {
    silent_input: "Scarlett Solo USB",
    suggestion: "Logitech BRIO 4K Stream Edition Webcam Microphone",
    probing: false,
  });
  await expect(page.locator(".wt-pill-note-hint")).toBeVisible();
  await fits(page);
});
