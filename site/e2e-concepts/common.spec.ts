/* Run 8: what every final page must do in a browser (the owner's rules, SITE-06 as updated in run 8, spec 6.17): no
   errors and no sideways scroll on a phone; only one living background runs at a time, the most visible one; every
   production feature shows with its demo; the hero's words land at release; with reduced motion nothing loops and the
   stage stands finished; without JavaScript the page still reads in full. */
import { expect, test, type Page } from "@playwright/test";
import { PLANS, SHOWCASE, SHOWCASE_ORDER, TRY } from "../src/lib/features";
import {
  countDraws,
  endlessAnimations,
  runningBackgrounds,
  scrollThrough,
  shownOpacity,
  unmanagedBackgrounds,
} from "./helpers";

test("loads without errors and never scrolls sideways", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.goto("/");
  await scrollThrough(page);
  await page.waitForTimeout(400);
  expect(errors).toEqual([]);
  const overflow = await page.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});

test("runs one living background at a time, the most visible one, all the way down", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await countDraws(page);
  await page.goto("/");
  await page.waitForLoadState("load");
  await page.waitForTimeout(1200);
  expect(await unmanagedBackgrounds(page)).toEqual([]);
  /* at the top the hero's background is the one that may run (the BarField waits for the visitor) */
  const top = await runningBackgrounds(page);
  expect(top.length).toBeLessThanOrEqual(1);
  if (top.length) expect(top[0].top).toBeLessThan(200);
  const height = await page.evaluate(
    () => document.documentElement.scrollHeight - innerHeight,
  );
  const step = Math.round((page.viewportSize()!.height ?? 800) * 0.45);
  let seen = 0;
  for (let y = 0; y <= height + step; y += step) {
    await page.evaluate((y) => scrollTo(0, y), y);
    await page.waitForTimeout(350);
    const running = await runningBackgrounds(page);
    expect(
      running.length,
      `at ${y}px: ${running.map((r) => `${r.kind}@${r.top}`).join(", ")}`,
    ).toBeLessThanOrEqual(1);
    seen += running.length;
  }
  /* and the page does have living backgrounds below the hero */
  expect(seen).toBeGreaterThan(2);
});

test("shows every feature of the production front page with its demo", async ({
  page,
}) => {
  await page.goto("/");
  for (const key of SHOWCASE_ORDER) {
    const block = page.locator(`[data-showcase="${key}"]`);
    const title = block.getByText(SHOWCASE[key].title, { exact: true });
    await title.scrollIntoViewIfNeeded();
    await expect(title, key).toBeVisible();
    await expect(block.getByText(SHOWCASE[key].text), key).toBeVisible();
    const scene = block.locator(".wt-sc").first();
    await expect(scene, key).toBeVisible();
    /* the demo comes to life once it is in view */
    await expect(block.locator("astro-island[ssr]"), key).toHaveCount(0, {
      timeout: 8000,
    });
  }
});

/** Seeks the hero's sequence (the stage's own CSS animations) to p, 0 to 1, after the stage has come up. */
async function seekStage(page: Page, p: number) {
  await page.evaluate((p) => {
    const stage = document.querySelector("[data-stage]")!;
    for (const a of stage.getAnimations({ subtree: true })) {
      const name = (a as CSSAnimation).animationName ?? "";
      if (name === "fp-rise") a.finish();
      if (!name.startsWith("fp-seq")) continue;
      const t = a.effect!.getTiming();
      a.pause();
      a.currentTime = Number(t.delay ?? 0) + p * Number(t.duration);
    }
  }, p);
}

test("the hero's words land at release: nothing is written while fn is held (DESK-46)", async ({
  page,
}) => {
  await page.goto("/");
  const stage = page.locator("[data-stage]");
  const line = stage.locator("[data-stage-line]");
  const listening = stage.locator(".wt-pill--listening");
  const processing = stage.locator(".wt-pill--processing");
  const pasted = stage.locator(".wt-pill--pasted");
  const op = (l: typeof line) => l.evaluate(shownOpacity);

  for (const p of [0.2, 0.35, 0.5]) {
    await seekStage(page, p);
    expect(await op(listening), `listening at ${p}`).toBeGreaterThan(0.95);
    expect(await op(line), `no text while held (${p})`).toBeLessThan(0.05);
    expect(await op(pasted)).toBeLessThan(0.05);
  }
  await seekStage(page, 0.63);
  expect(await op(processing)).toBeGreaterThan(0.95);
  expect(await op(line), "no text while it cleans up").toBeLessThan(0.05);
  await seekStage(page, 1);
  expect(await op(line)).toBeGreaterThan(0.95);
  expect(await op(pasted)).toBeGreaterThan(0.95);
  expect(await op(listening)).toBeLessThan(0.05);
  await expect(pasted).toContainText("Indsat");
});

