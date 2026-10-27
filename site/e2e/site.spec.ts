/* The built site in a real browser: SITE-02, SITE-04, SITE-06, SITE-08, 6.17. The front page: e2e/front.spec.ts. */
import { expect, test, type Page } from "@playwright/test";
import jsQR from "jsqr";
import { PNG } from "pngjs";
import {
  ALL_RELEASES_URL,
  MAC_DOWNLOAD_URL,
  PAGES,
  PHONE_APP_URL,
  WINDOWS_DOWNLOAD_URL,
} from "../src/lib/site";

const ALL = Object.values(PAGES);

/** counts WebGL contexts and remembers every request that leaves the origin */
async function watch(page: Page) {
  const foreign: string[] = [];
  const errors: string[] = [];
  page.on("request", (r) => {
    const u = new URL(r.url());
    if (
      !["localhost", "127.0.0.1"].includes(u.hostname) &&
      !r.url().startsWith(test.info().project.use.baseURL ?? "") &&
      u.protocol !== "data:"
    )
      foreign.push(r.url());
  });
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  await page.addInitScript(() => {
    const w = window as unknown as { __gl: number };
    w.__gl = 0;
    const orig = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (
      this: HTMLCanvasElement,
      kind: string,
      ...rest: unknown[]
    ) {
      const ctx = (orig as (...a: unknown[]) => unknown).call(
        this,
        kind,
        ...rest,
      );
      if (
        ctx &&
        /webgl/.test(kind) &&
        !(this as unknown as { __counted?: boolean }).__counted
      ) {
        (this as unknown as { __counted: boolean }).__counted = true;
        w.__gl += 1;
      }
      return ctx;
    } as typeof orig;
  });
  return { foreign, errors };
}

/** scrolls through the page so every client:visible island hydrates */
async function scrollThrough(page: Page) {
  await page.evaluate(async () => {
    for (let y = 0; y < document.body.scrollHeight; y += 500) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 60));
    }
    window.scrollTo(0, 0);
  });
  await page.waitForTimeout(400);
}

for (const p of ALL) {
  test(`${p.path} answers 200 without cookies or third parties`, async ({
    page,
    context,
  }) => {
    const w = await watch(page);
    const res = await page.goto(p.path);
    expect(res!.status()).toBe(200);
    expect(res!.headers()["set-cookie"]).toBeUndefined();
    expect(res!.headers()["content-security-policy"]).toContain(
      "default-src 'self'",
    );
    await expect(page).toHaveTitle(p.title);
    await expect(page.locator("html")).toHaveAttribute("lang", "da");
    await scrollThrough(page);
    expect(await page.evaluate(() => document.cookie)).toBe("");
    expect(await context.cookies()).toEqual([]);
    expect(w.foreign).toEqual([]);
    expect(w.errors).toEqual([]);
    expect(
      await page.evaluate(() => (window as unknown as { __gl: number }).__gl),
    ).toBeLessThanOrEqual(1);
    /* no sideways scrolling on a phone (or anywhere) */
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      ),
    ).toBeLessThanOrEqual(0);
  });
}

test("the footer reaches every page", async ({ page }) => {
  for (const p of ALL) {
    await page.goto("/");
    await page
      .locator("footer")
      .getByRole("link", { name: p.nav, exact: true })
      .click();
    await expect(page).toHaveURL(
      new RegExp(p.path === "/" ? "/$" : p.path + "$"),
    );
    await expect(page).toHaveTitle(p.title);
  }
});

/* The front page's own checks (the hero, the rows, the backgrounds, reduced motion) are in e2e/front.spec.ts. */

/* SITE-02, run 2 Phase 7.4: the visitor's own download first and largest, the other one small, phones to the phone app. */
const AGENTS = {
  mac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15",
  win: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
  iphone:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1",
  android:
    "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36",
  linux:
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
} as const;
const DOWNLOAD = { mac: MAC_DOWNLOAD_URL, win: WINDOWS_DOWNLOAD_URL } as const;
/* a computer: no touch, so the mobile project's Pixel 7 settings do not turn a Mac into an iPad */
const COMPUTER = { isMobile: false, hasTouch: false } as const;

