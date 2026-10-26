/* Run 8: what one final page does that the others do not. Page 2's BarField stands still until the visitor moves
   the pointer, touches or scrolls, responds, and settles back to still. Pages 1 and 3 run their WebGL hero while it
   is the most visible background, and pages 1 and 2 hand over to FluidMesh in Nat further down. */
import { expect, test, type Page } from "@playwright/test";
import { conceptOf, countDraws, deviceOf, runningBackgrounds } from "./helpers";

/** the hero's bars: their inline transforms (empty at rest) */
const bars = (page: Page) =>
  page.evaluate(() =>
    [
      ...document.querySelectorAll<HTMLElement>('[data-section="hero"] .wt-bf'),
    ].map((b) => b.style.transform),
  );
const hydrated = (page: Page) =>
  expect(page.locator('[data-section="hero"] astro-island[ssr]')).toHaveCount(
    0,
    { timeout: 8000 },
  );

test.describe("page 2: BarField", () => {
  test.beforeEach(({}, info) => {
    test.skip(conceptOf(info) !== "bars", "page 2 only");
  });

  test("has 40 bars that stand still until the pointer moves, rise near it, and settle back to still", async ({
    page,
  }, info) => {
    test.skip(deviceOf(info) === "mobile", "a pointer that hovers");
    await page.goto("/");
    await hydrated(page);
    await expect(page.locator('[data-section="hero"] .wt-bf')).toHaveCount(40);
    await page.waitForTimeout(800);
    const rest = await bars(page);
    expect(rest.every((t) => t === "")).toBe(true);
    await page.waitForTimeout(800);
    expect(await bars(page)).toEqual(rest);
    expect(await runningBackgrounds(page)).toEqual([]);

    /* the pointer crosses the hero: the bars near it rise */
    const box = (await page
      .locator('[data-section="hero"] .wt-barfield')
      .boundingBox())!;
    await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.7);
    await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.7, {
      steps: 6,
    });
    await page.waitForTimeout(220);
    const lifted = await bars(page);
    const scale = (t: string) => Number(/scaleY\(([\d.]+)\)/.exec(t)?.[1] ?? 0);
    const n = lifted.length;
    const near = scale(lifted[Math.round(n * 0.3)]);
    const far = scale(lifted[Math.round(n * 0.85)]);
    expect(near).toBeGreaterThan(far + 0.1);

    /* no more input: still again */
    await expect.poll(() => bars(page), { timeout: 5000 }).toEqual(rest);
    await page.waitForTimeout(600);
    expect(await bars(page)).toEqual(rest);
  });

  test("sends a wave through the bars when the page scrolls, then rests", async ({
    page,
  }) => {
    await page.goto("/");
    await hydrated(page);
    await page.waitForTimeout(500);
    expect((await bars(page)).every((t) => t === "")).toBe(true);
    await expect(
      page.locator('[data-section="hero"] [data-fp-bg]'),
    ).not.toHaveAttribute("data-paused", "");
    await page.evaluate(() => scrollBy(0, 160));
    await expect
      .poll(async () => (await bars(page)).some((t) => t !== ""), {
        timeout: 2000,
        intervals: [50],
      })
      .toBe(true);
    await expect
      .poll(async () => (await bars(page)).every((t) => t === ""), {
        timeout: 5000,
      })
      .toBe(true);
  });

  test("responds to a touch on a phone", async ({ page }, info) => {
    test.skip(deviceOf(info) !== "mobile", "touch");
    await page.goto("/");
    await hydrated(page);
    await page.waitForTimeout(500);
    const box = (await page
      .locator('[data-section="hero"] .wt-barfield')
      .boundingBox())!;
    await page.touchscreen.tap(
      box.x + box.width * 0.5,
      box.y + box.height * 0.85,
    );
    await expect
      .poll(async () => (await bars(page)).some((t) => t !== ""), {
        timeout: 2000,
        intervals: [50],
      })
      .toBe(true);
  });

  test.describe("with reduced motion", () => {
    test.use({ reducedMotion: "reduce" });
    test("the bars never move", async ({ page }) => {
      await page.goto("/");
      await hydrated(page);
      await page.mouse.move(200, 600);
      await page.mouse.move(500, 650, { steps: 6 });
      await page.evaluate(() => scrollBy(0, 160));
      await page.waitForTimeout(200);
      expect((await bars(page)).every((t) => t === "")).toBe(true);
    });
  });
});

test.describe("the WebGL backgrounds", () => {
  test("the hero's canvas runs at the top, and hands over to FluidMesh in Nat further down", async ({
    page,
  }, info) => {
    const c = conceptOf(info);
    await countDraws(page);
    await page.goto("/");
    await page.waitForLoadState("load");
    await hydrated(page);
    await page.waitForTimeout(600);
    const want = c === "bars" ? [] : [c === "waves" ? "waves" : "mesh"];
    await expect
      .poll(async () => (await runningBackgrounds(page)).map((r) => r.kind), {
        timeout: 6000,
      })
      .toEqual(want);

    if (c === "metal") return;
    /* the section with FluidMesh in Nat, outside the hero */
    const mesh = page.locator('[data-fp-bg="mesh"]').last();
    await mesh.scrollIntoViewIfNeeded();
    await page.evaluate(() => scrollBy(0, innerHeight * 0.25));
    await expect(mesh.locator("astro-island[ssr]")).toHaveCount(0, {
      timeout: 8000,
    });
    await expect
      .poll(async () => (await runningBackgrounds(page)).map((r) => r.kind), {
        timeout: 5000,
      })
      .toEqual(["mesh"]);
  });
});
