/* Run 6, concept A (editorial): Fig. 1, the one computer window, and the numbered list's inline demos.
   Words land at release (DESK-46, DESK-52): while fn is held the pill says "Lytter" and the window holds no text; the
   line lands the moment fn is let go. Without JavaScript or with reduced motion the window simply shows the landed
   line, and every inline demo stands in its final state. Out of sight, nothing on the page keeps moving. */
import { expect, test, type Locator, type Page } from "@playwright/test";
import { FEATURES, PRODUCT, SAMPLES, type FeatureKey } from "../src/lib/features";
import { conceptOf, endlessAnimations } from "./helpers";

test.beforeEach(({}, info) => {
  test.skip(conceptOf(info) !== "editorial", "concept A only");
});

/** The six product features of the numbered list, in the order they are numbered. */
const LISTED: FeatureKey[] = ["fn", "phone", "corrections", "mixed", "words", "notify"];

const opacity = (l: Locator) =>
  l.evaluate((el) => {
    let o = 1;
    for (let n: Element | null = el; n; n = n.parentElement) o *= Number(getComputedStyle(n).opacity);
    return o;
  });

async function plate(page: Page) {
  const fig = page.locator("[data-ed-plate]");
  await fig.scrollIntoViewIfNeeded();
  return {
    fig,
    line: fig.locator("[data-ed-line]"),
    listening: fig.locator(".wt-pill--listening"),
    pasted: fig.locator(".wt-pill--pasted"),
  };
}

test("the line lands at release, never while fn is held (DESK-46)", async ({ page }) => {
  await page.goto("/");
  const { fig, line, listening, pasted } = await plate(page);
  await expect(line).toHaveText(SAMPLES.mail);

  /* held: the pill listens, the mail is still empty, and stays empty for as long as fn is down */
  await expect(fig).toHaveAttribute("data-step", "held", { timeout: 10_000 });
  await expect(listening).toBeVisible();
  await expect(listening).toContainText(PRODUCT.listening);
  for (let i = 0; i < 4; i++) {
    if ((await fig.getAttribute("data-step")) !== "held") break;
    await expect(line).toBeHidden();
    await page.waitForTimeout(400);
  }

  /* released: the line is there at once, and the pill says it was pasted */
  await expect(fig).toHaveAttribute("data-step", "landed", { timeout: 6000 });
  await expect(line).toBeVisible();
  await expect.poll(() => opacity(line), { timeout: 1500 }).toBeGreaterThan(0.95);
  await expect(listening).toBeHidden();
  await expect(pasted).toBeVisible();
  await expect(pasted).toContainText(PRODUCT.pasted);
});

test("the fn key is down while it listens, and up when the line lands", async ({ page }) => {
  await page.goto("/");
  const { fig } = await plate(page);
  const key = fig.locator("[data-ed-key]");
  await expect(fig).toHaveAttribute("data-step", "held", { timeout: 10_000 });
  await expect(key).toHaveAttribute("data-down", "");
  await expect(fig).toHaveAttribute("data-step", "landed", { timeout: 6000 });
  await expect(key).not.toHaveAttribute("data-down", "");
});

test("rests out of sight: the window waits at the start, the backdrop stops drifting", async ({ page }) => {
  await page.goto("/");
  const { fig } = await plate(page);
  await expect(fig).toHaveAttribute("data-step", /idle|held|landed/);
  await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
  await expect(fig).toHaveAttribute("data-paused", "");
  await expect(fig).toHaveAttribute("data-step", "idle");
  await expect.poll(() => endlessAnimations(page)).toEqual([]);
});

test("numbers the six product features in order, each with its own small demo", async ({ page }) => {
  await page.goto("/");
  const items = page.locator("[data-ed-list] > li");
  await expect(items).toHaveCount(LISTED.length);
  for (const [i, key] of LISTED.entries()) {
    const item = items.nth(i);
    await expect(item).toHaveAttribute("data-feature", key);
    await expect(item.locator("[data-ed-num]")).toHaveText(String(i + 1).padStart(2, "0"));
    await expect(item.getByRole("heading", { level: 3 })).toHaveText(FEATURES[key].title);
    const demo = item.locator("[data-ed-demo]");
    await expect(demo).toHaveAttribute("role", "img");
    await expect(demo).toHaveAttribute("aria-label", /\S/);
  }
});

test("the inline demos end in their finished state once they are in view", async ({ page }) => {
  await page.goto("/");
  for (const key of LISTED) {
    const demo = page.locator(`[data-feature="${key}"] [data-ed-demo]`);
    await demo.scrollIntoViewIfNeeded();
    await expect(demo).toHaveClass(/\bed-in\b/, { timeout: 4000 });
  }
  /* the self-correction: the spoken detour is struck, and the written sentence stands */
  const fix = page.locator('[data-feature="corrections"] [data-ed-demo]');
  await expect.poll(() => opacity(fix.locator("[data-ed-written]")), { timeout: 4000 }).toBeGreaterThan(0.95);
  await expect(fix.locator("[data-ed-written]")).toHaveText(SAMPLES.correctionWritten);
});

for (const mode of ["reduced motion", "no JavaScript"] as const) {
  test.describe(`with ${mode}`, () => {
    test.use(mode === "reduced motion" ? { reducedMotion: "reduce" } : { javaScriptEnabled: false });

    test("the window shows the landed line, and every demo stands finished", async ({ page }) => {
      await page.goto("/");
      const { fig, line, listening, pasted } = await plate(page);
      await expect(fig).toHaveAttribute("data-step", "landed");
      await expect(line).toBeVisible();
      expect(await opacity(line)).toBeGreaterThan(0.95);
      await expect(listening).toBeHidden();
      await expect(pasted).toBeVisible();
      await page.waitForTimeout(1200);
      await expect(fig).toHaveAttribute("data-step", "landed");
      const written = page.locator('[data-feature="corrections"] [data-ed-written]');
      await written.scrollIntoViewIfNeeded();
      expect(await opacity(written)).toBeGreaterThan(0.95);
      const notice = page.locator('[data-feature="notify"] .wt-notice');
      await notice.scrollIntoViewIfNeeded();
      await expect(notice).toBeVisible();
      expect(await opacity(notice)).toBeGreaterThan(0.95);
    });
  });
}
