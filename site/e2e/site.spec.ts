/* The built site in a real browser: SITE-02, SITE-04, SITE-06, SITE-08, 6.17. */
import { expect, test, type Page } from "@playwright/test";
import { PAGES, RELEASES_URL } from "../src/lib/site";

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

test("the homepage has exactly one WebGL surface once everything has hydrated", async ({
  page,
}) => {
  const w = await watch(page);
  await page.goto("/");
  await scrollThrough(page);
  await page.locator(".privacy").scrollIntoViewIfNeeded();
  await page.waitForTimeout(500);
  expect(
    await page.evaluate(() => (window as unknown as { __gl: number }).__gl),
  ).toBe(1);
  expect(w.errors).toEqual([]);
});

test("the hero plays, and stands still with reduced motion (SITE-06)", async ({
  browser,
}) => {
  for (const reducedMotion of ["no-preference", "reduce"] as const) {
    const ctx = await browser.newContext({ reducedMotion });
    const page = await ctx.newPage();
    await page.goto("/");
    const relay = page.locator(".wt-relay");
    await relay.scrollIntoViewIfNeeded();
    await expect(relay.locator(".wt-relay-stage")).toHaveCSS(
      "visibility",
      "visible",
    );
    if (reducedMotion === "reduce") {
      await expect(relay).toHaveClass(/wt-relay--still/);
      await expect(relay).toHaveClass(/wt-relay--paste/);
      expect(
        await page
          .locator(".wt-blob")
          .first()
          .evaluate((e) => getComputedStyle(e).animationName),
      ).toBe("none");
    } else {
      await expect(relay).not.toHaveClass(/wt-relay--still/);
      await expect(relay).toHaveClass(
        /wt-relay--tap|wt-relay--open|wt-relay--idle/,
        { timeout: 5000 },
      );
    }
    await ctx.close();
  }
});

test("the pairing code is drawn as a small 21 by 21 grid", async ({ page }) => {
  await page.goto("/");
  const qr = page.locator(".qr");
  await qr.scrollIntoViewIfNeeded();
  const [box, cell] = await Promise.all([
    qr.boundingBox(),
    qr.locator("i").first().boundingBox(),
  ]);
  expect(box!.width).toBeLessThan(160);
  expect(cell!.width).toBeLessThan(8);
});

test("Hent recommends the visitor's platform and always shows both", async ({
  browser,
}) => {
  const agents = {
    mac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
    win: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
  };
  for (const [os, userAgent] of Object.entries(agents)) {
    const ctx = await browser.newContext({ userAgent });
    const page = await ctx.newPage();
    await page.goto("/hent");
    for (const other of ["mac", "win"]) {
      const card = page.locator(`[data-platform="${other}"]`);
      await expect(card).toBeVisible();
      await expect(card.getByRole("link")).toHaveAttribute(
        "href",
        RELEASES_URL,
      );
      if (other === os)
        await expect(card).toHaveAttribute("data-recommended", "true");
      else await expect(card).not.toHaveAttribute("data-recommended", "true");
    }
    await ctx.close();
  }
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
      document.activeElement?.matches(".hero a.wt-shiny--lg"),
    ));
    i++
  )
    await page.keyboard.press("Tab");
  expect(
    await page.evaluate(() =>
      document.activeElement?.matches(".hero a.wt-shiny--lg:focus-visible"),
    ),
  ).toBe(true);
  /* the button eases its shadow over duration-base, so wait for the ring */
  await expect
    .poll(() =>
      page.evaluate(() => getComputedStyle(document.activeElement!).boxShadow),
    )
    .toContain("0px 0px 0px 4px");
});

test("/updates/beta.json is served as JSON", async ({ request }) => {
  const res = await request.get("/updates/beta.json");
  expect(res.status()).toBe(200);
  expect(res.headers()["content-type"]).toContain("application/json");
  const m = await res.json();
  expect(m.version).toBe("0.0.0");
  expect(m.platforms).toEqual({});
});
