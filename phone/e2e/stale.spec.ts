/**
 * Run 5, spec 5.4: a pairing whose computer will never come back shows "Par igen", never a hang.
 * The scripted computer simulates a Mac that was reset, reinstalled or updated to v0.2.0 (a new
 * identity): the old one goes offline for good while its room lives on at the relay, and a new
 * one with the same name shows a fresh code. A computer that only sleeps still gets its dictation
 * (PHONE-24). The removed cases (4401, 4404) are in errors.spec.ts.
 */
import {
  APP_URL,
  expect,
  hold,
  label,
  pairByLink,
  preparePage,
  statusName,
  sub,
  test,
} from "./helpers";

const DAY = 24 * 60 * 60 * 1000;

const status = (page: import("@playwright/test").Page) =>
  page.locator(".wt-status-text");

async function roomsInStorage(page: import("@playwright/test").Page) {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve) => {
      const r = indexedDB.open("walkietalkey");
      r.onsuccess = () => resolve(r.result);
    });
    return new Promise<string[]>((resolve) => {
      const r = db.transaction("rooms").objectStore("rooms").getAll();
      r.onsuccess = () =>
        resolve(
          (r.result as { computerName: string }[]).map((x) => x.computerName),
        );
    });
  });
}

test.describe("stale pairings (run 5, spec 5.4)", () => {
  test("the Mac was reset: pairing it again replaces the old pairing, which waited for a computer that never comes back", async ({
    page,
    browserName,
    newComputer,
  }) => {
    const before = await newComputer("Jonathans MacBook");
    await preparePage(page, browserName);
    const phone = await pairByLink(page, before);
    // Reset: the old identity is gone for good, its room stays at the relay.
    before.disconnect();
    await expect(status(page)).toContainText(
      "Jonathans MacBook er ikke online",
    );

    // The same Mac with a new identity shows a new code.
    const after = await newComputer("Jonathans MacBook");
    await pairByLink(page, after);
    await expect
      .poll(() => roomsInStorage(page))
      .toEqual(["Jonathans MacBook"]);
    await expect(status(page)).toContainText("Forbundet til Jonathans MacBook");

    // The phone left the old room (the relay holds the event for its owner).
    await before.connect();
    await before.until(() => before.left.includes(phone.id), "member_left");

    // Dictations go to the Mac that is there.
    await hold(page, 800);
    await expect(label(page)).toHaveText("Klar på Jonathans MacBook");
    await after.waitEnded();
  });

  test("a computer away for days says so and offers Par igen; back again it still gets the dictation (PHONE-24)", async ({
    page,
    browserName,
    newComputer,
  }) => {
    const mac = await newComputer("MacBook");
    await preparePage(page, browserName);
    await pairByLink(page, mac);
    mac.disconnect();
    // Three days later.
    await page.clock.install({ time: Date.now() + 3 * DAY });
    await page.reload();
    await expect(statusName(page)).toHaveText("MacBook");
    await expect(status(page)).toContainText(
      "MacBook har ikke været online i 3 dage",
    );
    const repair = page.locator(".wt-stage-repair");
    await expect(repair).toContainText(
      "Er MacBook nulstillet eller installeret igen? Så skal telefonen parres igen.",
    );
    await repair.getByRole("button", { name: "Par igen" }).click();
    await expect(
      page.getByRole("heading", { name: "Par med en computer" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Tilbage" }).click();

    // It may only have been off: a dictation waits for it.
    await hold(page, 800);
    await expect(label(page)).toHaveText(
      "MacBook er ikke online. Optagelsen venter i 10 minutter.",
    );
    await expect(repair).toBeVisible();
    await mac.connect();
    await expect(label(page)).toHaveText("Klar på MacBook");
    await mac.waitEnded();
    await expect(repair).toHaveCount(0);
    await expect(status(page)).toContainText("Forbundet til MacBook");
  });

  test("a computer that is only asleep gets no Par igen while the dictation waits", async ({
    page,
    browserName,
    newComputer,
  }) => {
    const mac = await newComputer("MacBook");
    await preparePage(page, browserName);
    await pairByLink(page, mac);
    mac.disconnect();
    await hold(page, 800);
    await expect(label(page)).toHaveText(
      "MacBook er ikke online. Optagelsen venter i 10 minutter.",
    );
    await expect(page.locator(".wt-stage-repair")).toHaveCount(0);
    await mac.connect();
    await expect(label(page)).toHaveText("Klar på MacBook");
  });

  test("a dictation that never arrived offers Par igen next to Prøv igen", async ({
    page,
    browserName,
    newComputer,
  }) => {
    const mac = await newComputer("MacBook");
    await preparePage(page, browserName);
    await page.clock.install();
    await pairByLink(page, mac);
    mac.disconnect();
    await hold(page, 800);
    await expect(label(page)).toHaveText(
      "MacBook er ikke online. Optagelsen venter i 10 minutter.",
    );
    // The 10 minutes count from the moment the finished take is handed to the
    // relay, a moment after the release: jump again if the first jump came first.
    // A timer that was never set would still fail every attempt.
    await expect(async () => {
      await page.clock.fastForward(10 * 60 * 1000 + 1000);
      await expect(label(page)).toHaveText("Nåede ikke frem til MacBook.", {
        timeout: 1000,
      });
    }).toPass({ timeout: 15_000 });
    await expect(
      sub(page).getByRole("button", { name: "Prøv igen" }),
    ).toBeVisible();
    await page
      .locator(".wt-stage-repair")
      .getByRole("button", { name: "Par igen" })
      .click();
    await expect(
      page.getByRole("heading", { name: "Par med en computer" }),
    ).toBeVisible();
  });

  test("an old code of the same computer is refused, and the pairing keeps working", async ({
    page,
    browserName,
    newComputer,
  }) => {
    const mac = await newComputer("MacBook");
    await preparePage(page, browserName);
    await pairByLink(page, mac);
    // A code the computer showed and took back (an old screenshot, a link from before).
    const old = await mac.pairingUrl(APP_URL);
    await mac.cancelAdmission();
    await page.goto(old);
    await page.getByRole("button", { name: "Par telefonen" }).click();
    await expect(
      page.getByText("Koden er udløbet. Lav en ny på computeren."),
    ).toBeVisible();
    await page.getByRole("button", { name: "Annullér" }).click();
    await expect(statusName(page)).toHaveText("MacBook");
    // The pair keys are the ones the computer has: the dictation arrives.
    await hold(page, 800);
    await expect(label(page)).toHaveText("Klar på MacBook");
    await mac.waitEnded();
  });
});
