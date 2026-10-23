import { APP_URL, chip, expect, hold, label, pairByLink, preparePage, test } from "./helpers";

test.describe("several computers (PHONE-40, PHONE-41) and settings (7.6)", () => {
  test("presence picks the unlocked computer with the latest input; the chip picks another", async ({ page, browserName, newComputer }) => {
    const home = await newComputer("Stue-iMac");
    const work = await newComputer("Arbejds-PC", "win");
    await preparePage(page, browserName);
    await pairByLink(page, home);
    await pairByLink(page, work);
    // The computer just paired is the target.
    await expect(chip(page)).toHaveText("Arbejds-PC");

    home.presence = { secondsSinceInput: 4, locked: false };
    work.presence = { secondsSinceInput: 900, locked: false };
    await page.reload();
    await expect(chip(page)).toHaveText("Stue-iMac");

    // A locked computer is skipped, however recent.
    home.presence = { secondsSinceInput: 1, locked: true };
    await page.reload();
    await expect(chip(page)).toHaveText("Arbejds-PC");

    // PHONE-41: tap the chip and pick the other one for the next dictation.
    await chip(page).click();
    const picker = page.getByRole("dialog", { name: "Send til" });
    await expect(picker.getByRole("option")).toHaveCount(2);
    await picker.getByRole("option", { name: /Stue-iMac/ }).click();
    await expect(chip(page)).toHaveText("Stue-iMac");
    await hold(page, 700);
    await expect(label(page)).toHaveText("Klar på Stue-iMac");
    await home.waitEnded();
    expect(work.sessions.size).toBe(0);
  });

  test("Fjern sends leave and forgets the computer", async ({ page, browserName, newComputer }) => {
    const computer = await newComputer("MacBook");
    await preparePage(page, browserName);
    const phone = await pairByLink(page, computer, { name: "Min telefon" });
    await chip(page).click();
    await page.getByRole("button", { name: "Indstillinger" }).click();
    await expect(page.getByRole("heading", { name: "Parrede computere" })).toBeVisible();
    await expect(page.getByText("Navn på MacBook: Min telefon")).toBeVisible();
    await expect(page.getByText("Om og licenser")).toBeVisible();
    await expect(page.getByText("Apache-2.0", { exact: false }).first()).toBeVisible();
    await page.getByRole("button", { name: "Fjern MacBook" }).click();
    await page.getByRole("group").getByRole("button", { name: "Fjern" }).click();
    await computer.until(() => computer.left.includes(phone.id), "member_left");
    await expect(page.getByText("Ingen computere endnu.")).toBeVisible();
    await page.getByRole("button", { name: "Tilbage" }).click();
    await expect(page.getByRole("heading", { name: "Par med en computer" })).toBeVisible();
    // The relay forgot the phone: the same keys can no longer get in.
    expect(computer.phones.size).toBe(0);
  });

  test("settings: haptics switch and pairing another computer from settings", async ({ page, browserName, newComputer }) => {
    const computer = await newComputer();
    await preparePage(page, browserName);
    await pairByLink(page, computer);
    await chip(page).click();
    await page.getByRole("button", { name: "Indstillinger" }).click();
    const haptics = page.getByRole("switch");
    await expect(haptics).toBeChecked();
    await haptics.uncheck();
    await page.reload();
    await chip(page).click();
    await page.getByRole("button", { name: "Indstillinger" }).click();
    await expect(page.getByRole("switch")).not.toBeChecked();
    await page.getByRole("button", { name: "Par med en computer" }).click();
    await expect(page.getByRole("button", { name: "Scan koden på din computer" })).toBeVisible();
    await page.getByRole("button", { name: "Tilbage" }).click();
    await expect(chip(page)).toHaveText("Testcomputer");
    expect(page.url().startsWith(APP_URL)).toBe(true);
  });
});
