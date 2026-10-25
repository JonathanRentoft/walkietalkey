/* Run 6, concept B (product stage): the film. Every feature is a shot of the same laptop and phone, and the scroll is
   the timeline: while a shot passes, its stage plays hold, release and land on the shot's view timeline.
   Words land at release (DESK-46, DESK-52): while the phone's button or the fn key is held, the stage shows only what
   you say (a subtitle) and the laptop shows no dictated text; the text appears after release. Every shot stands
   finished once its stage has settled, and with reduced motion or without JavaScript it stands finished at once. Out
   of sight, the loops rest. */
import { expect, test, type Locator, type Page } from "@playwright/test";
import { FEATURES, PRODUCT, SAMPLES, type FeatureKey } from "../src/lib/features";
import { conceptOf, deviceOf, scrollThrough } from "./helpers";

test.beforeEach(({}, info) => {
  test.skip(conceptOf(info) !== "stage", "concept B only");
});

/** the film's shots, in the order they play (src/concepts/stage/scenes.ts) */
const FILM: FeatureKey[] = ["fn", "phone", "notify", "corrections", "mixed", "words"];

const opacity = (l: Locator) =>
  l.evaluate((el) => {
    let o = 1;
    for (let n: Element | null = el; n; n = n.parentElement) o *= Number(getComputedStyle(n).opacity);
    return o;
  });

const shot = (page: Page, key: FeatureKey) => page.locator(`[data-ps-shot][data-feature="${key}"]`);

/**
 * Scrolls to a point of a shot's sequence: 0 is its start, 1 its end (stage.css plays it from "entry 90%" to
 * "contain 75%" of the shot's view timeline); above 1 the stage rests finished while it is still pinned.
 */
async function seek(page: Page, key: FeatureKey, p: number) {
  await page.evaluate(
    ([key, p]) => {
      const el = document.querySelector<HTMLElement>(`[data-ps-shot][data-feature="${key}"]`)!;
      const top = el.getBoundingClientRect().top + scrollY;
      const v = innerHeight;
      const start = top - 0.1 * v;
      const end = top + 0.75 * (el.offsetHeight - v);
      scrollTo(0, start + (p as number) * (end - start));
    },
    [key, p] as const,
  );
  /* scroll-driven animations follow on the next frames (and without JavaScript there is no requestAnimationFrame) */
  await page.waitForTimeout(120);
}

const scrollDriven = (page: Page) => page.evaluate(() => CSS.supports("animation-timeline: view()"));

test("the phone records while the laptop stays empty; the text lands only after release (DESK-52)", async ({ page }) => {
  await page.goto("/");
  test.skip(!(await scrollDriven(page)), "the scroll timeline needs scroll-driven animations");
  const s = shot(page, "phone");
  const holding = s.locator(".ps-ph-say .ps-k-hold");
  const sending = s.locator(".ps-ph-say .ps-k-rel");
  const ready = s.locator(".ps-ph-say .ps-k-land");
  const rec = s.locator(".wt-app-rec");
  const notice = s.locator(".ps-notice");
  await expect(holding).toHaveText(PRODUCT.phoneRelease);
  await expect(ready).toHaveText(PRODUCT.phoneReady.replace("{computer}", "MacBook"));
  await expect(notice).toContainText(PRODUCT.ready);
  await expect(notice).toContainText(SAMPLES.phone);

  /* held: "Slip for at sende", the red dot and the meter; the computer shows nothing */
  for (const p of [0.15, 0.3, 0.45]) {
    await seek(page, "phone", p);
    await expect.poll(() => opacity(holding), { message: `hold ${p}` }).toBeGreaterThan(0.95);
    await expect.poll(() => opacity(rec), { message: `rec ${p}` }).toBeGreaterThan(0.95);
    expect(await opacity(notice), `no text while held (${p})`).toBeLessThan(0.05);
    expect(await opacity(ready)).toBeLessThan(0.05);
  }

  /* released: "Sender til MacBook", still nothing on the computer */
  await seek(page, "phone", 0.63);
  await expect.poll(() => opacity(sending)).toBeGreaterThan(0.95);
  expect(await opacity(holding)).toBeLessThan(0.05);
  expect(await opacity(notice)).toBeLessThan(0.05);

  /* landed: the notification on the computer, and "Klar på MacBook" on the phone */
  await seek(page, "phone", 1);
  await expect.poll(() => opacity(notice)).toBeGreaterThan(0.95);
  await expect.poll(() => opacity(ready)).toBeGreaterThan(0.95);
  expect(await opacity(rec)).toBeLessThan(0.05);
});

