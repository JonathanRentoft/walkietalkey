/* Run 6, concept C (hands-on): the hero toy and the bento's demos in a browser. Hold Space (or fn, if the browser
   reports it), and the pill listens over a note that is still empty; at release the next sample lands at once and
   the pill says "Indsat" (DESK-46, DESK-55). Without JavaScript the hero shows that finished example instead. A tap under 300 ms dictates nothing (DESK-26), Esc cancels (DESK-25). On a
   phone the big button does the same with a real touch. The tiles react: the phone sends to the computer you sit at,
   AI-oprydning flips, the word list spells your name, and so on. Runs only for the hands-on projects. */
import { expect, test, type Page } from "@playwright/test";
import { PLANS, SAMPLES } from "../src/lib/features";
import { HO } from "../src/concepts/hands-on/copy";
import { conceptOf, deviceOf, endlessAnimations } from "./helpers";

test.beforeEach(({}, info) => {
  test.skip(conceptOf(info) !== "hands-on", "concept C only");
});

const doc = (page: Page) => page.locator("[data-doc]");
const lines = (page: Page) => page.locator("[data-doc] .ho-line");
const dock = (page: Page) => page.locator("[data-dock]");
const pill = (page: Page) => page.locator("[data-dock] .wt-pill");
const shown = (page: Page) => dock(page).evaluate((el) => el.hasAttribute("data-show"));

/** The page as a visitor finds it with JavaScript: an empty note with the hint as its placeholder, no pill. */
async function ready(page: Page) {
  await page.goto("/");
  await expect(page.locator("[data-placeholder]")).toBeVisible();
  await expect(lines(page)).toHaveCount(0);
  await expect(doc(page)).not.toContainText(SAMPLES.first);
  expect(await shown(page)).toBe(false);
}

test.describe("the toy, with a keyboard", () => {
  test.beforeEach(({}, info) => {
    test.skip(deviceOf(info) !== "desktop", "keyboard on a computer");
  });

  test("holding Space listens, and the sentence lands only at release", async ({ page }) => {
    await ready(page);
    await page.keyboard.down("Space");
    await expect(pill(page)).toHaveClass(/wt-pill--listening/);
    await expect(pill(page)).toBeVisible();
    await expect(pill(page)).toContainText("Lytter");
    await expect.poll(() => shown(page)).toBe(true);
    await expect(page.locator("[data-slogan]")).toHaveAttribute("data-at", "hold");
    await page.waitForTimeout(800);
    /* nothing is written while you hold: the note is still empty, and Space did not scroll the page */
    await expect(lines(page)).toHaveCount(0);
    await expect(doc(page)).not.toContainText(SAMPLES.first);
    expect(await page.evaluate(() => scrollY)).toBe(0);

    await page.keyboard.up("Space");
    await expect(pill(page)).toContainText("Renskriver");
    await expect(doc(page)).toContainText(SAMPLES.first);
    await expect(lines(page)).toHaveCount(1);
    await expect(page.locator("[data-placeholder]")).toHaveCount(0);
    await expect(pill(page)).toContainText("Indsat");
    await expect(page.locator("[data-live]").first()).toContainText(SAMPLES.first);
    /* the pill hides about 1.5 s after the end */
    await expect.poll(() => shown(page), { timeout: 3500 }).toBe(false);

    /* the next hold dictates the next sample */
    await page.keyboard.down("Space");
    await page.waitForTimeout(450);
    await page.keyboard.up("Space");
    await expect(doc(page)).toContainText(SAMPLES.mail);
    await expect(lines(page)).toHaveCount(2);
  });

  test("a tap under 300 ms dictates nothing, with a gentle hint to hold", async ({ page }) => {
    await ready(page);
    await page.keyboard.down("Space");
    await page.waitForTimeout(90);
    await page.keyboard.up("Space");
    await expect(page.locator("[data-msg]")).toHaveText(HO.hero.short);
    await page.waitForTimeout(1200);
    await expect(lines(page)).toHaveCount(0);
    await expect(page.locator("[data-placeholder]")).toBeVisible();
    expect(await shown(page)).toBe(false);
  });

  test("Esc while holding cancels, and nothing is written", async ({ page }) => {
    await ready(page);
    await page.keyboard.down("Space");
    await page.waitForTimeout(600);
    await page.keyboard.press("Escape");
    await page.keyboard.up("Space");
    await expect(page.locator("[data-msg]")).toHaveText(HO.hero.cancelled);
    await page.waitForTimeout(1200);
    await expect(lines(page)).toHaveCount(0);
    expect(await shown(page)).toBe(false);
  });

  test("the fn key works the moment a browser reports it, and the hint says so", async ({ page }) => {
    await ready(page);
    await expect(page.locator("[data-keyname]")).toHaveText([HO.hero.keySpace, HO.hero.keySpace]);
    await page.evaluate(() => dispatchEvent(new KeyboardEvent("keydown", { key: "Fn", code: "Fn" })));
    await expect(page.locator("[data-keyname]")).toHaveText([HO.hero.keyFn, HO.hero.keyFn]);
    await expect(pill(page)).toHaveClass(/wt-pill--listening/);
    await page.waitForTimeout(450);
    await page.evaluate(() => dispatchEvent(new KeyboardEvent("keyup", { key: "Fn", code: "Fn" })));
    await expect(doc(page)).toContainText(SAMPLES.first);
  });

  test("the button works from the keyboard, and Space still types in a text field", async ({ page }) => {
    await ready(page);
    await page.locator("[data-hold]").focus();
    await page.keyboard.down("Enter");
    await page.waitForTimeout(450);
    await page.keyboard.up("Enter");
    await expect(doc(page)).toContainText(SAMPLES.first);

    const input = page.locator("#ho-word");
    await input.focus();
    await page.keyboard.type("Mette Holm");
    await expect(input).toHaveValue("Mette Holm");
    await page.waitForTimeout(1600);
    await expect(lines(page)).toHaveCount(1);
  });

  test("Space belongs to the page again once the toy is out of sight", async ({ page }) => {
    await ready(page);
    await page.locator('[data-feature="mixed"]').scrollIntoViewIfNeeded();
    const y = await page.evaluate(() => scrollY);
    await page.keyboard.down("Space");
    await page.waitForTimeout(500);
    await page.keyboard.up("Space");
    await page.waitForTimeout(800);
    await expect(lines(page)).toHaveCount(0);
    expect(await page.evaluate(() => scrollY)).toBeGreaterThan(y);
  });
});

