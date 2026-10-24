/* The main screen's status line and readable text everywhere (run 2, Phase 4 "Phone"). */
import { devices, type Page } from "@playwright/test";
import {
  APP_URL,
  closeScannerIfOpen,
  expect,
  hold,
  label,
  pairByLink,
  preparePage,
  statusName,
  sub,
  tap,
  test,
} from "./helpers";

/** Every visible text on the page that is smaller than 16 px, as "size: text". */
async function smallTexts(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    const hidden = (el: Element | null): boolean => {
      for (let e = el; e; e = e.parentElement) {
        const cs = getComputedStyle(e);
        if (
          cs.display === "none" ||
          cs.visibility === "hidden" ||
          Number(cs.opacity) === 0
        )
          return true;
      }
      return false;
    };
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
    );
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const text = n.textContent?.trim();
      const el = n.parentElement;
      if (!text || !el || hidden(el) || !el.getClientRects().length) continue;
      const size = parseFloat(getComputedStyle(el).fontSize);
      if (size < 15.95) out.push(`${size.toFixed(1)}px: ${text.slice(0, 40)}`);
    }
    return out;
  });
}

test.describe("the status line at the top (Phase 4)", () => {
  test("one subtle line at the very top: a dot and the computer, no pill, never cut off", async ({
    page,
    browserName,
    newComputer,
  }) => {
    const name = "Jonathans MacBook Pro med et meget langt navn";
    const computer = await newComputer(name);
    await preparePage(page, browserName);
    await pairByLink(page, computer);
    const line = page.locator(".wt-status");
    await expect(line).toHaveText(`Forbundet til ${name}`);
    await expect(line).toHaveClass(/wt-status--online/);
    // The design system's chip is gone.
    await expect(page.locator(".wt-app-dev")).toBeHidden();
    const g = await line.evaluate((el) => {
      const cs = getComputedStyle(el);
      const text = el.querySelector(".wt-status-text") as HTMLElement;
      const r = el.getBoundingClientRect();
      return {
        top: r.top,
        left: r.left,
        right: r.right,
        width: document.documentElement.clientWidth,
        lines: Math.round(
          text.getBoundingClientRect().height /
            parseFloat(getComputedStyle(text).lineHeight),
        ),
        truncated:
          text.scrollWidth > text.clientWidth + 1 ||
          getComputedStyle(text).textOverflow === "ellipsis",
        background: cs.backgroundColor,
        shadow: cs.boxShadow,
        border: cs.borderTopWidth,
        size: parseFloat(getComputedStyle(text).fontSize),
      };
    });
    expect(g.top).toBeLessThan(24);
    expect(g.left).toBeGreaterThanOrEqual(0);
    expect(g.right).toBeLessThanOrEqual(g.width);
    expect(g.truncated).toBe(false);
    expect(g.lines).toBeLessThanOrEqual(2);
    expect(g.background).toBe("rgba(0, 0, 0, 0)");
    expect(g.shadow).toBe("none");
    expect(g.border).toBe("0px");
    expect(g.size).toBeGreaterThanOrEqual(16);

    // The computer goes away.
    computer.disconnect();
    await expect(line).toHaveText(`${name} er ikke online`);
    await expect(line).toHaveClass(/wt-status--away/);
    // PHONE-41: it opens the computer picker (and from there the settings).
    await line.click();
    await expect(page.getByRole("dialog", { name: "Send til" })).toBeVisible();
  });
});

test.describe("text is at least 16 px on every screen (Phase 4)", () => {
  test("pairing, main screen in every state, sheets and settings", async ({
    page,
    browserName,
    newComputer,
  }) => {
    await preparePage(page, browserName);
    await page.goto("/");
    if (await page.locator(".wt-scan").isVisible())
      expect(await smallTexts(page), "scanner").toEqual([]);
    await closeScannerIfOpen(page);
    expect(await smallTexts(page), "pair").toEqual([]);

    const computer = await newComputer("MacBook");
    await page.goto(await computer.pairingUrl(APP_URL));
    await expect(
      page.getByRole("heading", { name: "Hvad hedder telefonen?" }),
    ).toBeVisible();
    expect(await smallTexts(page), "name").toEqual([]);
    await page.getByRole("button", { name: "Par telefonen" }).click();
    await computer.waitPhone();
    await expect(label(page)).toHaveText("Hold for at tale");
    await page.waitForTimeout(700);
    expect(await smallTexts(page), "idle").toEqual([]);

    await tap(page);
    await expect(label(page)).toHaveText("Tryk igen for at stoppe");
    await page.waitForTimeout(700);
    expect(await smallTexts(page), "hands-free").toEqual([]);
    await tap(page);
    await expect(label(page)).toHaveText("Klar på MacBook");
    await page.waitForTimeout(700);
    expect(await smallTexts(page), "ready").toEqual([]);

    computer.answer = () => ({ ok: false, reason: "error" });
    await hold(page, 700);
    await expect(label(page)).toHaveText("Noget gik galt. Prøv igen.");
    await page.waitForTimeout(700);
    expect(await smallTexts(page), "error").toEqual([]);
    await sub(page).getByRole("button", { name: "Detaljer" }).click();
    await expect(page.getByRole("dialog", { name: "Detaljer" })).toBeVisible();
    expect(await smallTexts(page), "details").toEqual([]);
    await page.getByRole("button", { name: "OK", exact: true }).click();

    computer.disconnect();
    computer.answer = () => ({ ok: true });
    await hold(page, 700);
    await expect(label(page)).toContainText("er ikke online");
    await page.waitForTimeout(700);
    expect(await smallTexts(page), "offline").toEqual([]);

    await statusName(page).click();
    await expect(page.getByRole("dialog", { name: "Send til" })).toBeVisible();
    expect(await smallTexts(page), "picker").toEqual([]);
    await page.getByRole("button", { name: "Indstillinger" }).click();
    await expect(
      page.getByRole("heading", { name: "Indstillinger" }),
    ).toBeVisible();
    expect(await smallTexts(page), "settings").toEqual([]);
  });

  test("the Safari tab's install steps", async ({ browser }) => {
    const { defaultBrowserType: _engine, ...iphone } = devices["iPhone 15"];
    const context = await browser.newContext({ ...iphone, baseURL: APP_URL });
    const page = await context.newPage();
    await page.goto("/");
    await expect(
      page.getByRole("heading", {
        name: "Føj WalkieTalkey til hjemmeskærmen for at bruge den",
      }),
    ).toBeVisible();
    expect(await smallTexts(page)).toEqual([]);
    await context.close();
  });
});
