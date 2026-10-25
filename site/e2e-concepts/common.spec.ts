/* Run 6: what every concept must do in a browser (SITE-06, spec 6.17, the brief): no errors, no sideways scroll on a
   phone, every feature readable once it is in view, and with reduced motion nothing loops and nothing is hidden. */
import { expect, test } from "@playwright/test";
import { FEATURE_ORDER, FEATURES } from "../src/lib/features";
import { endlessAnimations, scrollThrough } from "./helpers";

test("loads without errors and never scrolls sideways", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.goto("/");
  await scrollThrough(page);
  expect(errors).toEqual([]);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});

test("shows every feature's title once it is in view", async ({ page }) => {
  await page.goto("/");
  for (const key of FEATURE_ORDER) {
    const title = page
      .locator(`[data-feature="${key}"]`)
      .getByText(FEATURES[key].title, { exact: false })
      .first();
    await title.scrollIntoViewIfNeeded();
    await expect(title, key).toBeVisible();
    await expect
      .poll(
        () =>
          title.evaluate((el) => {
            let o = 1;
            for (let n: Element | null = el; n; n = n.parentElement)
              o *= Number(getComputedStyle(n).opacity);
            return o;
          }),
        { message: key, timeout: 4000 },
      )
      .toBeGreaterThan(0.95);
  }
});

test.describe("with reduced motion", () => {
  test.use({ reducedMotion: "reduce" });
  test("nothing loops, and every feature stands there from the start", async ({ page }) => {
    await page.goto("/");
    await page.waitForTimeout(500);
    expect(await endlessAnimations(page)).toEqual([]);
    await scrollThrough(page);
    expect(await endlessAnimations(page)).toEqual([]);
    for (const key of FEATURE_ORDER) {
      const title = page
        .locator(`[data-feature="${key}"]`)
        .getByText(FEATURES[key].title, { exact: false })
        .first();
      await title.scrollIntoViewIfNeeded();
      const opacity = await title.evaluate((el) => {
        let o = 1;
        for (let n: Element | null = el; n; n = n.parentElement)
          o *= Number(getComputedStyle(n).opacity);
        return o;
      });
      expect(opacity, key).toBeGreaterThan(0.95);
    }
  });
});
