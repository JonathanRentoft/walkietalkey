// Onboarding (spec 6.2, DESK-10..17, run 2 "plug and play") against the
// mocked backend: Velkommen, Mikrofon, Tilgængelighed (Mac), Prøv det,
// Telefon, Klar; the model downloads in the background from the first
// launch; every permission step has one button and moves on by itself.
import { expect, test, type Page } from "@playwright/test";
import {
  calls,
  EDDA,
  EKKO_TINY,
  emit,
  installMock,
  mockState,
  type MockOptions,
} from "./mock";

const welcome =
  "Dansk tale til tekst. Gratis, og det kører på din egen computer.";
const ACCESSIBILITY_PANE =
  "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility";
const MICROPHONE_PANE =
  "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone";

async function startAt(page: Page, step: string, options: MockOptions = {}) {
  await installMock(page, {
    downloaded: [EDDA],
    ...options,
    app: { selected_model: EDDA, ...(options.app ?? {}) },
    wt: { onboarding_resume_step: step, ...(options.wt ?? {}) },
  });
  await page.goto("/");
}

const heading = (page: Page, name: string) =>
  page.getByRole("heading", { level: 1, name, exact: true });

/** Grants a macOS permission the way System Settings does: silently. */
async function grant(page: Page, permission: string) {
  await page.evaluate(
    (p) => ((window as any).__WT_MOCK__.state.permissions[p] = true),
    permission,
  );
}