test.describe("with reduced motion", () => {
  test.use({ reducedMotion: "reduce" });
  test("the toy still works, and nothing loops while it listens", async ({ page }, info) => {
    test.skip(deviceOf(info) !== "desktop", "keyboard on a computer");
    await ready(page);
    await page.keyboard.down("Space");
    await expect(pill(page)).toHaveClass(/wt-pill--listening/);
    await page.waitForTimeout(500);
    expect(await endlessAnimations(page)).toEqual([]);
    await expect(lines(page)).toHaveCount(0);
    await page.keyboard.up("Space");
    await expect(doc(page)).toContainText(SAMPLES.first);
    await expect(pill(page)).toContainText("Indsat");
  });
});

test.describe("without JavaScript", () => {
  test.use({ javaScriptEnabled: false });
  test("the hero shows the finished example: the sentence in the note, the pill on Indsat", async ({ page }) => {
    await page.goto("/");
    await expect(lines(page)).toHaveCount(1);
    await expect(doc(page)).toContainText(SAMPLES.first);
    await expect(pill(page)).toBeVisible();
    await expect(pill(page)).toContainText("Indsat");
    await expect(page.locator("[data-placeholder]")).toBeHidden();
  });
});

test.describe("the toy, on a phone", () => {
  test.beforeEach(({}, info) => {
    test.skip(deviceOf(info) !== "mobile", "touch on a phone");
  });

  async function touch(page: Page, ms: number) {
    const box = (await page.locator("[data-hold]").boundingBox())!;
    const pt = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [pt] });
    await page.waitForTimeout(ms);
    const during = { listening: await pill(page).getAttribute("class"), lines: await lines(page).count() };
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    return during;
  }

  test("the big button is thumb-sized and in the first screen", async ({ page }) => {
    await ready(page);
    const box = (await page.locator(".ho-hold-cap").boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(88);
    expect(box.y + box.height).toBeLessThanOrEqual(page.viewportSize()!.height);
  });

  test("holding the button dictates at release; a short tap does not", async ({ page }) => {
    await ready(page);
    const during = await touch(page, 700);
    expect(during.listening).toMatch(/wt-pill--listening/);
    expect(during.lines).toBe(0);
    await expect(doc(page)).toContainText(SAMPLES.first);
    await expect(lines(page)).toHaveCount(1);
    await expect(pill(page)).toContainText("Indsat");
    await expect.poll(() => shown(page), { timeout: 3500 }).toBe(false);

    await touch(page, 80);
    await page.waitForTimeout(1200);
    await expect(lines(page)).toHaveCount(1);
    await expect(page.locator("[data-msg]")).toHaveText(HO.hero.short);
  });
});

