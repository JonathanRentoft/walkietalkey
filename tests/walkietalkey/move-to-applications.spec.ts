// DESK-114: an app opened from its disk image offers "Flyt til Programmer"
// at start, over the onboarding as over the main window; "Ikke nu" leaves
// run 6's banner (DESK-113) with the same button; a failed move says what to
// do instead, in Danish.
import { expect, test, type Page } from "@playwright/test";
import { calls, EDDA, installMock, type MockOptions } from "./mock";

const TITLE = "Flyt WalkieTalkey til Programmer";
const BANNER =
  "WalkieTalkey kører fra diskbilledet og kan ikke opdatere sig selv.";

async function openMain(page: Page, options: MockOptions = {}) {
  await installMock(page, {
    downloaded: [EDDA],
    ...options,
    app: { selected_model: EDDA, onboarding_completed: true },
  });
  await page.goto("/");
  await expect(page.getByRole("navigation")).toBeVisible();
}

const offer = (page: Page) => page.getByRole("alertdialog", { name: TITLE });

test.describe("Flyt til Programmer (DESK-114)", () => {
  test("an app in Programmer is never offered the move", async ({ page }) => {
    await openMain(page);
    await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
    await expect(offer(page)).toHaveCount(0);
    await expect(page.getByTestId("disk-image-notice")).toHaveCount(0);
    expect(await calls(page, "wt_move_to_applications")).toHaveLength(0);
  });

  test("one click moves it, from the main window", async ({ page }) => {
    await openMain(page, { fromDiskImage: true });
    const dialog = offer(page);
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(
      "kan ikke opdatere sig selv derfra. Flyt den til Programmer",
    );
    const move = dialog.getByRole("button", { name: "Flyt til Programmer" });
    await expect(move).toBeFocused();
    await move.click();
    await expect
      .poll(async () => (await calls(page, "wt_move_to_applications")).length)
      .toBe(1);
    // The app quits and opens again from Programmer; until then it says so.
    await expect(
      dialog.getByRole("button", { name: "Flytter…" }),
    ).toBeDisabled();
  });

  test("a new user meets the offer first, over the onboarding", async ({
    page,
  }) => {
    await installMock(page, {
      downloaded: [EDDA],
      fromDiskImage: true,
      app: { selected_model: EDDA },
      wt: { onboarding_resume_step: "welcome" },
    });
    await page.goto("/");
    const dialog = offer(page);
    await expect(dialog).toBeVisible();
    await expect(page.getByRole("navigation")).toHaveCount(0);
    await dialog.getByRole("button", { name: "Flyt til Programmer" }).click();
    await expect
      .poll(async () => (await calls(page, "wt_move_to_applications")).length)
      .toBe(1);
  });

  test("Ikke nu leaves the banner, with the same button", async ({ page }) => {
    await openMain(page, { fromDiskImage: true });
    await offer(page).getByRole("button", { name: "Ikke nu" }).click();
    await expect(offer(page)).toHaveCount(0);
    const banner = page.getByTestId("disk-image-notice");
    await expect(banner).toContainText(BANNER);
    expect(await calls(page, "wt_move_to_applications")).toHaveLength(0);
    await banner.getByRole("button", { name: "Flyt til Programmer" }).click();
    await expect
      .poll(async () => (await calls(page, "wt_move_to_applications")).length)
      .toBe(1);
  });

  test("Escape is Ikke nu", async ({ page }) => {
    await openMain(page, { fromDiskImage: true });
    await expect(offer(page)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(offer(page)).toHaveCount(0);
    await expect(page.getByTestId("disk-image-notice")).toBeVisible();
    expect(await calls(page, "wt_move_to_applications")).toHaveLength(0);
  });

  test("a standard user is told to drag it there instead", async ({ page }) => {
    await openMain(page, {
      fromDiskImage: true,
      moveError: { kind: "not_writable" },
    });
    const dialog = offer(page);
    await dialog.getByRole("button", { name: "Flyt til Programmer" }).click();
    const notWritable =
      "Din bruger må ikke lægge programmer i Programmer, så WalkieTalkey kan ikke flytte sig selv. Afslut den, og træk den over i Programmer.";
    await expect(dialog.getByRole("alert")).toContainText(notWritable);
    await dialog.getByRole("button", { name: "Luk" }).click();
    await expect(offer(page)).toHaveCount(0);
    const banner = page.getByTestId("disk-image-notice");
    await expect(banner).toContainText(notWritable);
    // Moving again would only fail again.
    await expect(banner.getByRole("button")).toHaveCount(0);
  });

  test("any other failure gives the manual steps and can be tried again", async ({
    page,
  }) => {
    await openMain(page, {
      fromDiskImage: true,
      moveError: { kind: "failed", message: "ditto: No space left on device" },
    });
    const dialog = offer(page);
    await dialog.getByRole("button", { name: "Flyt til Programmer" }).click();
    const failed =
      "WalkieTalkey kunne ikke flytte sig selv. Afslut den, træk den over i Programmer, og åbn den derfra.";
    await expect(dialog.getByRole("alert")).toHaveText(failed);
    await expect(dialog).not.toContainText("ditto");
    await dialog.getByRole("button", { name: "Luk" }).click();
    const banner = page.getByTestId("disk-image-notice");
    await expect(banner).toContainText(failed);
    await banner.getByRole("button", { name: "Flyt til Programmer" }).click();
    await expect
      .poll(async () => (await calls(page, "wt_move_to_applications")).length)
      .toBe(2);
  });
});