test("fn: nothing is written while the key is held; the line lands when it comes up (DESK-46)", async ({ page }) => {
  await page.goto("/");
  test.skip(!(await scrollDriven(page)), "the scroll timeline needs scroll-driven animations");
  const s = shot(page, "fn");
  const line = s.locator(".ps-line");
  const key = s.locator(".ps-key--fn .wt-keycap");
  const listening = s.locator(".wt-pill--listening");
  const pasted = s.locator(".wt-pill--pasted");
  const down = () => key.evaluate((el) => new DOMMatrix(getComputedStyle(el).transform).m42);
  await expect(line).toHaveText(SAMPLES.mail);

  await seek(page, "fn", 0.32);
  await expect.poll(() => opacity(listening)).toBeGreaterThan(0.95);
  await expect.poll(down).toBeGreaterThan(4);
  expect(await opacity(line), "no text while fn is held").toBeLessThan(0.05);
  await expect(s.locator(".ps-sub")).toContainText(SAMPLES.mail.split(" ")[0]);

  await seek(page, "fn", 1);
  await expect.poll(() => opacity(line)).toBeGreaterThan(0.95);
  await expect.poll(() => opacity(pasted)).toBeGreaterThan(0.95);
  await expect(pasted).toContainText(PRODUCT.pasted);
  expect(await down()).toBeLessThan(1);
});

test("every scene reaches its finished state while its stage is in view", async ({ page }) => {
  await page.goto("/");
  for (const key of FILM) {
    await seek(page, key, 1.15);
    const s = shot(page, key);
    await expect(s.locator(".ps-panel")).toBeInViewport({ ratio: 0.95 });
    for (const el of await s.locator(".ps-k-land, .ps-k-paste").all())
      await expect.poll(() => opacity(el), { message: `${key} landed` }).toBeGreaterThan(0.95);
    for (const el of await s.locator(".ps-k-hold, .ps-k-idle, .ps-k-rel").all())
      expect(await opacity(el), `${key}: only the finished state shows`).toBeLessThan(0.05);
  }
  /* the corrections shot keeps what you said next to what is written: torsdag, never onsdag */
  await expect(shot(page, "corrections").locator(".ps-line")).toHaveText(SAMPLES.correctionWritten);
  await expect(shot(page, "words").locator(".ps-line")).toHaveText(SAMPLES.wordsWritten);
});

for (const mode of ["reduced motion", "no JavaScript"] as const) {
  test.describe(`with ${mode}`, () => {
    test.use(mode === "reduced motion" ? { reducedMotion: "reduce" } : { javaScriptEnabled: false });
    test("every scene stands finished, and the page reads in full", async ({ page }) => {
      await page.goto("/");
      await expect(page.locator("h1")).toBeVisible();
      for (const key of FILM) {
        const s = shot(page, key);
        await s.locator(".ps-panel").scrollIntoViewIfNeeded();
        if (mode === "no JavaScript") await seek(page, key, 1.15);
        await expect(s.getByRole("heading", { name: FEATURES[key].title })).toBeVisible();
        for (const el of await s.locator(".ps-k-land, .ps-k-paste").all())
          await expect.poll(() => opacity(el), { message: `${key} landed` }).toBeGreaterThan(0.95);
        for (const el of await s.locator(".ps-k-hold, .ps-k-idle").all())
          expect(await opacity(el), `${key}`).toBeLessThan(0.05);
      }
    });
  });
}

test.describe("with reduced motion", () => {
  test.use({ reducedMotion: "reduce" });
  test("nothing is pinned, so the shots follow one another without extra scrolling", async ({ page }) => {
    await page.goto("/");
    for (const key of FILM) {
      const h = await shot(page, key).evaluate((el) => (el as HTMLElement).offsetHeight / innerHeight);
      expect(h, key).toBeLessThan(1.6);
    }
  });
});

test("rests out of sight: the hero's light stops drifting once it has scrolled away", async ({ page }) => {
  await page.goto("/");
  const hero = page.locator(".ps-hero");
  await expect(hero).not.toHaveAttribute("data-paused");
  const blob = hero.locator(".wt-blob").first();
  const state = () => blob.evaluate((el) => el.getAnimations().map((a) => a.playState).join());
  expect(await state()).toBe("running");
  await page.locator(".ps-faq").scrollIntoViewIfNeeded();
  await expect(hero).toHaveAttribute("data-paused", "");
  await expect.poll(state).toBe("paused");
  /* and the shots far out of view rest too */
  await expect(shot(page, "fn")).toHaveAttribute("data-paused", "");
});

test("the stage and its words never cover each other, all the way through each shot", async ({ page }, info) => {
  await page.goto("/");
  await scrollThrough(page);
  const mobile = deviceOf(info) === "mobile";
  for (const key of FILM) {
    for (const p of [0.2, 0.6, 1, 1.4, 1.8, 2.2]) {
      await seek(page, key, p);
      const s = shot(page, key);
      const panel = (await s.locator(".ps-panel").boundingBox())!;
      const copy = (await s.locator(".ps-copy-in").boundingBox())!;
      if (mobile) {
        expect(panel.y + panel.height, `${key} at ${p}: words under the stage`).toBeLessThanOrEqual(copy.y + 1);
      } else {
        expect(copy.x + copy.width, `${key} at ${p}: words beside the stage`).toBeLessThanOrEqual(panel.x + 1);
      }
    }
    /* while it is pinned, the words fit the screen */
    await seek(page, key, 1.15);
    const copy = (await shot(page, key).locator(".ps-copy-in").boundingBox())!;
    expect(copy.y + copy.height, `${key}: words fit the screen`).toBeLessThanOrEqual(page.viewportSize()!.height);
  }
});