test("plays the hero's sequence once by itself, and ends with the text in place", async ({
  page,
}) => {
  await page.goto("/");
  const line = page.locator("[data-stage] [data-stage-line]");
  await expect
    .poll(() => line.evaluate(shownOpacity), { timeout: 15_000 })
    .toBeGreaterThan(0.95);
  expect(
    (await endlessAnimations(page)).filter((a) => a.startsWith("fp-seq")),
  ).toEqual([]);
});

test("getting started and the price respond: the permissions and the computer count", async ({
  page,
}) => {
  await page.goto("/");
  const free = page.locator('[data-feature="free"]');
  const count = free.locator("[data-count]");
  await count.scrollIntoViewIfNeeded();
  await expect(count).toHaveText(TRY.many.replace("{n}", "1.000"));
  await expect(free.locator("[data-price]")).toHaveText(PLANS.free.price);
  const range = free.locator('input[type="range"]');
  await range.focus();
  await page.keyboard.press("Home");
  await expect(count).toHaveText(TRY.one);
  await expect(free.locator("[data-price]")).toHaveText(PLANS.free.price);
  await page.keyboard.press("End");
  await expect(count).toHaveText(TRY.many.replace("{n}", "1.000"));

  const start = page.locator('[data-feature="start"]');
  const ready = start.locator("[data-ready-label]");
  await ready.scrollIntoViewIfNeeded();
  await expect(ready).toHaveText(TRY.waiting);
  for (const s of await start.locator('[role="switch"]').all()) {
    await s.click();
    await expect(s).toHaveAttribute("aria-checked", "true");
  }
  await expect(ready).toHaveText(TRY.ready);
});

test.describe("with reduced motion", () => {
  test.use({ reducedMotion: "reduce" });
  test("nothing loops, no canvas keeps drawing, and the stage stands finished", async ({
    page,
  }) => {
    await countDraws(page);
    await page.goto("/");
    await page.waitForLoadState("load");
    await page.waitForTimeout(1500);
    const line = page.locator("[data-stage] [data-stage-line]");
    expect(await line.evaluate(shownOpacity)).toBeGreaterThan(0.95);
    expect(
      await page
        .locator("[data-stage] .wt-pill--listening")
        .evaluate(shownOpacity),
    ).toBeLessThan(0.05);
    expect(await endlessAnimations(page)).toEqual([]);
    await scrollThrough(page);
    await page.waitForTimeout(600);
    expect(await endlessAnimations(page)).toEqual([]);
    expect(await runningBackgrounds(page, 700)).toEqual([]);
    /* the pointer moves nothing */
    await page.evaluate(() => scrollTo(0, 0));
    await page.mouse.move(300, 500);
    await page.mouse.move(700, 600, { steps: 8 });
    expect(await runningBackgrounds(page, 500)).toEqual([]);
  });
});

test.describe("without JavaScript", () => {
  test.use({ javaScriptEnabled: false });
  test("the hero paints, the stage lands, and every feature reads", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(page.locator("h1")).toBeVisible();
    await expect(page.locator("[data-stage] .wt-laptop")).toBeVisible();
    await expect
      .poll(
        () =>
          page.locator("[data-stage] [data-stage-line]").evaluate(shownOpacity),
        { timeout: 15_000 },
      )
      .toBeGreaterThan(0.95);
    for (const key of SHOWCASE_ORDER) {
      const title = page
        .locator(`[data-showcase="${key}"]`)
        .getByText(SHOWCASE[key].title, { exact: true });
      await title.scrollIntoViewIfNeeded();
      await expect(title, key).toBeVisible();
    }
  });
});
