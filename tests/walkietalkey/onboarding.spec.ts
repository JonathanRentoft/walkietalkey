// Onboarding (spec 6.2, DESK-10..17) against the mocked backend.
import { expect, test, type Page } from "@playwright/test";
import { calls, EDDA, EKKO_TINY, emit, installMock, mockState } from "./mock";

const welcome = "Dansk tale til tekst. Gratis, og det kører på din egen computer.";

async function startAt(page: Page, step: string, options = {}) {
  await installMock(page, {
    downloaded: [EDDA],
    app: { selected_model: EDDA, onboarding_completed: true },
    wt: { onboarding_resume_step: step },
    ...options,
  });
  await page.goto("/");
}

test.describe("onboarding", () => {
  test("a new user starts at Velkommen with the logo intro", async ({ page }) => {
    await installMock(page);
    await page.goto("/");
    await expect(page.getByRole("heading", { name: welcome })).toBeVisible();
    await expect(page.getByRole("img", { name: "WalkieTalkey" }).first()).toBeVisible();
    await page.getByRole("button", { name: "Kom i gang" }).click();
    await expect(page.getByRole("heading", { name: "Hent talemodel" })).toBeVisible();
    // The step is remembered so a restart resumes here.
    const wt = (await mockState(page)).wt;
    expect(wt.onboarding_resume_step).toBe("model");
  });

  test("Hent talemodel downloads Edda and lets the user go on meanwhile", async ({ page }) => {
    await installMock(page, { wt: { onboarding_resume_step: "model" } });
    await page.goto("/");
    await expect(page.getByText("Henter dansk talemodel").first()).toBeVisible();
    await expect(page.getByRole("progressbar")).toBeVisible();
    const downloads = await calls(page, "download_model");
    expect(downloads.map((c) => c.args.modelId)).toEqual([EDDA]);

    await page.getByRole("button", { name: "Fortsæt" }).click();
    await expect(page.getByRole("heading", { name: "Mikrofon" })).toBeVisible();
    // The download goes on in the background and is shown on every step.
    await expect(page.getByText("Henter dansk talemodel").first()).toBeVisible();

    await page.evaluate((id) => (window as any).__WT_MOCK__.finishDownload(id), EDDA);
    await expect(page.getByText("Talemodellen er klar").first()).toBeVisible();
    await expect.poll(async () => (await calls(page, "set_active_model")).map((c) => c.args.modelId)).toEqual([EDDA]);
    await expect.poll(async () => (await calls(page, "wt_measure_speed")).length).toBe(1);
  });

  test("an installed Edda is not downloaded again", async ({ page }) => {
    await startAt(page, "model");
    await expect(page.getByText("Talemodellen er klar").first()).toBeVisible();
    expect(await calls(page, "download_model")).toHaveLength(0);
  });

  test("a failed download offers Importér modelfil", async ({ page }) => {
    await installMock(page, {
      wt: { onboarding_resume_step: "model" },
      downloadError: "404 Not Found",
    });
    await page.goto("/");
    await expect(page.getByText("Kunne ikke hente talemodellen. Prøv igen.").first()).toBeVisible();
    await page.getByRole("button", { name: "Importér modelfil" }).click();
    await expect.poll(async () => (await calls(page, "wt_import_model_file")).map((c) => c.args.path)).toEqual([
      "/Users/test/Downloads/edda-v0.2-Q8_0.gguf",
    ]);
    await expect(page.getByText("Talemodellen er klar").first()).toBeVisible();
  });

  test("a slow computer is offered Ekko v1 Tiny with the reason", async ({ page }) => {
    const reason =
      "Din computer brugte 3,2 sekunder på 10 sekunders tale, så en hurtigere model giver dig teksten hurtigere.";
    await startAt(page, "model", {
      speed: { seconds: 3.2, offer_fast_model: true, reason },
    });
    await expect(page.getByText(reason)).toBeVisible();
    await page.getByRole("button", { name: "Brug Ekko v1 Tiny" }).click();
    await expect.poll(async () => (await calls(page, "download_model")).map((c) => c.args.modelId)).toEqual([
      EKKO_TINY,
    ]);
  });

  test("Mikrofon explains before the macOS prompt", async ({ page }) => {
    await startAt(page, "microphone");
    await expect(page.getByText("WalkieTalkey skal bruge mikrofonen for at høre dig")).toBeVisible();
    expect(await calls(page, "plugin:macos-permissions|request_microphone_permission")).toHaveLength(0);
    await page.getByRole("button", { name: "Giv adgang til mikrofonen" }).click();
    await expect.poll(async () => (await calls(page, "plugin:macos-permissions|request_microphone_permission")).length).toBe(1);
    await expect(page.getByText("Mikrofonen er klar")).toBeVisible();
  });

  test("Tasten on a Mac: Inputovervågning, the globe key, restart and resume", async ({ page }) => {
    await startAt(page, "key");
    await expect(page.getByRole("heading", { name: "Tasten", exact: true })).toBeVisible();
    await expect(page.getByText("Inputovervågning").first()).toBeVisible();

    await page.getByRole("button", { name: "Åbn Inputovervågning" }).click();
    await expect.poll(async () => (await calls(page, "plugin:macos-permissions|request_input_monitoring_permission")).length).toBe(1);
    const urls = async () => (await calls(page, "plugin:opener|open_url")).map((c) => c.args.url);
    await expect.poll(urls).toContain(
      "x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent",
    );

    await page.getByRole("button", { name: "Åbn Tastatur" }).click();
    await expect.poll(urls).toContain(
      "x-apple.systempreferences:com.apple.Keyboard-Settings.extension",
    );

    await page.getByRole("button", { name: "Genstart WalkieTalkey" }).click();
    // After the restart the app is back at this step.
    await expect.poll(async () => (await mockState(page)).restarts).toBe(1);
    await expect(page.getByRole("heading", { name: "Tasten", exact: true })).toBeVisible();
    expect((await mockState(page)).wt.onboarding_resume_step).toBe("key");

    // The live check follows the key.
    await expect(page.getByText("Prøv at holde tasten")).toBeVisible();
    await emit(page, "wt-key-state", true);
    await expect(page.getByText("Det virker")).toBeVisible();
    await emit(page, "wt-key-state", false);
    await expect(page.getByText("Det virker")).toBeVisible();
  });

  test("Tasten on Windows: Right Ctrl, the Copilot key and a key of your own", async ({ page }) => {
    await startAt(page, "key", { platform: "windows" });
    await expect(page.getByText("Højre Ctrl").first()).toBeVisible();
    await expect(page.getByText(/Copilot/).first()).toBeVisible();
    await page.getByRole("button", { name: "Vælg en anden tast" }).click();
    await expect.poll(async () => (await calls(page, "start_handy_keys_recording")).length).toBe(1);
    await expect(page.getByText("Tryk på den tast, du vil bruge")).toBeVisible();
    await emit(page, "handy-keys-event", {
      modifiers: ["super", "shift"],
      key: "f23",
      is_key_down: true,
      hotkey_string: "super+shift+f23",
    });
    await emit(page, "handy-keys-event", {
      modifiers: ["super", "shift"],
      key: "f23",
      is_key_down: false,
      hotkey_string: "super+shift+f23",
    });
    await expect.poll(async () => (await calls(page, "change_binding")).map((c) => c.args.binding)).toEqual([
      "super+shift+f23",
    ]);
    await expect(page.getByText("Copilot-tasten").first()).toBeVisible();
    await emit(page, "wt-key-state", true);
    await expect(page.getByText("Det virker")).toBeVisible();
  });

  test("Indsæt automatisk explains, and can be skipped", async ({ page }) => {
    await startAt(page, "paste");
    await expect(page.getByText("Så teksten kan sættes ind, hvor du skriver")).toBeVisible();
    await page.getByRole("button", { name: "Spring over" }).click();
    await expect(page.getByRole("heading", { name: "Notifikationer" })).toBeVisible();
    expect(await calls(page, "plugin:macos-permissions|request_accessibility_permission")).toHaveLength(0);
  });

  test("Indsæt automatisk asks for Accessibility after the explanation", async ({ page }) => {
    await startAt(page, "paste");
    await page.getByRole("button", { name: "Giv adgang" }).click();
    await expect.poll(async () => (await calls(page, "plugin:macos-permissions|request_accessibility_permission")).length).toBe(1);
  });

  test("Notifikationer asks for permission", async ({ page }) => {
    await startAt(page, "notifications");
    await page.getByRole("button", { name: "Slå notifikationer til" }).click();
    await expect.poll(async () => (await calls(page, "wt_request_notification_permission")).length).toBe(1);
    await expect(page.getByText("Notifikationer er slået til")).toBeVisible();
  });

  test("Telefon shows the pairing code with a countdown and cancels it on leaving", async ({ page }) => {
    await startAt(page, "phone");
    await expect(page.getByText("Vil du også kunne tale ind i telefonen?")).toBeVisible();
    await page.getByRole("button", { name: "Vis koden" }).click();
    await expect(page.getByRole("img", { name: "Kode til at parre en telefon" })).toBeVisible();
    await expect(page.getByText(/[0-9]:[0-5][0-9]/).first()).toBeVisible();
    await expect(page.getByText(/deler din skærm/)).toBeVisible();
    // React's development double mount may cancel once already; leaving the
    // step must cancel the code that is shown.
    const before = (await calls(page, "wt_pairing_cancel")).length;
    await page.getByRole("button", { name: "Næste" }).click();
    await expect(page.getByRole("heading", { name: "Prøv det" })).toBeVisible();
    await expect.poll(async () => (await calls(page, "wt_pairing_cancel")).length).toBe(before + 1);
  });

  test("Telefon can be skipped", async ({ page }) => {
    await startAt(page, "phone");
    await page.getByRole("button", { name: "Spring over" }).click();
    await expect(page.getByRole("heading", { name: "Prøv det" })).toBeVisible();
    expect(await calls(page, "wt_pairing_start")).toHaveLength(0);
  });

  test("Prøv det finishes: start at login on, onboarding done", async ({ page }) => {
    await startAt(page, "try");
    await expect(page.getByText("Hold fn nede og sig: Hej, det her er min første diktering.")).toBeVisible();
    await expect(page.getByRole("textbox")).toBeVisible();
    await page.getByRole("button", { name: "Færdig" }).click();
    await expect(page.getByRole("navigation")).toBeVisible();
    const state = await mockState(page);
    expect(state.app.autostart_enabled).toBe(true);
    expect(state.wt.onboarding_resume_step).toBeNull();
  });

  test("Prøv det says Ctrl on Windows", async ({ page }) => {
    await startAt(page, "try", { platform: "windows" });
    await expect(page.getByText("Hold Ctrl nede og sig: Hej, det her er min første diktering.")).toBeVisible();
  });

  test("a returning user goes straight to the main window", async ({ page }) => {
    await installMock(page, {
      downloaded: [EDDA],
      app: { selected_model: EDDA, onboarding_completed: true },
    });
    await page.goto("/");
    await expect(page.getByRole("navigation")).toBeVisible();
  });
});
