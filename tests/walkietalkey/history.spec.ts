// Historik (spec 6.12, DESK-57, DESK-85, DESK-90..94).
import { expect, test, type Page } from "@playwright/test";
import { calls, EDDA, emit, installMock } from "./mock";

const now = Math.floor(Date.now() / 1000);
const HISTORY = [
  {
    id: 3,
    timestamp: now - 60,
    source: "Jonathans iPhone",
    text: "Husk at købe mælk på vej hjem",
    cleaned: false,
    cleanup: null,
    has_audio: false,
  },
  {
    id: 2,
    timestamp: now - 3600,
    source: "tast",
    text: "Mødet er flyttet til torsdag.",
    cleaned: true,
    cleanup: {
      provider: "OpenAI",
      sent_text: "Mødet er flyttet til onsdag, nej, torsdag.",
      duration_ms: 640,
    },
    has_audio: false,
  },
  {
    id: 1,
    timestamp: now - 7200,
    source: "tast",
    text: "Hej, det her er min første diktering.",
    cleaned: false,
    cleanup: null,
    has_audio: false,
  },
];

async function openHistory(page: Page) {
  await installMock(page, {
    downloaded: [EDDA],
    app: { selected_model: EDDA, onboarding_completed: true },
    history: HISTORY,
  });
  await page.goto("/");
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "Historik" })
    .click();
  await expect(
    page.getByRole("heading", { level: 1, name: "Historik" }),
  ).toBeVisible();
}

const list = (page: Page) => page.getByRole("list", { name: "Dikteringer" });

test.describe("history", () => {
  test("lists every dictation with its source and cleanup", async ({
    page,
  }) => {
    await openHistory(page);
    await expect(list(page).getByRole("listitem")).toHaveCount(3);
    await expect(page.getByText("Fra Jonathans iPhone")).toBeVisible();
    await expect(page.getByText("Tast", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Ryddet op med AI")).toBeVisible();
  });

  test("search asks the backend", async ({ page }) => {
    await openHistory(page);
    await page
      .getByRole("searchbox", { name: "Søg i historikken" })
      .fill("torsdag");
    await expect(list(page).getByRole("listitem")).toHaveCount(1);
    expect(
      (await calls(page, "wt_history_list")).map((c) => c.args.query),
    ).toContain("torsdag");
  });

  test("copy and delete one item", async ({ page }) => {
    await openHistory(page);
    const first = list(page).getByRole("listitem").first();
    await first.getByRole("button", { name: "Kopiér" }).click();
    await expect
      .poll(async () =>
        (await calls(page, "wt_history_copy")).map((c) => c.args.id),
      )
      .toEqual([3]);
    await expect(first.getByRole("button", { name: "Kopieret" })).toBeVisible();
    await first.getByRole("button", { name: "Slet" }).click();
    await expect
      .poll(async () =>
        (await calls(page, "wt_history_delete")).map((c) => c.args.id),
      )
      .toEqual([3]);
    await expect(list(page).getByRole("listitem")).toHaveCount(2);
  });

  test("Slet al historik asks first", async ({ page }) => {
    await openHistory(page);
    await page.getByRole("button", { name: "Slet al historik" }).click();
    const dialog = page.getByRole("alertdialog", { name: "Slet al historik?" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Slet al historik" }).click();
    await expect
      .poll(async () =>
        (await calls(page, "wt_history_delete")).map((c) => c.args.id),
      )
      .toEqual([null]);
    await expect(page.getByText("Ingen dikteringer endnu.")).toBeVisible();
  });

  test("Vis hvad der blev sendt: provider, exact text and duration", async ({
    page,
  }) => {
    await openHistory(page);
    const item = list(page)
      .getByRole("listitem")
      .filter({ hasText: "Mødet er flyttet" });
    await item.getByRole("button", { name: "Vis hvad der blev sendt" }).click();
    await expect(item.getByText("OpenAI")).toBeVisible();
    await expect(
      item.getByText("Mødet er flyttet til onsdag, nej, torsdag."),
    ).toBeVisible();
    await expect(item.getByText("640 ms")).toBeVisible();
  });

  test("Ryd op med AI links to what was sent", async ({ page }) => {
    await openHistory(page);
    await page
      .getByRole("navigation")
      .getByRole("button", { name: "Ryd op med AI" })
      .click();
    await page.getByRole("button", { name: "Åbn historikken" }).click();
    await expect(
      page.getByRole("heading", { level: 1, name: "Historik" }),
    ).toBeVisible();
    await expect(list(page).getByRole("listitem")).toHaveCount(1);
  });

  test("a notification click selects the item (wt-open-history)", async ({
    page,
  }) => {
    await openHistory(page);
    await page
      .getByRole("navigation")
      .getByRole("button", { name: "Generelt" })
      .click();
    await emit(page, "wt-open-history", 1);
    await expect(
      page.getByRole("heading", { level: 1, name: "Historik" }),
    ).toBeVisible();
    const selected = list(page).locator('[aria-current="true"]');
    await expect(selected).toContainText(
      "Hej, det her er min første diktering.",
    );
    await expect(selected).toBeFocused();
  });

  test("wt-history-changed refreshes the list", async ({ page }) => {
    await openHistory(page);
    await page.evaluate(() => {
      const s = (window as any).__WT_MOCK__.state;
      s.history.unshift({
        id: 4,
        timestamp: Math.floor(Date.now() / 1000),
        source: "tast",
        text: "En ny diktering",
        cleaned: false,
        cleanup: null,
        has_audio: false,
      });
    });
    await emit(page, "wt-history-changed");
    await expect(page.getByText("En ny diktering")).toBeVisible();
  });

  test("an in-window notice opens its history item", async ({ page }) => {
    await openHistory(page);
    await page
      .getByRole("navigation")
      .getByRole("button", { name: "Generelt" })
      .click();
    await emit(page, "wt-notify", {
      title: "Tekst klar til at indsætte",
      body: "Husk at købe mælk på vej hjem",
      history_id: 3,
    });
    await page.getByRole("button", { name: "Vis", exact: true }).click();
    await expect(list(page).locator('[aria-current="true"]')).toContainText(
      "Husk at købe mælk",
    );
  });
});