test.describe("the bento's demos react", () => {
  test("the phone sends to the computer you sit at, and only there", async ({ page }) => {
    await page.goto("/");
    const phone = page.locator("[data-phone]");
    const label = phone.locator(".wt-app-label");
    const btn = phone.locator(".wt-app-btn");
    const [mac, pc] = HO.notify.computers;
    await btn.scrollIntoViewIfNeeded();
    await expect(label).toContainText("Hold for at tale");
    await btn.dispatchEvent("pointerdown", { button: 0, pointerId: 7, isPrimary: true });
    await expect(label).toContainText("Slip for at sende");
    await page.waitForTimeout(500);
    await btn.dispatchEvent("pointerup", { button: 0, pointerId: 7, isPrimary: true });
    await expect(label).toContainText(`Sender til ${mac}`);
    await expect(label).toContainText(`Klar på ${mac}`);
    const notices = page.locator("[data-notify] .wt-notice");
    await expect(notices.nth(0)).toHaveClass(/wt-notice--in/);
    await expect(notices.nth(0)).toContainText(SAMPLES.phone);
    await expect(notices.nth(1)).not.toHaveClass(/wt-notice--in/);

    /* sit down at the other computer: the text goes there, the phone says so */
    await page.getByRole("button", { name: `Sæt dig ved ${pc}` }).click();
    await expect(notices.nth(1)).toHaveClass(/wt-notice--in/);
    await expect(notices.nth(0)).not.toHaveClass(/wt-notice--in/);
    await expect(page.locator("[data-notify] .ho-comp-hit").nth(1)).toHaveAttribute("aria-pressed", "true");
    await expect(phone.locator(".wt-app-dev")).toContainText(pc);
  });

  test("AI-oprydning flips the self-correction", async ({ page }) => {
    await page.goto("/");
    const tile = page.locator("[data-corr]");
    const sw = tile.getByRole("switch", { name: "AI-oprydning" });
    const gone = tile.locator("[data-cut]");
    await sw.scrollIntoViewIfNeeded();
    await expect(sw).toHaveAttribute("aria-checked", "true");
    expect((await gone.boundingBox())?.width ?? 0).toBeLessThan(1);
    await sw.click();
    await expect(sw).toHaveAttribute("aria-checked", "false");
    await expect.poll(async () => (await gone.boundingBox())?.width ?? 0).toBeGreaterThan(20);
    await expect(gone).toHaveAttribute("aria-hidden", "false");
    await sw.click();
    await expect(sw).toHaveAttribute("aria-checked", "true");
  });

  test("the word list spells a new name your way", async ({ page }) => {
    await page.goto("/");
    const tile = page.locator("[data-words]");
    const input = tile.getByLabel(HO.words.label);
    await input.scrollIntoViewIfNeeded();
    await input.fill("Søren Kjærsgaard");
    await expect(tile.locator("[data-hit]")).toHaveText("Søren Kjærsgaard");
    await expect(tile.locator("[data-said]")).toContainText("søren kjærsgaard");
    await input.press("Enter");
    await expect(tile.locator(".ho-chip").first()).toHaveText("Søren Kjærsgaard");
    await expect(input).toHaveValue("");
  });

  test("picking a program, an English word, a new recording and the price", async ({ page }) => {
    await page.goto("/");
    const apps = page.locator("[data-apps]");
    await apps.scrollIntoViewIfNeeded();
    await apps.getByRole("button", { name: "Kode" }).click();
    await expect(apps.locator('[data-pane="3"]')).toBeVisible();
    await expect(apps.locator('[data-pane="0"]')).toBeHidden();

    const mixed = page.locator("[data-mixed]");
    await mixed.getByRole("button", { name: "deploy" }).click();
    await expect(mixed.locator('mark[data-w="deploy"]')).toHaveAttribute("data-on", "");
    await expect(mixed.locator('mark[data-w="merge"]')).not.toHaveAttribute("data-on", "");

    const priv = page.locator("[data-privacy]");
    const noise = await priv.locator("[data-noise]").textContent();
    await priv.getByRole("button", { name: HO.privacy.again }).click();
    await expect(priv.locator("[data-plain]")).toHaveText(SAMPLES.mail);
    expect(await priv.locator("[data-noise]").textContent()).not.toBe(noise);

    const free = page.locator("[data-free]");
    await free.locator("[data-range]").scrollIntoViewIfNeeded();
    await free.locator("[data-range]").fill("9");
    await expect(free.locator("[data-count]")).toContainText("1.000 computere");
    await expect(free.locator("[data-price]")).toHaveText(PLANS.free.price);
    await expect(free.locator("[data-help]")).toHaveAttribute("data-lit", "");
  });

  test("the two permissions make the third step ready", async ({ page }) => {
    await page.goto("/");
    const start = page.locator("[data-start]");
    const perms = start.getByRole("switch");
    await perms.first().scrollIntoViewIfNeeded();
    await expect(start.locator("[data-final]")).not.toHaveAttribute("data-ready", "");
    await perms.nth(0).click();
    await perms.nth(1).click();
    await expect(start.locator("[data-final]")).toHaveAttribute("data-ready", "");
    await expect(start.locator("[data-ready-label]")).toHaveText(HO.start.ready);
  });
});
