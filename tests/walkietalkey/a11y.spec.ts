// Accessibility (spec 6.17): every control is named, reachable by keyboard,
// and motion stops with reduced motion.
import { expect, test, type Page } from "@playwright/test";
import { EDDA, installMock } from "./mock";

const SECTIONS = [
  "Historik",
  "Generelt",
  "Tast",
  "Tekst",
  "Ordliste",
  "Ryd op med AI",
  "Telefon",
  "Model",
  "Opdateringer",
  "Avanceret",
  "Om",
];

/** Controls without an accessible name, described for the failure message. */
async function unnamedControls(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    const controls = document.querySelectorAll<HTMLElement>(
      "main button, main input, main select, main textarea, main [role=switch], main [role=radio]",
    );
    for (const el of Array.from(controls)) {
      if (el.closest("[aria-hidden=true]")) continue;
      const labelledBy = el.getAttribute("aria-labelledby");
      const byIds = labelledBy
        ?.split(" ")
        .map((id) => document.getElementById(id)?.textContent?.trim() ?? "")
        .join("");
      const label =
        el.getAttribute("aria-label") ||
        byIds ||
        (el.id &&
          document
            .querySelector(`label[for="${el.id}"]`)
            ?.textContent?.trim()) ||
        el.closest("label")?.textContent?.trim() ||
        (el.tagName === "BUTTON" ? el.textContent?.trim() : "") ||
        "";
      if (!label) out.push(el.outerHTML.slice(0, 120));
    }
    return out;
  });
}

test.describe("accessibility", () => {
  test("every control in every section has a name", async ({ page }) => {
    await installMock(page, {
      downloaded: [EDDA],
      app: {
        selected_model: EDDA,
        onboarding_completed: true,
        debug_mode: true,
      },
      wt: {
        cleanup_mode: "always",
        cleanup_provider: "custom",
        cleanup_consented: ["custom"],
      },
    });
    await page.goto("/");
    for (const name of SECTIONS) {
      await page
        .getByRole("navigation")
        .getByRole("button", { name, exact: true })
        .click();
      await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();
      expect(await unnamedControls(page), name).toEqual([]);
    }
  });

  test("onboarding steps are named and keyboard operable", async ({ page }) => {
    await installMock(page);
    await page.goto("/");
    const start = page.getByRole("button", { name: "Kom i gang" });
    await start.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { name: "Mikrofon" })).toBeFocused();
    expect(await unnamedControls(page)).toEqual([]);
  });

  test("reduced motion stops the onboarding animations", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await installMock(page, { wt: { onboarding_resume_step: "microphone" } });
    await page.goto("/");
    const card = page.locator(".wt-onb-card");
    await expect(card).toBeVisible();
    expect(
      await card.evaluate((el) => getComputedStyle(el).animationName),
    ).toBe("none");
    const layer = page.locator(".wt-gbg-layer");
    expect(
      await layer.evaluate((el) => getComputedStyle(el).animationName),
    ).toBe("none");
  });
});
