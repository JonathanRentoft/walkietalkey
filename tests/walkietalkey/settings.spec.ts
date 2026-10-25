// Settings (spec 6.14), locks (DESK-101), consent (DESK-82), keys (DESK-81),
// pairing (5.3) and "Var det dig?" (DESK-62) against the mocked backend.
import { expect, test, type Page } from "@playwright/test";
import {
  calls,
  EDDA,
  emit,
  installMock,
  mockState,
  type MockOptions,
} from "./mock";

async function openApp(page: Page, options: MockOptions = {}) {
  await installMock(page, {
    downloaded: [EDDA],
    ...options,
    app: {
      selected_model: EDDA,
      onboarding_completed: true,
      ...(options.app ?? {}),
    },
  });
  await page.goto("/");
  await expect(page.getByRole("navigation")).toBeVisible();
}

async function section(page: Page, name: string) {
  await page
    .getByRole("navigation")
    .getByRole("button", { name, exact: true })
    .click();
  await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();
}

const SECTIONS: [string, string[]][] = [
  [
    "Generelt",
    [
      "Start ved login",
      "Lyde",
      "Pillens placering",
      "Vis teksten i notifikationen",
      "Sprog",
    ],
  ],
  ["Tast", ["Tast", "Test"]],
  ["Tekst", ["Indsæt automatisk", "Tegnsætning", "Del med mine andre enheder"]],
  ["Ordliste", ["Ord", "Erstatninger", "Udviklerord", "Importér og eksportér"]],
  ["Ryd op med AI", ["Tilstand", "Udbyder", "Vis hvad der blev sendt"]],
  ["Telefon", ["Parrede telefoner", "Par en telefon"]],
  [
    "Model",
    [
      "Valgt model",
      "Hold talemodellen indlæst",
      "Andre modeller",
      "Hent igen",
      "Plads brugt",
    ],
  ],
  ["Historik", ["Opbevaring", "Gem lyd til fejlfinding", "Slet al historik"]],
  [
    "Opdateringer",
    ["Automatiske opdateringer", "Kanal", "Søg efter opdateringer"],
  ],
  [
    "Avanceret",
    [
      "Tastens tilstand",
      "Relæ-adresse",
      "Manuel installation af modeller",
      "Fejlsøgning",
      "Forsinkelser ved indsæt",
      "Kommandolinje",
    ],
  ],
  [
    "Om",
    [
      "Version",
      "Licenser og kreditering",
      "Kildekode",
      "Privatliv",
      "Varemærke",
    ],
  ],
];

