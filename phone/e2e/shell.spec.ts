import {
  APP_URL,
  expect,
  holdButton,
  label,
  pairByLink,
  preparePage,
  test,
} from "./helpers";

/* The iOS shell contract (PHONE-03): "Start diktering" as the `wt-shell-start` event or `?start=1`,
   and haptics through window.webkit.messageHandlers.haptics. */
test.describe("iOS shell hooks", () => {
  test("Start diktering records hands-free; a tap sends it; the cancel control cancels", async ({
    page,
    browserName,
    newComputer,
  }) => {
    await page.addInitScript(() => {
      const calls: unknown[] = [];
      (window as unknown as { __haptics: unknown[] }).__haptics = calls;
      (window as unknown as { webkit: unknown }).webkit = {
        messageHandlers: {
          haptics: { postMessage: (m: unknown) => calls.push(m) },
        },
      };
    });
    const computer = await newComputer();
    await preparePage(page, browserName);
    await pairByLink(page, computer);

    await page.evaluate(() =>
      window.dispatchEvent(new CustomEvent("wt-shell-start")),
    );
    await expect(label(page)).toHaveText("Tryk igen for at stoppe");
    await expect(page.getByRole("button", { name: "Annullér" })).toBeVisible();
    await computer.waitSession(
      (s) => s.blocks.size >= 3,
      "live blocks",
      10_000,
    );
    await holdButton(page).click();
    await computer.waitEnded();
    await expect(label(page)).toHaveText("Klar på Testcomputer");
    expect(
      await page.evaluate(
        () => (window as unknown as { __haptics: unknown[] }).__haptics,
      ),
    ).toEqual(["start", "stop"]);

    await page.evaluate(() =>
      window.dispatchEvent(new CustomEvent("wt-shell-start")),
    );
    await expect(label(page)).toHaveText("Tryk igen for at stoppe");
    await page.getByRole("button", { name: "Annullér" }).click();
    await expect(label(page)).toHaveText("Hold for at tale");
    await computer.waitSession((s) => s.cancelled, "audio_cancel");
  });

  test("a cold start with ?start=1 records at once", async ({
    page,
    browserName,
    newComputer,
  }) => {
    const computer = await newComputer();
    await preparePage(page, browserName);
    await pairByLink(page, computer);
    await page.goto(`${APP_URL}/?start=1`);
    await expect(label(page)).toHaveText("Tryk igen for at stoppe");
    expect(page.url()).toBe(`${APP_URL}/`);
    await computer.waitSession(
      (s) => s.blocks.size >= 2,
      "live blocks",
      10_000,
    );
    await holdButton(page).click();
    await expect(label(page)).toHaveText("Klar på Testcomputer");
  });

  test("Start diktering is ignored when not paired", async ({
    page,
    browserName,
  }) => {
    await preparePage(page, browserName);
    await page.goto("/?start=1");
    await expect(
      page.getByRole("heading", { name: "Par med en computer" }),
    ).toBeVisible();
    await page.evaluate(() =>
      window.dispatchEvent(new CustomEvent("wt-shell-start")),
    );
    await page.waitForTimeout(300);
    await expect(
      page.getByRole("heading", { name: "Par med en computer" }),
    ).toBeVisible();
  });
});