for (const os of ["mac", "win"] as const) {
  test(`Hent shows a ${os} visitor that download first and largest, the other small`, async ({
    browser,
  }) => {
    const ctx = await browser.newContext({
      ...COMPUTER,
      userAgent: AGENTS[os],
    });
    const page = await ctx.newPage();
    await page.goto("/hent");
    const other = os === "mac" ? "win" : "mac";
    const hero = page.locator("header .get");
    const main = hero.locator(`[data-platform="${os}"] a.wt-shiny`);
    await expect(main).toBeVisible();
    await expect(main).toHaveAttribute("href", DOWNLOAD[os]);
    await expect(hero.locator(`[data-platform="${other}"]`)).toBeHidden();
    await expect(hero.locator('[data-platform="phone"]')).toBeHidden();
    const alt = hero.locator(`.get-alt[data-for="${os}"] a`);
    await expect(alt).toBeVisible();
    await expect(alt).toHaveAttribute("href", DOWNLOAD[other]);
    const [big, small] = await Promise.all([
      main.boundingBox(),
      alt.boundingBox(),
    ]);
    expect(big!.height).toBeGreaterThan(small!.height * 1.8);
    expect(big!.y).toBeLessThan(small!.y);
    /* the first-open card for this computer comes first, and the other is still there */
    const cards = page.locator(".platforms [data-platform]");
    const first = await cards.evaluateAll(
      (els) =>
        els
          .map((e) => [
            e.getAttribute("data-platform"),
            e.getBoundingClientRect().top,
            e.getBoundingClientRect().left,
          ])
          .sort((a, b) =>
            a[1] === b[1]
              ? (a[2] as number) - (b[2] as number)
              : (a[1] as number) - (b[1] as number),
          )[0][0],
    );
    expect(first).toBe(os);
    await expect(
      page.locator(`.platforms [data-platform="${other}"] a.wt-shiny`),
    ).toBeVisible();
    const [cardsBox, phoneBox] = await Promise.all([
      page.locator(".platforms").boundingBox(),
      page.locator(".phone-get").boundingBox(),
    ]);
    expect(cardsBox!.y).toBeLessThan(phoneBox!.y);
    await ctx.close();
  });
}

