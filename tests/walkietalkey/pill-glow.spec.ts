// The pill's glow fits its window (run 4, DESK-55). The owner saw the glow cut
// off in a hard rectangle: the window was too small for it. Every pill state is
// drawn at the overlay window's size (src-tauri/src/walkietalkey/pill_window.rs)
// on a transparent page, in Chromium (WebView2 on Windows) and WebKit (WKWebView
// on the Mac, at 2x like a Retina display): the window's edge must stay fully
// transparent, so the glow fades out inside it. Light and dark desktops are
// attached to the report (and written to PILL_SCREENS_DIR when set).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { PNG } from "pngjs";
import { calls, emit, installMock } from "./mock";

const geometry = readFileSync(
  new URL("../../src-tauri/src/walkietalkey/pill_window.rs", import.meta.url),
  "utf8",
);
const constant = (name: string) =>
  Number(new RegExp(`const ${name}: f64 = ([\\d.]+);`).exec(geometry)![1]);
const PILL_MAX_WIDTH = constant("PILL_MAX_WIDTH");
const GLOW_MARGIN = constant("GLOW_MARGIN");
const WINDOW = {
  width: PILL_MAX_WIDTH + 2 * GLOW_MARGIN,
  height: constant("PILL_HEIGHT") + 2 * GLOW_MARGIN,
};
/** The ring at the window's edge that must be fully transparent, in CSS px. */
const EDGE = 2;

const loud = Array<number>(16).fill(0.95);
const STATES: [string, (page: Page) => Promise<void>][] = [
  [
    "listening",
    async (p) => {
      await emit(p, "show-overlay", "recording");
      await emit(p, "recording-ready");
      await emit(p, "mic-level", loud);
    },
  ],
  [
    "hands-free",
    async (p) => {
      await emit(p, "show-overlay", "recording");
      await emit(p, "recording-ready");
      await emit(p, "wt-pill-handsfree", true);
      await emit(p, "mic-level", loud);
    },
  ],
  [
    "countdown",
    async (p) => {
      await emit(p, "show-overlay", "recording");
      await emit(p, "wt-pill-handsfree", true);
      await emit(p, "wt-pill-countdown", { seconds_left: 12 });
    },
  ],
  [
    "processing",
    async (p) => {
      await emit(p, "show-overlay", "transcribing");
    },
  ],
  [
    "not ready",
    async (p) => {
      await emit(p, "show-overlay", "transcribing");
      await emit(p, "wt-pill-not-ready");
    },
  ],
  [
    "clipboard",
    async (p) => {
      await emit(p, "show-overlay", "transcribing");
      await emit(p, "wt-pill-end", { state: "clipboard", shortcut: "Ctrl+V" });
    },
  ],
  [
    "cleanup skipped",
    async (p) => {
      await emit(p, "show-overlay", "transcribing");
      await emit(p, "wt-pill-end", {
        state: "cleanup_skipped",
        shortcut: "⌘V",
      });
    },
  ],
  [
    "no speech",
    async (p) => {
      await emit(p, "show-overlay", "transcribing");
      await emit(p, "wt-pill-end", { state: "no_speech", shortcut: "⌘V" });
    },
  ],
];

/** A desktop-coloured picture of the window, the transparent pill composited on it. */
function onDesktop(pill: PNG, rgb: [number, number, number]): Buffer {
  const out = new PNG({ width: pill.width, height: pill.height });
  for (let i = 0; i < pill.data.length; i += 4) {
    const a = pill.data[i + 3]! / 255;
    for (let c = 0; c < 3; c++)
      out.data[i + c] = Math.round(pill.data[i + c]! * a + rgb[c]! * (1 - a));
    out.data[i + 3] = 255;
  }
  return PNG.sync.write(out);
}

test.describe("pill glow", () => {
  for (const [name, show] of STATES) {
    test(`${name}: the glow fades out inside the window`, async ({
      page,
      browserName,
    }, testInfo) => {
      await page.setViewportSize(WINDOW);
      await installMock(page, { window: "recording_overlay" });
      await page.goto("/src/overlay/index.html");
      await show(page);
      const pill = page.locator(".wt-pill");
      await expect(pill).toBeVisible();
      // The halo's inset and opacity ease in; draw the settled state.
      await page.waitForTimeout(1200);

      const box = (await pill.boundingBox())!;
      expect(box.width).toBeLessThanOrEqual(PILL_MAX_WIDTH);
      expect(box.x).toBeGreaterThanOrEqual(GLOW_MARGIN - 0.5);
      expect(box.y).toBeGreaterThanOrEqual(GLOW_MARGIN - 0.5);
      // The whole text fits: nothing is cut off inside the pill.
      const fits = await page
        .locator(".wt-pill-inner")
        .evaluate(
          (inner) =>
            inner.getBoundingClientRect().width <=
            inner.parentElement!.getBoundingClientRect().width + 0.5,
        );
      expect(fits).toBe(true);

      const shot = PNG.sync.read(
        await page.screenshot({ omitBackground: true }),
      );
      const scale = shot.width / WINDOW.width;
      const ring = Math.round(EDGE * scale);
      let edgeAlpha = 0;
      for (let y = 0; y < shot.height; y++)
        for (let x = 0; x < shot.width; x++) {
          const inside =
            x >= ring &&
            y >= ring &&
            x < shot.width - ring &&
            y < shot.height - ring;
          if (!inside)
            edgeAlpha = Math.max(
              edgeAlpha,
              shot.data[(y * shot.width + x) * 4 + 3]!,
            );
        }
      expect(edgeAlpha, "alpha at the window's edge").toBe(0);

      // The backend learns where the pill is, for the click-through.
      await expect
        .poll(async () => (await calls(page, "wt_pill_rect")).length)
        .toBeGreaterThan(0);
      const rect = (await calls(page, "wt_pill_rect")).at(-1)!.args.rect;
      expect(rect.x).toBeCloseTo(box.x, 0);
      expect(rect.width).toBeCloseTo(box.width, 0);

      const slug = `${name.replace(/ /g, "-")}-${browserName}`;
      const desktops: [string, [number, number, number]][] = [
        ["light", [236, 236, 232]],
        ["dark", [28, 28, 30]],
      ];
      for (const [tone, rgb] of desktops) {
        const png = onDesktop(shot, rgb);
        await testInfo.attach(`${slug}-${tone}.png`, {
          body: png,
          contentType: "image/png",
        });
        const dir = process.env.PILL_SCREENS_DIR;
        if (dir) {
          mkdirSync(dir, { recursive: true });
          writeFileSync(join(dir, `${slug}-${tone}.png`), png);
        }
      }
    });
  }
});