test.describe("onboarding", () => {
  test("a new user starts at Velkommen with the logo intro", async ({
    page,
  }) => {
    await installMock(page);
    await page.goto("/");
    await expect(page.getByRole("heading", { name: welcome })).toBeVisible();
    await expect(
      page.getByRole("img", { name: "WalkieTalkey" }).first(),
    ).toBeVisible();
    await page.getByRole("button", { name: "Kom i gang" }).click();
    await expect(heading(page, "Mikrofon")).toBeVisible();
    // The step is remembered so a restart resumes here.
    expect((await mockState(page)).wt.onboarding_resume_step).toBe(
      "microphone",
    );
    // Six steps on a Mac.
    await expect(page.getByRole("list", { name: "Trin 2 af 6" })).toBeVisible();
  });

  test("the model downloads in the background from the first launch and shows as one line", async ({
    page,
  }) => {
    await installMock(page, { wt: { onboarding_resume_step: "microphone" } });
    await page.goto("/");
    await expect(heading(page, "Mikrofon")).toBeVisible();
    await expect(
      page.getByText("Henter dansk talemodel").first(),
    ).toBeVisible();
    await emit(page, "model-download-progress", {
      model_id: EDDA,
      downloaded: 38,
      total: 100,
      percentage: 38,
    });
    await expect(page.getByText("38 %").first()).toBeVisible();
    await expect(page.getByRole("progressbar").first()).toBeVisible();
    // The backend started it; the screens never start a second download.
    expect(await calls(page, "download_model")).toHaveLength(0);

    await page.evaluate(
      (id) => (window as any).__WT_MOCK__.finishDownload(id),
      EDDA,
    );
    await expect(page.getByText("Talemodellen er klar").first()).toBeVisible();
    await expect
      .poll(async () =>
        (await calls(page, "set_active_model")).map((c) => c.args.modelId),
      )
      .toEqual([EDDA]);
    await expect
      .poll(async () => (await calls(page, "wt_measure_speed")).length)
      .toBe(1);
  });

  test("without a download from the backend, onboarding starts it itself", async ({
    page,
  }) => {
    await installMock(page, {
      backendDownloading: false,
      wt: { onboarding_resume_step: "microphone" },
    });
    await page.goto("/");
    await expect
      .poll(
        async () =>
          (await calls(page, "download_model")).map((c) => c.args.modelId),
        { timeout: 10_000 },
      )
      .toEqual([EDDA]);
  });

  test("an installed Edda is not downloaded again", async ({ page }) => {
    await startAt(page, "microphone");
    await expect(page.getByText("Talemodellen er klar").first()).toBeVisible();
    await page.waitForTimeout(500);
    expect(await calls(page, "download_model")).toHaveLength(0);
  });

  test("a failed download says so, and Prøv igen starts it again", async ({
    page,
  }) => {
    await installMock(page, { wt: { onboarding_resume_step: "microphone" } });
    await page.goto("/");
    await expect(
      page.getByText("Henter dansk talemodel").first(),
    ).toBeVisible();
    await emit(page, "model-download-failed", {
      model_id: EDDA,
      error: "404",
    });
    await expect(
      page.getByText("Kunne ikke hente talemodellen. Prøv igen.").first(),
    ).toBeVisible();
    await page.getByRole("button", { name: "Prøv igen" }).click();
    await expect
      .poll(async () =>
        (await calls(page, "download_model")).map((c) => c.args.modelId),
      )
      .toEqual([EDDA]);
  });

  test("Importér modelfil is not part of onboarding any more", async ({
    page,
  }) => {
    await installMock(page, { wt: { onboarding_resume_step: "microphone" } });
    await page.goto("/");
    await expect(heading(page, "Mikrofon")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Importér modelfil" }),
    ).toHaveCount(0);
  });

  test("Mikrofon: one button asks macOS, and the step moves on by itself", async ({
    page,
  }) => {
    await startAt(page, "microphone");
    await expect(
      page.getByText("WalkieTalkey skal bruge mikrofonen for at høre dig"),
    ).toBeVisible();
    expect(
      await calls(
        page,
        "plugin:macos-permissions|request_microphone_permission",
      ),
    ).toHaveLength(0);
    await page
      .getByRole("button", { name: "Giv adgang til mikrofonen" })
      .click();
    await expect(page.getByText("Mikrofonen er klar")).toBeVisible();
    // No click: the next step comes by itself.
    await expect(heading(page, "Tilgængelighed")).toBeVisible();
    expect((await mockState(page)).wt.onboarding_resume_step).toBe(
      "accessibility",
    );
  });

  test("Mikrofon: answered no before, the same button opens the exact pane and the grant is noticed", async ({
    page,
  }) => {
    await startAt(page, "microphone", { denyRequests: true });
    await page
      .getByRole("button", { name: "Giv adgang til mikrofonen" })
      .click();
    await page.getByRole("button", { name: "Åbn Systemindstillinger" }).click();
    await expect
      .poll(async () =>
        (await calls(page, "plugin:opener|open_url")).map((c) => c.args.url),
      )
      .toContain(MICROPHONE_PANE);
    await grant(page, "microphone");
    await expect(heading(page, "Tilgængelighed")).toBeVisible();
  });

  test("Tilgængelighed: one button opens the exact pane, and the grant moves on with no restart", async ({
    page,
  }) => {
    await startAt(page, "accessibility", { permissions: { microphone: true } });
    await expect(
      page.getByText("Så teksten kan sættes ind, hvor du skriver"),
    ).toBeVisible();
    // One button in the step (plus Tilbage and Næste under it).
    await expect(page.locator(".wt-onb-card").getByRole("button")).toHaveCount(
      1,
    );
    await page.getByRole("button", { name: "Åbn Systemindstillinger" }).click();
    await expect
      .poll(async () =>
        (await calls(page, "plugin:opener|open_url")).map((c) => c.args.url),
      )
      .toContain(ACCESSIBILITY_PANE);
    await expect(
      page.getByText("Slå WalkieTalkey til. Så går vi videre af os selv."),
    ).toBeVisible();
    await grant(page, "accessibility");
    await expect(page.getByText("Tilgængelighed er slået til")).toBeVisible();
    await expect(heading(page, "Prøv det")).toBeVisible();
    const state = await mockState(page);
    expect(state.restarts).toBe(0);
  });

  test("no Input Monitoring, no restart, and no early key listener anywhere", async ({
    page,
  }) => {
    await installMock(page, {
      downloaded: [EDDA],
      permissions: { microphone: true, accessibility: true },
    });
    await page.goto("/");
    await page.getByRole("button", { name: "Kom i gang" }).click();
    // Both permissions are already there: straight to Prøv det.
    await expect(heading(page, "Prøv det")).toBeVisible();
    await page.getByRole("button", { name: "Næste" }).click();
    await expect(heading(page, "Telefon")).toBeVisible();
    await page.getByRole("button", { name: "Spring over" }).click();
    await expect(heading(page, "Klar")).toBeVisible();
    await expect(page.getByText(/Inputovervågning/)).toHaveCount(0);
    expect(
      await calls(
        page,
        "plugin:macos-permissions|request_input_monitoring_permission",
      ),
    ).toHaveLength(0);
    expect(await calls(page, "plugin:process|restart")).toHaveLength(0);
    // The backend starts the key listener once Accessibility is granted.
    expect(await calls(page, "initialize_shortcuts")).toHaveLength(0);
  });

  test("Windows: no Tilgængelighed step, Right Ctrl, and an allowed microphone is skipped", async ({
    page,
  }) => {
    await installMock(page, {
      platform: "windows",
      downloaded: [EDDA],
      permissions: { microphone: true },
    });
    await page.goto("/");
    await page.getByRole("button", { name: "Kom i gang" }).click();
    await expect(heading(page, "Prøv det")).toBeVisible();
    await expect(page.getByRole("list", { name: "Trin 3 af 5" })).toBeVisible();
    await expect(
      page.getByText(
        "Hold Ctrl nede og sig: Hej, det her er min første diktering.",
      ),
    ).toBeVisible();
    await expect(page.getByText("Tilgængelighed")).toHaveCount(0);
  });

  test("Prøv det: tap or hold, and the result in the field", async ({
    page,
  }) => {
    await startAt(page, "try", {
      permissions: { microphone: true, accessibility: true },
    });
    await expect(
      page.getByText(
        "Hold fn nede og sig: Hej, det her er min første diktering.",
      ),
    ).toBeVisible();
    await expect(
      page.getByText(
        "Du kan også trykke på fn én gang, tale, og trykke igen, når du er færdig.",
      ),
    ).toBeVisible();
    await expect(page.getByRole("textbox")).toBeFocused();
    await emit(page, "wt-pill-end", { state: "pasted", shortcut: "⌘V" });
    await expect(page.getByText("Det virker. Du er klar.")).toBeVisible();
  });

  test("Prøv det waits calmly for a model that is still downloading", async ({
    page,
  }) => {
    await startAt(page, "try", { downloaded: [] });
    await expect(
      page.getByText(
        "Talemodellen hentes stadig. Du kan prøve, så snart den er klar.",
      ),
    ).toBeVisible();
  });

  test("Prøv det: Ret det for mig only when the Globe key needs it", async ({
    page,
  }) => {
    await startAt(page, "try", {
      globeKey: { fn_is_key: true, usage: 1, needs_fix: true },
    });
    const fix = page.getByTestId("globe-fix");
    await expect(fix).toContainText(
      "Når du trykker på fn, skifter din Mac også tastatursprog.",
    );
    await fix.getByRole("button", { name: "Ret det for mig" }).click();
    await expect
      .poll(async () => (await calls(page, "wt_globe_key_fix")).length)
      .toBe(1);
    await expect(
      page.getByText("Ordnet. Nu starter fn kun WalkieTalkey."),
    ).toBeVisible();
    // It applies at once: nothing about logging out.
    await expect(page.getByText(/log/i)).toHaveCount(0);
  });

  test("Prøv det: no Ret det for mig when the Globe key is fine", async ({
    page,
  }) => {
    await startAt(page, "try", {
      globeKey: { fn_is_key: true, usage: 0, needs_fix: false },
    });
    await expect(heading(page, "Prøv det")).toBeVisible();
    await expect
      .poll(async () => (await calls(page, "wt_globe_key_status")).length)
      .toBeGreaterThan(0);
    await expect(page.getByTestId("globe-fix")).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Ret det for mig" }),
    ).toHaveCount(0);
  });

  test("Prøv det says when the key listener is not running", async ({
    page,
  }) => {
    await startAt(page, "try");
    await emit(page, "wt-key-listener", { running: false });
    await expect(
      page.getByText("WalkieTalkey kan ikke se tasten endnu."),
    ).toBeVisible();
    await emit(page, "wt-key-listener", { running: true });
    await expect(
      page.getByText("WalkieTalkey kan ikke se tasten endnu."),
    ).toHaveCount(0);
  });

  test("Telefon shows the pairing code with a countdown, asks for notifications, and cancels the code on leaving", async ({
    page,
  }) => {
    await startAt(page, "phone");
    await expect(
      page.getByText("Vil du også kunne tale ind i telefonen?"),
    ).toBeVisible();
    await page.getByRole("button", { name: "Vis koden" }).click();
    await expect(
      page.getByRole("img", { name: "Kode til at parre en telefon" }),
    ).toBeVisible();
    await expect(page.getByText(/[0-9]:[0-5][0-9]/).first()).toBeVisible();
    await expect(page.getByText(/deler din skærm/).first()).toBeVisible();
    // Text from the phone arrives with a notification (DESK-56).
    await expect
      .poll(
        async () =>
          (await calls(page, "wt_request_notification_permission")).length,
      )
      .toBe(1);
    const before = (await calls(page, "wt_pairing_cancel")).length;
    await page.getByRole("button", { name: "Næste" }).click();
    await expect(heading(page, "Klar")).toBeVisible();
    await expect
      .poll(async () => (await calls(page, "wt_pairing_cancel")).length)
      .toBe(before + 1);
  });

  test("Telefon can be skipped", async ({ page }) => {
    await startAt(page, "phone");
    await page.getByRole("button", { name: "Spring over" }).click();
    await expect(heading(page, "Klar")).toBeVisible();
    expect(await calls(page, "wt_pairing_start")).toHaveLength(0);
  });

  test("Klar finishes: start at login on, and onboarding stays finished", async ({
    page,
  }) => {
    await startAt(page, "done", { app: { onboarding_completed: false } });
    await expect(
      page.getByText(
        "Hold fn for at tale, eller tryk for at tale uden at holde.",
      ),
    ).toBeVisible();
    await page.getByRole("button", { name: "Færdig" }).click();
    await expect(page.getByRole("navigation")).toBeVisible();
    const state = await mockState(page);
    expect(state.app.autostart_enabled).toBe(true);
    expect(state.wt.onboarding_resume_step).toBe("finished");
  });

  test("a finished onboarding without a model yet stays finished", async ({
    page,
  }) => {
    await installMock(page, {
      app: { onboarding_completed: false },
      wt: { onboarding_resume_step: "finished" },
    });
    await page.goto("/");
    await expect(page.getByRole("navigation")).toBeVisible();
  });

  test("a slow computer is offered Ekko v1 Tiny in Klar", async ({ page }) => {
    const reason =
      "Din computer brugte 3,2 sekunder på 10 sekunders tale, så en hurtigere model giver dig teksten hurtigere.";
    await startAt(page, "done", {
      speed: { seconds: 3.2, offer_fast_model: true, reason },
    });
    await expect(page.getByText(reason)).toBeVisible();
    await page.getByRole("button", { name: "Brug Ekko v1 Tiny" }).click();
    await expect
      .poll(async () =>
        (await calls(page, "download_model")).map((c) => c.args.modelId),
      )
      .toEqual([EKKO_TINY]);
  });

  test("v1's stored step resumes at the step that replaced it", async ({
    page,
  }) => {
    await startAt(page, "key");
    await expect(heading(page, "Tilgængelighed")).toBeVisible();
  });

  test("a returning user goes straight to the main window", async ({
    page,
  }) => {
    await installMock(page, {
      downloaded: [EDDA],
      app: { selected_model: EDDA, onboarding_completed: true },
    });
    await page.goto("/");
    await expect(page.getByRole("navigation")).toBeVisible();
  });
});