test.describe("settings", () => {
  for (const [name, items] of SECTIONS) {
    test(`${name} has every item of spec 6.14`, async ({ page }) => {
      await openApp(page);
      await section(page, name);
      const main = page.getByRole("main");
      for (const item of items) {
        await expect(
          main.getByText(item, { exact: true }).first(),
        ).toBeVisible();
      }
    });
  }

  test("Om credits every component", async ({ page }) => {
    await openApp(page);
    await section(page, "Om");
    for (const credit of [
      "Handy",
      "transcribe.cpp",
      "Edda",
      "Ekko PnC",
      "ONNX Runtime",
      "Silero VAD",
      "Albert Sans",
    ]) {
      await expect(
        page.getByRole("main").getByText(credit, { exact: true }).first(),
      ).toBeVisible();
    }
    await page.getByRole("button", { name: "Privatliv" }).click();
    await expect
      .poll(async () =>
        (await calls(page, "plugin:opener|open_url")).map((c) => c.args.url),
      )
      .toContain("https://walkietalkey-site.pages.dev/privatliv");
  });

  test("managed fields show a lock and cannot be changed", async ({ page }) => {
    await openApp(page, {
      locked: [
        "output_mode",
        "cleanup_mode",
        "relay_url",
        "auto_update",
        "update_channel",
      ],
    });
    await section(page, "Tekst");
    await expect(
      page.getByText("Styret af din organisation").first(),
    ).toBeVisible();
    await expect(
      page.getByRole("radio", { name: "Kun udklipsholder" }),
    ).toBeDisabled();

    await section(page, "Ryd op med AI");
    await expect(
      page.getByText("Styret af din organisation").first(),
    ).toBeVisible();
    await expect(page.getByRole("radio", { name: "Altid" })).toBeDisabled();

    await section(page, "Avanceret");
    await expect(
      page.getByRole("textbox", { name: "Relæ-adresse" }),
    ).toBeDisabled();

    await section(page, "Opdateringer");
    await expect(
      page.getByRole("switch", { name: "Automatiske opdateringer" }),
    ).toBeDisabled();
    expect(await calls(page, "wt_update_settings")).toHaveLength(0);
  });

  test("a cloud provider needs consent with the exact text", async ({
    page,
  }) => {
    await openApp(page);
    await section(page, "Ryd op med AI");
    await page.getByRole("radio", { name: "Altid" }).check();
    await page
      .getByRole("combobox", { name: "Udbyder" })
      .selectOption("openai");

    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toBeVisible();
    await expect(
      dialog.getByText(
        "Teksten (ikke lyden) sendes til OpenAI, hver gang du dikterer.",
        { exact: true },
      ),
    ).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Slå til" })).toBeVisible();
    await dialog.getByRole("button", { name: "Annullér" }).click();
    await expect(dialog).toBeHidden();
    let wt = (await mockState(page)).wt;
    expect(wt.cleanup_provider).not.toBe("openai");
    expect(wt.cleanup_consented).toEqual([]);

    await page
      .getByRole("combobox", { name: "Udbyder" })
      .selectOption("openai");
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: "Slå til" })
      .click();
    await expect
      .poll(async () => (await mockState(page)).wt.cleanup_consented)
      .toEqual(["openai"]);
    wt = (await mockState(page)).wt;
    expect(wt.cleanup_provider).toBe("openai");
    expect(wt.cleanup_mode).toBe("always");
  });

  test("the API key is stored through the keychain command and never shown", async ({
    page,
  }) => {
    await openApp(page, {
      wt: {
        cleanup_mode: "always",
        cleanup_provider: "openai",
        cleanup_consented: ["openai"],
      },
    });
    await section(page, "Ryd op med AI");
    const field = page.getByLabel("API-nøgle");
    await expect(field).toHaveAttribute("type", "password");
    await field.fill("sk-test-123");
    await page.getByRole("button", { name: "Gem nøgle" }).click();
    await expect
      .poll(async () =>
        (await calls(page, "wt_set_cleanup_key")).map((c) => c.args),
      )
      .toEqual([{ provider: "openai", key: "sk-test-123" }]);
    await expect(field).toHaveValue("");
    await expect(page.getByText("Der er gemt en nøgle")).toBeVisible();
    expect(await page.content()).not.toContain("sk-test-123");
    // The key never goes into the settings.
    expect(JSON.stringify((await mockState(page)).wt)).not.toContain(
      "sk-test-123",
    );
  });

  test("the small-model note recommends Apple Intelligence or a larger model", async ({
    page,
  }) => {
    await openApp(page);
    await section(page, "Ryd op med AI");
    await expect(
      page.getByText(/under cirka 3 milliarder parametre/),
    ).toBeVisible();
    await expect(
      page.getByText(/Brug Apple Intelligence på en Mac eller en større model/),
    ).toBeVisible();
  });

  test("Telefon lists paired phones and removes one", async ({ page }) => {
    await openApp(page, {
      relay: {
        enabled: true,
        connected: true,
        pairing_active: false,
        phones: [
          { id: "p1", name: "Jonathans iPhone", platform: "ios", online: true },
          {
            id: "p2",
            name: "Pixel",
            platform: "android",
            online: false,
            last_seen_day: Math.floor(Date.now() / 86_400_000) - 1,
          },
          { id: "p3", name: "iPad", platform: "ios", online: false },
        ],
      },
    });
    await section(page, "Telefon");
    await expect(page.getByText("Jonathans iPhone")).toBeVisible();
    await expect(page.getByText("Online", { exact: true })).toBeVisible();
    await expect(page.getByText("Sidst set i går")).toBeVisible();
    await expect(page.getByText("Ikke online", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Fjern Pixel" }).click();
    await expect
      .poll(async () =>
        (await calls(page, "wt_phone_remove")).map((c) => c.args.id),
      )
      .toEqual(["p2"]);
  });

  test("the pairing window counts down and cancels when closed", async ({
    page,
  }) => {
    await openApp(page);
    await section(page, "Telefon");
    await page.getByRole("button", { name: "Par en telefon" }).click();
    const dialog = page.getByRole("dialog", { name: "Par en telefon" });
    await expect(
      dialog.getByRole("img", { name: "Kode til at parre en telefon" }),
    ).toBeVisible();
    await expect(dialog.getByText(/^(10:00|9:5[0-9])$/)).toBeVisible();
    await expect(dialog.getByText(/deler din skærm/)).toBeVisible();
    const before = (await calls(page, "wt_pairing_cancel")).length;
    await dialog.getByRole("button", { name: "Luk" }).click();
    await expect(dialog).toBeHidden();
    await expect
      .poll(async () => (await calls(page, "wt_pairing_cancel")).length)
      .toBe(before + 1);
  });

  test("an expired code offers a new one", async ({ page }) => {
    await openApp(page, { pairingExpiresInMs: 1200 });
    await section(page, "Telefon");
    await page.getByRole("button", { name: "Par en telefon" }).click();
    await expect(page.getByText("Koden er udløbet.")).toBeVisible({
      timeout: 5000,
    });
    await page.getByRole("button", { name: "Lav en ny kode" }).click();
    await expect(
      page.getByRole("img", { name: "Kode til at parre en telefon" }),
    ).toBeVisible();
  });

  test("wt-open-pairing opens the pairing window", async ({ page }) => {
    await openApp(page);
    await emit(page, "wt-open-pairing");
    await expect(
      page.getByRole("dialog", { name: "Par en telefon" }),
    ).toBeVisible();
  });

  test("Var det dig? after a phone joins: Fjern removes it", async ({
    page,
  }) => {
    await openApp(page);
    await emit(page, "wt-phone-joined", { id: "p9", name: "Jonathans iPhone" });
    const dialog = page.getByRole("alertdialog", {
      name: "Ny telefon parret: Jonathans iPhone. Var det dig?",
    });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Ja" })).toBeVisible();
    await dialog.getByRole("button", { name: "Fjern" }).click();
    await expect(dialog).toBeHidden();
    await expect
      .poll(async () =>
        (await calls(page, "wt_phone_remove")).map((c) => c.args.id),
      )
      .toEqual(["p9"]);
  });

  test("Var det dig? Ja keeps the phone", async ({ page }) => {
    await openApp(page);
    await emit(page, "wt-phone-joined", {
      id: "p9",
      name: "en telefon uden navn",
    });
    const dialog = page.getByRole("alertdialog", {
      name: "Ny telefon parret: en telefon uden navn. Var det dig?",
    });
    await dialog.getByRole("button", { name: "Ja" }).click();
    await expect(dialog).toBeHidden();
    expect(await calls(page, "wt_phone_remove")).toHaveLength(0);
  });

  test("the pill can be hidden: Vis aldrig", async ({ page }) => {
    await openApp(page);
    await section(page, "Generelt");
    await page.getByRole("radio", { name: "Vis aldrig" }).check();
    await expect
      .poll(async () => (await mockState(page)).wt.pill_hidden)
      .toBe(true);
    expect((await mockState(page)).app.overlay_style).toBe("none");
    await page.getByRole("radio", { name: "Øverst" }).check();
    await expect
      .poll(async () => (await mockState(page)).wt.pill_hidden)
      .toBe(false);
    const state = await mockState(page);
    expect(state.app.overlay_position).toBe("top");
    expect(state.app.overlay_style).toBe("minimal");
  });

  test("the notification preview follows Vis teksten i notifikationen", async ({
    page,
  }) => {
    await openApp(page);
    await section(page, "Generelt");
    const preview = page.getByTestId("notice-preview");
    await expect(preview.getByText("Tekst klar til at indsætte")).toBeVisible();
    await expect(
      preview.getByText("Husk at købe mælk på vej hjem"),
    ).toBeVisible();
    await page
      .getByRole("switch", { name: "Vis teksten i notifikationen" })
      .click();
    await expect(preview.getByText("Tryk ⌘V for at indsætte")).toBeVisible();
    await expect
      .poll(async () => (await mockState(page)).wt.show_text_in_notifications)
      .toBe(false);
  });

  test("a workbench fine-tune can be chosen but never re-downloaded (run 4)", async ({
    page,
  }) => {
    const custom = { id: "edda-ft-devterms", name: "Edda FT devterms" };
    await openApp(page, {
      customModels: [custom],
      app: { selected_model: custom.id },
    });
    await section(page, "Model");
    const select = page.getByLabel("Valgt model");
    await expect(select).toHaveValue(custom.id);
    await expect(
      select.getByRole("option", { name: custom.name }),
    ).toBeAttached();
    // "Hent igen" deletes the file first; a custom file cannot be fetched back.
    await expect(
      page.getByRole("button", { name: "Hent igen" }),
    ).toBeDisabled();
    await select.selectOption(EDDA);
    await expect(page.getByRole("button", { name: "Hent igen" })).toBeEnabled();
  });

  /* Run 6: the app lists the base Edda and every installed version of it, switches between them, and never
     deletes the base: rolling back means switching. */
  test("Model lists Edda and its versions, switches between them, and keeps Edda", async ({
    page,
  }) => {
    await openApp(page, {
      customModels: [
        { id: "edda-ft-first-v1", name: "Edda finjusteret v1" },
        { id: "edda-ft-first-v2", name: "Edda finjusteret v2" },
      ],
      versions: {
        "edda-ft-first-v1": {
          version: 1,
          created: "2026-10-25T12:00:00+00:00",
          validation_wer: 0.061,
          run: "first-1",
        },
        "edda-ft-first-v2": {
          version: 2,
          created: "2026-10-26T09:30:00+00:00",
          validation_wer: 0.058,
          run: "first-2",
        },
      },
      app: { selected_model: "edda-ft-first-v2" },
    });
    await section(page, "Model");
    const group = page.getByRole("region", { name: "Versioner af Edda" });
    const rows = group.getByRole("listitem");
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(0)).toContainText("Edda v0.2");
    await expect(rows.nth(0)).toContainText(
      "Grundmodellen. Den bliver altid på computeren.",
    );
    await expect(rows.nth(1)).toContainText("Version 1");
    await expect(rows.nth(1)).toContainText("25. okt. 2026");
    await expect(rows.nth(1)).toContainText("6,1 %");
    await expect(rows.nth(2)).toContainText("Version 2");
    await expect(rows.nth(2)).toContainText("I brug");
    // Roll back to version 1, then to the base.
    await rows.nth(1).getByRole("button", { name: "Brug" }).click();
    await expect
      .poll(async () => (await mockState(page)).app.selected_model)
      .toBe("edda-ft-first-v1");
    await expect(rows.nth(1)).toContainText("I brug");
    await rows.nth(0).getByRole("button", { name: "Brug" }).click();
    await expect
      .poll(async () => (await mockState(page)).app.selected_model)
      .toBe(EDDA);
    // The base Edda has no delete button anywhere; versions do.
    await expect(
      page.getByRole("button", { name: "Slet Edda v0.2" }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Slet Edda finjusteret v1" }),
    ).toHaveCount(1);
  });

  test("a version switched from the terminal shows at once (wt-train use)", async ({
    page,
  }) => {
    await openApp(page, {
      customModels: [{ id: "edda-ft-first-v1", name: "Edda finjusteret v1" }],
      versions: { "edda-ft-first-v1": { version: 1 } },
    });
    await section(page, "Model");
    const rows = page
      .getByRole("region", { name: "Versioner af Edda" })
      .getByRole("listitem");
    await expect(rows.nth(0)).toContainText("I brug");
    await page.evaluate(() => {
      (window as any).__WT_MOCK__.state.app.selected_model = "edda-ft-first-v1";
    });
    await emit(page, "wt-model-switched", {
      model_id: "edda-ft-first-v1",
      error: null,
    });
    await expect(rows.nth(1)).toContainText("I brug");
  });

  /* Run 6: macOS runs an app opened from its disk image from a read-only copy, which cannot update itself. */
  test("an app run from its disk image asks to be opened from Programmer", async ({
    page,
  }) => {
    await openApp(page, { fromDiskImage: true });
    await expect(page.getByTestId("disk-image-notice")).toContainText(
      "WalkieTalkey kører fra diskbilledet og kan ikke opdatere sig selv.",
    );
  });

  test("an app in Programmer shows no disk image notice", async ({ page }) => {
    await openApp(page);
    await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
    await expect(page.getByTestId("disk-image-notice")).toHaveCount(0);
  });

  test("Hold talemodellen indlæst maps to the unload timeout", async ({
    page,
  }) => {
    await openApp(page);
    await section(page, "Model");
    await page.getByRole("radio", { name: "I 1 time" }).check();
    await expect
      .poll(async () => (await mockState(page)).app.model_unload_timeout)
      .toBe("hour1");
  });

  test("Model shows the punctuation model and retries its download", async ({
    page,
  }) => {
    await openApp(page, {
      punctuation: { state: "failed", message: "offline" },
    });
    await section(page, "Model");
    await expect(page.getByText("Tegnsætning (Ekko PnC)")).toBeVisible();
    await expect(
      page.getByText("Kunne ikke hente tegnsætningsmodellen."),
    ).toBeVisible();
    await page.getByRole("button", { name: "Prøv igen" }).click();
    await expect(page.getByText("Henter tegnsætningsmodellen")).toBeVisible();
  });

  test("Ordliste adds words newest first and stores replacements", async ({
    page,
  }) => {
    await openApp(page, { app: { custom_words: ["Edda"] } });
    await section(page, "Ordliste");
    await page.getByRole("textbox", { name: "Nyt ord" }).fill("Rentoft");
    await page.getByRole("button", { name: "Tilføj ord" }).click();
    await expect
      .poll(async () => (await mockState(page)).app.custom_words)
      .toEqual(["Edda", "Rentoft"]);
    const words = page.getByRole("list", { name: "Ord" }).getByRole("listitem");
    await expect(words.first()).toContainText("Rentoft");

    await page
      .getByRole("textbox", { name: "Når jeg siger" })
      .fill("walkie talkie");
    await page.getByRole("textbox", { name: "Skriv" }).fill("WalkieTalkey");
    await page.getByRole("button", { name: "Tilføj erstatning" }).click();
    await expect
      .poll(async () => (await mockState(page)).wt.replacements)
      .toEqual([{ from: "walkie talkie", to: "WalkieTalkey" }]);
  });

  test("a window opened while paused says so at once", async ({ page }) => {
    await openApp(page, { paused: true });
    await expect(
      page.getByText("WalkieTalkey er sat på pause.", { exact: false }),
    ).toBeVisible();
  });

  test("paused: the main window says so and Genoptag resumes", async ({
    page,
  }) => {
    await openApp(page);
    await emit(page, "wt-paused", true);
    await page.getByRole("button", { name: "Genoptag" }).click();
    await expect
      .poll(async () =>
        (await calls(page, "wt_set_paused")).map((c) => c.args.paused),
      )
      .toEqual([false]);
    await expect(page.getByRole("button", { name: "Genoptag" })).toBeHidden();
  });

  test("Søg efter opdateringer shows the status", async ({ page }) => {
    await openApp(page);
    await section(page, "Opdateringer");
    await page.getByRole("button", { name: "Søg efter opdateringer" }).click();
    await expect(page.getByText("Du har den nyeste version")).toBeVisible();
    await emit(page, "wt-update-status", { state: "ready", version: "1.0.1" });
    await expect(
      page.getByText("Opdatering klar. Genstart for at installere"),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Genstart nu" }),
    ).toBeVisible();
  });

  test("Tast says tap or hold, and the single modes live under Avanceret (DESK-22)", async ({
    page,
  }) => {
    await openApp(page);
    await section(page, "Tast");
    await expect(
      page.getByText(
        "Hold fn for at tale, eller tryk for at tale uden at holde. Tryk igen for at stoppe.",
      ),
    ).toBeVisible();
    // No separate hold/tap choice in the main settings any more.
    await expect(page.getByRole("radio")).toHaveCount(0);

    await section(page, "Avanceret");
    await expect(
      page.getByRole("radio", { name: /Hold eller tryk/ }),
    ).toBeChecked();
    await page.getByText("Kun hold", { exact: true }).click();
    await expect
      .poll(async () => (await mockState(page)).app.shortcut_activation)
      .toBe("push_to_talk");
    await section(page, "Tast");
    await expect(
      page.getByText("Hold fn nede, mens du taler. Slip for at stoppe."),
    ).toBeVisible();
  });

  test("Tast offers Ret det for mig only when the Globe key needs it", async ({
    page,
  }) => {
    await openApp(page, {
      globeKey: { fn_is_key: true, usage: 2, needs_fix: true },
    });
    await section(page, "Tast");
    const fix = page.getByTestId("globe-fix");
    await expect(fix).toContainText(
      "Når du trykker på fn, åbner din Mac også emoji og symboler.",
    );
    await fix.getByRole("button", { name: "Ret det for mig" }).click();
    await expect(
      page.getByText("Ordnet. Nu starter fn kun WalkieTalkey."),
    ).toBeVisible();
    expect(await calls(page, "wt_globe_key_fix")).toHaveLength(1);
  });

  test("Tast has no Ret det for mig when the Globe key is fine, nor on Windows", async ({
    page,
  }) => {
    await openApp(page);
    await section(page, "Tast");
    await expect
      .poll(async () => (await calls(page, "wt_globe_key_status")).length)
      .toBeGreaterThan(0);
    await expect(page.getByTestId("globe-fix")).toHaveCount(0);
  });

  test("the Accessibility grant is gone: one neutral notice, one button, gone once the key works (DESK-13)", async ({
    page,
  }) => {
    await openApp(page, { permissions: { accessibility: false } });
    await emit(page, "wt-accessibility-lost", true);
    const notice = page.getByRole("alert").filter({
      hasText: "WalkieTalkey har ikke længere adgang til Tilgængelighed.",
    });
    await expect(notice).toBeVisible();
    // The user may have switched it off on purpose: no blame on macOS.
    await expect(notice).not.toContainText(/glemt|opdatering/);
    await notice.getByRole("button", { name: "Giv adgang igen" }).click();
    await expect
      .poll(async () => (await calls(page, "wt_accessibility_repair")).length)
      .toBe(1);
    await expect
      .poll(async () =>
        (await calls(page, "plugin:opener|open_url")).map((c) => c.args.url),
      )
      .toContain(
        "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
      );
    expect(await calls(page, "show_main_window_command")).toHaveLength(0);
    await emit(page, "wt-key-listener", { running: true });
    await expect(notice).toHaveCount(0);
    // Run 5: given back in System Settings, WalkieTalkey comes back to the front.
    await expect
      .poll(async () => (await calls(page, "show_main_window_command")).length)
      .toBe(1);
  });

  test("a grant seen before and gone now shows the notice without the event", async ({
    page,
  }) => {
    await page.addInitScript(() =>
      localStorage.setItem("wt.accessibilitySeen", "1"),
    );
    await openApp(page, { permissions: { accessibility: false } });
    await expect(
      page.getByText(
        "WalkieTalkey har ikke længere adgang til Tilgængelighed.",
      ),
    ).toBeVisible();
    // Granted again in System Settings: the notice goes by itself.
    await page.evaluate(
      () =>
        ((window as any).__WT_MOCK__.state.permissions.accessibility = true),
    );
    await expect(
      page.getByText(
        "WalkieTalkey har ikke længere adgang til Tilgængelighed.",
      ),
    ).toHaveCount(0, { timeout: 5000 });
  });

  test("a user who never granted Accessibility gets no 'forgot' notice", async ({
    page,
  }) => {
    await openApp(page, { permissions: { accessibility: false } });
    await page.waitForTimeout(500);
    await expect(
      page.getByText(
        "WalkieTalkey har ikke længere adgang til Tilgængelighed.",
      ),
    ).toHaveCount(0);
  });

  test("everything is reachable by keyboard with a visible focus ring", async ({
    page,
  }) => {
    await openApp(page);
    await page.keyboard.press("Tab");
    const focused = page.locator(":focus");
    await expect(focused).toBeVisible();
    const ring = await focused.evaluate((el) => getComputedStyle(el).boxShadow);
    expect(ring).not.toBe("none");
  });
});