for (const phone of ["iphone", "android"] as const) {
  test(`Hent sends an ${phone} visitor to the phone app first`, async ({
    browser,
  }) => {
    const ctx = await browser.newContext({
      userAgent: AGENTS[phone],
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
    const page = await ctx.newPage();
    await page.goto("/hent");
    const hero = page.locator("header .get");
    const app = hero.locator('[data-platform="phone"] a.wt-shiny');
    await expect(app).toBeVisible();
    await expect(app).toHaveAttribute("href", PHONE_APP_URL);
    await expect(hero.locator('[data-platform="phone"]')).toContainText(
      "din Mac eller pc",
    );
    for (const os of ["mac", "win"])
      await expect(hero.locator(`[data-platform="${os}"]`)).toBeHidden();
    /* no code to scan on the phone itself; the computers' cards stay further down */
    await expect(page.locator(".phone-qr .qr-code")).toBeHidden();
    await expect(
      page.locator(`main a[href="${PHONE_APP_URL}"]`).first(),
    ).toBeVisible();
    for (const os of ["mac", "win"])
      await expect(
        page.locator(`.platforms [data-platform="${os}"]`),
      ).toBeVisible();
    /* how the phone pairs comes right after the hero, before the computers' first-open steps */
    const [phoneBox, cardsBox] = await Promise.all([
      page.locator(".phone-get").boundingBox(),
      page.locator(".platforms").boundingBox(),
    ]);
    expect(phoneBox!.y).toBeLessThan(cardsBox!.y);
    await ctx.close();
  });
}

test("Hent shows both computers when it cannot tell (Linux, or no JavaScript)", async ({
  browser,
}) => {
  for (const opts of [
    { ...COMPUTER, userAgent: AGENTS.linux },
    { ...COMPUTER, userAgent: AGENTS.mac, javaScriptEnabled: false },
    { userAgent: AGENTS.iphone, javaScriptEnabled: false },
  ]) {
    const ctx = await browser.newContext(opts);
    const page = await ctx.newPage();
    await page.goto("/hent");
    const hero = page.locator("header .get");
    for (const os of ["mac", "win"] as const) {
      const button = hero.locator(`[data-platform="${os}"] a.wt-shiny`);
      await expect(button).toBeVisible();
      await expect(button).toHaveAttribute("href", DOWNLOAD[os]);
      await expect(hero.locator(`.get-alt[data-for="${os}"]`)).toBeHidden();
    }
    await expect(hero.locator('[data-platform="phone"]')).toBeHidden();
    await expect(page.locator(".phone-qr .qr-code")).toBeVisible();
    await expect(
      page.locator(`.phone-qr a[href="${PHONE_APP_URL}"]`),
    ).toBeVisible();
    for (const os of ["mac", "win"])
      await expect(
        page.locator(`.platforms [data-platform="${os}"] a.wt-shiny`),
      ).toBeVisible();
    await expect(
      page.locator(`a[href="${ALL_RELEASES_URL}"]`).first(),
    ).toBeVisible();
    await ctx.close();
  }
});

test("the QR code on Hent opens the phone app", async ({ browser }) => {
  const ctx = await browser.newContext({ ...COMPUTER, userAgent: AGENTS.mac });
  const page = await ctx.newPage();
  await page.goto("/hent");
  const png = PNG.sync.read(
    await page.locator(".phone-qr .qr-code").screenshot(),
  );
  const code = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);
  expect(code?.data).toBe(PHONE_APP_URL);
  await ctx.close();
});

test("keyboard focus is visible (6.17)", async ({ page }) => {
  await page.goto("/");
  await page.keyboard.press("Tab");
  const focused = page.locator(":focus");
  await expect(focused).toHaveCount(1);
  const ring = await focused.evaluate((el) => {
    const s = getComputedStyle(el);
    return s.outlineStyle !== "none" && s.outlineWidth !== "0px"
      ? s.outlineStyle
      : s.boxShadow;
  });
  expect(ring).not.toBe("none");
  /* tab on to the primary button: it gets the design system's focus ring (2px gap, 2px ink) */
  for (
    let i = 0;
    i < 15 &&
    !(await page.evaluate(() =>
      document.activeElement?.matches(".fp-hero a.wt-shiny--lg"),
    ));
    i++
  )
    await page.keyboard.press("Tab");
  expect(
    await page.evaluate(() =>
      document.activeElement?.matches(".fp-hero a.wt-shiny--lg:focus-visible"),
    ),
  ).toBe(true);
  /* the button eases its shadow over duration-base, so wait for the ring */
  await expect
    .poll(() =>
      page.evaluate(() => getComputedStyle(document.activeElement!).boxShadow),
    )
    .toContain("0px 0px 0px 4px");
});

test("the font licence is served next to the font, the trademark READMEs are not (spec 11, 14.8)", async ({
  page,
  request,
}) => {
  const fonts: string[] = [];
  page.on("request", (r) => {
    if (/albert-sans[^/]*\.woff2$/.test(r.url())) fonts.push(r.url());
  });
  await page.goto("/");
  await page.evaluate(() => document.fonts.ready);
  expect(fonts.length).toBeGreaterThan(0);
  const licence = await request.get(new URL("OFL.txt", fonts[0]).href);
  expect(licence.status()).toBe(200);
  expect(licence.headers()["content-type"]).toContain("text/plain");
  expect(await licence.text()).toContain("SIL OPEN FONT LICENSE Version 1.1");
  expect((await request.get("/README.md")).status()).toBe(404);
});

test("/updates/beta.json is served as JSON", async ({ request }) => {
  const res = await request.get("/updates/beta.json");
  expect(res.status()).toBe(200);
  expect(res.headers()["content-type"]).toContain("application/json");
  const m = await res.json();
  expect(m.version).toBe("0.0.0");
  expect(m.platforms).toEqual({});
});
