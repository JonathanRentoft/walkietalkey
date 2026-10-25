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
    // Five steps on a Mac until a dictation works; Telefon only comes after
    // one (run 5).
    await expect(page.getByRole("list", { name: "Trin 2 af 5" })).toBeVisible();
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
    // "Mikrofonen er klar" shows for ADVANCE_DELAY_MS only (see Tilgængelighed).
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

  test("Mikrofon: answered no before (run 5), the one click opens the exact pane at once", async ({
    page,
  }) => {
    await startAt(page, "microphone", { micAnswered: "denied" });
    const button = page
      .locator(".wt-onb-card")
      .getByRole("button", { name: "Åbn Systemindstillinger" });
    await expect(button).toBeVisible();
    await button.click();
    await expect
      .poll(async () =>
        (await calls(page, "plugin:opener|open_url")).map((c) => c.args.url),
      )
      .toContain(MICROPHONE_PANE);
    expect(await calls(page, "show_main_window_command")).toHaveLength(0);
    // macOS would show nothing for a question it has had its answer to.
    expect(
      await calls(
        page,
        "plugin:macos-permissions|request_microphone_permission",
      ),
    ).toHaveLength(0);
    await grant(page, "microphone");
    await expect(heading(page, "Tilgængelighed")).toBeVisible();
    expect(
      (await calls(page, "show_main_window_command")).length,
    ).toBeGreaterThan(0);
  });

  test("Tilgængelighed: one button repairs a stale entry, opens the exact pane, and the grant moves on with no restart", async ({
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
    // DESK-13: a reinstalled build can show WalkieTalkey switched on while
    // macOS does not trust it. The button first resets the app's own entry
    // and shows macOS's dialog, then opens the pane, so the switch works.
    const order = (await calls(page))
      .map((c) => c.cmd)
      .filter(
        (cmd) =>
          cmd === "wt_accessibility_repair" || cmd === "plugin:opener|open_url",
      );
    expect(order).toEqual([
      "wt_accessibility_repair",
      "plugin:opener|open_url",
    ]);
    await expect(
      page.getByText("Slå WalkieTalkey til. Så går vi videre af os selv."),
    ).toBeVisible();
    expect(await calls(page, "show_main_window_command")).toHaveLength(0);
    await grant(page, "accessibility");
    // "Tilgængelighed er slået til" shows for ADVANCE_DELAY_MS only, shorter than
    // Playwright's polling interval under load; the step moving on is what counts.
    await expect(heading(page, "Prøv det")).toBeVisible();
    // Run 5: System Settings is in front now; WalkieTalkey comes back by itself.
    expect(
      (await calls(page, "show_main_window_command")).length,
    ).toBeGreaterThan(0);
    const state = await mockState(page);
    expect(state.restarts).toBe(0);
  });

  /* Run 6: the picture looks like the real list in System Settings › Privacy & Security › Accessibility: a rounded
     list of about eight apps with neutral icons and grey bars instead of names, sorted so WalkieTalkey sits near the
     bottom where its W puts it, its switch highlighted, and the + and − buttons under the list. */
  test("Tilgængelighed: the picture is System Settings' list, with WalkieTalkey near the bottom and its switch highlighted", async ({
    page,
  }) => {
    await startAt(page, "accessibility", { permissions: { microphone: true } });
    const list = page.locator(".wt-onb-ax");
    await expect(list).toBeVisible();
    await expect(list).toHaveAttribute("aria-hidden", "true");
    const rows = list.locator(".wt-onb-ax-row");
    await expect(rows).toHaveCount(8);
    const names = await rows.evaluateAll((els) =>
      els.map((el) => el.querySelector(".wt-onb-ax-name")?.textContent ?? ""),
    );
    // Only WalkieTalkey has a name; every other app is a grey bar, never a real app's name.
    expect(names.filter(Boolean)).toEqual(["WalkieTalkey"]);
    const at = names.indexOf("WalkieTalkey");
    expect(at).toBeGreaterThanOrEqual(5);
    expect(at).toBeLessThan(8);
    await expect(list.locator(".wt-onb-ax-row .wt-onb-ax-bar")).toHaveCount(7);
    const mine = rows.nth(at);
    await expect(mine).toHaveClass(/wt-onb-ax-row--mine/);
    await expect(mine.locator(".wt-onb-ax-switch--mine")).toHaveCount(1);
    await expect(list.locator(".wt-onb-ax-switch--mine")).toHaveCount(1);
    // the + and − bar comes right under the list
    const bar = list.locator(".wt-onb-ax-tools");
    await expect(bar).toContainText("+");
    await expect(bar).toContainText("−");
    const [listBox, barBox] = await Promise.all([
      list.locator(".wt-onb-ax-list").boundingBox(),
      bar.boundingBox(),
    ]);
    expect(barBox!.y).toBeGreaterThanOrEqual(listBox!.y + listBox!.height - 1);
    // light and dark: the list follows the theme
    const bg = () =>
      list
        .locator(".wt-onb-ax-list")
        .evaluate((el) => getComputedStyle(el).backgroundColor);
    const light = await bg();
    // the app follows the system's appearance (lib/theme.ts)
    await page.emulateMedia({ colorScheme: "dark" });
    await expect.poll(bg).not.toBe(light);
  });

  /* Run 6: "Vis introduktionen igen" in Generelt replays the first-run screens so the owner can see them without a
     reset. It never touches permissions, the login item or the saved onboarding state. */
  test("Vis introduktionen igen replays every first-run screen without touching permissions", async ({
    page,
  }) => {
    await installMock(page, {
      downloaded: [EDDA],
      permissions: { microphone: true, accessibility: true },
      app: { selected_model: EDDA, onboarding_completed: true },
      wt: { onboarding_resume_step: "finished" },
    });
    await page.goto("/");
    await expect(page.getByRole("navigation")).toBeVisible();
    const before = await mockState(page);
    const earlier = (await calls(page)).length;
    await page.getByRole("button", { name: "Vis introduktionen igen" }).click();
    await expect(page.getByRole("heading", { name: welcome })).toBeVisible();
    await page.getByRole("button", { name: "Kom i gang" }).click();
    // Both permissions are granted, yet their screens are shown, as a new user sees them.
    await expect(heading(page, "Mikrofon")).toBeVisible();
    await page.getByRole("button", { name: "Giv adgang til mikrofonen" }).click();
    await expect(page.getByText("I gennemgangen ændrer WalkieTalkey ikke dine tilladelser.")).toBeVisible();
    await page.getByRole("button", { name: "Næste" }).click();
    await expect(heading(page, "Tilgængelighed")).toBeVisible();
    await expect(page.locator(".wt-onb-ax")).toBeVisible();
    await page.getByRole("button", { name: "Åbn Systemindstillinger" }).click();
    await page.getByRole("button", { name: "Næste" }).click();
    await expect(heading(page, "Prøv det")).toBeVisible();
    await page.getByRole("button", { name: "Næste" }).click();
    await expect(heading(page, "Telefon")).toBeVisible();
    await page.getByRole("button", { name: "Spring over" }).click();
    await expect(heading(page, "Klar")).toBeVisible();
    await page.getByRole("button", { name: "Færdig" }).click();
    await expect(page.getByRole("navigation")).toBeVisible();
    // Nothing that asks for, repairs or opens a permission, or changes the login item, was called.
    const touched = (await calls(page))
      .slice(earlier)
      .map((c) => c.cmd)
      .filter((cmd) =>
        /request_|accessibility_repair|open_url|open_microphone|autostart|reset/i.test(cmd),
      );
    expect(touched).toEqual([]);
    const after = await mockState(page);
    expect(after.wt.onboarding_resume_step).toBe("finished");
    expect(after.wt.phone_offer_pending).toBe(before.wt.phone_offer_pending);
    expect(after.app.autostart_enabled).toBe(before.app.autostart_enabled);
  });

  test("Vis introduktionen igen can be closed at any screen", async ({ page }) => {
    await installMock(page, {
      downloaded: [EDDA],
      permissions: { microphone: true, accessibility: true },
      app: { selected_model: EDDA, onboarding_completed: true },
      wt: { onboarding_resume_step: "finished" },
    });
    await page.goto("/");
    await page.getByRole("button", { name: "Vis introduktionen igen" }).click();
    await page.getByRole("button", { name: "Kom i gang" }).click();
    await expect(heading(page, "Mikrofon")).toBeVisible();
    await page.getByRole("button", { name: "Luk introduktionen" }).click();
    await expect(page.getByRole("navigation")).toBeVisible();
    expect((await mockState(page)).wt.onboarding_resume_step).toBe("finished");
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
    await emit(page, "wt-pill-end", { state: "pasted", shortcut: "⌘V" });
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
    await expect(page.getByRole("list", { name: "Trin 3 af 4" })).toBeVisible();
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

  test("Prøv det asks the backend whether the key listener runs, because its startup event came before the window (DESK-17)", async ({
    page,
  }) => {
    // The backend reported `wt-key-listener` once, at startup; no event comes.
    await startAt(page, "try", {
      permissions: { microphone: true, accessibility: true },
      keyListener: { running: false },
    });
    const warning = page.getByText("WalkieTalkey kan ikke se tasten endnu.");
    await expect(warning).toBeVisible();
    expect(
      (await calls(page, "wt_key_listener_status")).length,
    ).toBeGreaterThan(0);
    // Its button repairs the entry and opens the pane, as in Tilgængelighed.
    await page
      .locator(".wt-onb-card")
      .getByRole("button", { name: "Åbn Systemindstillinger" })
      .click();
    await expect
      .poll(async () => (await calls(page, "wt_accessibility_repair")).length)
      .toBe(1);
    await expect
      .poll(async () =>
        (await calls(page, "plugin:opener|open_url")).map((c) => c.args.url),
      )
      .toContain(ACCESSIBILITY_PANE);
    // The listener starts later: the event still counts.
    await emit(page, "wt-key-listener", { running: true });
    await expect(warning).toHaveCount(0);
  });

  test("Prøv det shows no warning when the key listener already runs", async ({
    page,
  }) => {
    await startAt(page, "try", {
      permissions: { microphone: true, accessibility: true },
      keyListener: { running: true },
    });
    await expect(heading(page, "Prøv det")).toBeVisible();
    await expect
      .poll(async () => (await calls(page, "wt_key_listener_status")).length)
      .toBeGreaterThan(0);
    await page.waitForTimeout(300);
    await expect(
      page.getByText("WalkieTalkey kan ikke se tasten endnu."),
    ).toHaveCount(0);
  });

  test("Windows: Prøv det lets a laptop without Right Ctrl choose its key, for example the Copilot key (DESK-21)", async ({
    page,
  }) => {
    await startAt(page, "try", {
      platform: "windows",
      permissions: { microphone: true },
    });
    await expect(
      page.getByText(
        "Hold Ctrl nede og sig: Hej, det her er min første diktering.",
      ),
    ).toBeVisible();
    await expect(page.getByText(/Copilot-tast/)).toBeVisible();
    await page.getByRole("button", { name: "Vælg en anden tast" }).click();
    await expect(
      page.getByText("Tryk på den tast, du vil bruge"),
    ).toBeVisible();
    await expect
      .poll(
        async () => (await calls(page, "start_handy_keys_recording")).length,
      )
      .toBe(1);
    // The Copilot key arrives as Win+Shift+F23.
    const copilot = {
      modifiers: ["super", "shift"],
      key: "f23",
      hotkey_string: "super+shift+f23",
    };
    await emit(page, "handy-keys-event", { ...copilot, is_key_down: true });
    await emit(page, "handy-keys-event", { ...copilot, is_key_down: false });
    await expect
      .poll(
        async () =>
          (await mockState(page)).app.bindings.transcribe.current_binding,
      )
      .toBe("super+shift+f23");
    await expect(
      page.getByText(
        "Hold Copilot-tasten nede og sig: Hej, det her er min første diktering.",
      ),
    ).toBeVisible();
    // Back in the field, where the test dictation is pasted.
    await expect(page.getByRole("textbox")).toBeFocused();
    // And back to Right Ctrl.
    await page.getByRole("button", { name: "Brug standardtasten" }).click();
    await expect
      .poll(
        async () =>
          (await mockState(page)).app.bindings.transcribe.current_binding,
      )
      .toBe("ctrl_right");
  });

  test("Mac: Prøv det has no key picker (third-party keyboards choose under Indstillinger › Tast)", async ({
    page,
  }) => {
    await startAt(page, "try", {
      permissions: { microphone: true, accessibility: true },
    });
    await expect(heading(page, "Prøv det")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Vælg en anden tast" }),
    ).toHaveCount(0);
  });

  test("run 5: Telefon comes only after a dictation that worked", async ({
    page,
  }) => {
    await startAt(page, "try", {
      permissions: { microphone: true, accessibility: true },
    });
    await expect(page.getByRole("list", { name: "Trin 4 af 5" })).toBeVisible();
    // Heard nothing: still no phone.
    await emit(page, "wt-pill-end", { state: "no_speech", shortcut: "⌘V" });
    await expect(page.getByRole("list", { name: "Trin 4 af 5" })).toBeVisible();
    // It worked: Telefon is next.
    await emit(page, "wt-pill-end", { state: "pasted", shortcut: "⌘V" });
    await expect(page.getByRole("list", { name: "Trin 4 af 6" })).toBeVisible();
    await page.getByRole("button", { name: "Næste" }).click();
    await expect(heading(page, "Telefon")).toBeVisible();
  });

  test("run 5: without a dictation that worked, Prøv det goes on to Klar, and the main window offers pairing once after the first one", async ({
    page,
  }) => {
    await startAt(page, "try", {
      permissions: { microphone: true, accessibility: true },
    });
    await page.getByRole("button", { name: "Næste" }).click();
    await expect(heading(page, "Klar")).toBeVisible();
    expect(await calls(page, "wt_pairing_start")).toHaveLength(0);
    await page.getByRole("button", { name: "Færdig" }).click();
    await expect(page.getByRole("navigation")).toBeVisible();
    expect((await mockState(page)).wt.phone_offer_pending).toBe(true);
    const offer = page.getByText("Vil du også kunne tale ind i telefonen?");
    // Not before a dictation has worked.
    await page.waitForTimeout(300);
    await expect(offer).toHaveCount(0);
    await emit(page, "wt-pill-end", { state: "no_speech", shortcut: "⌘V" });
    await page.waitForTimeout(200);
    await expect(offer).toHaveCount(0);
    await emit(page, "wt-pill-end", { state: "pasted", shortcut: "⌘V" });
    await expect(offer).toBeVisible();
    await page.getByRole("button", { name: "Par en telefon" }).first().click();
    await expect(
      page.getByRole("img", { name: "Kode til at parre en telefon" }),
    ).toBeVisible();
    // Offered once.
    await expect
      .poll(async () => (await mockState(page)).wt.phone_offer_pending)
      .toBe(false);
  });

  test("run 5: Ikke nu ends the phone offer for good", async ({ page }) => {
    await installMock(page, {
      downloaded: [EDDA],
      app: { selected_model: EDDA, onboarding_completed: true },
      wt: { onboarding_resume_step: "finished", phone_offer_pending: true },
      history: [
        {
          id: 1,
          timestamp: Math.floor(Date.now() / 1000) - 60,
          source: "tast",
          text: "Hej, det her er min første diktering.",
          cleaned: false,
          cleanup: null,
          has_audio: false,
        },
      ],
    });
    await page.goto("/");
    // A dictation worked before this window opened (the history has one).
    const offer = page.getByText("Vil du også kunne tale ind i telefonen?");
    await expect(offer).toBeVisible();
    await page.getByRole("button", { name: "Ikke nu" }).click();
    await expect(offer).toHaveCount(0);
    expect((await mockState(page)).wt.phone_offer_pending).toBe(false);
    expect(await calls(page, "wt_pairing_start")).toHaveLength(0);
  });

  test("run 5: an updated Mac says once that the phone must pair again", async ({
    page,
  }) => {
    await installMock(page, {
      downloaded: [EDDA],
      app: { selected_model: EDDA, onboarding_completed: true },
      wt: { onboarding_resume_step: "finished" },
      relay: {
        enabled: true,
        connected: false,
        phones: [],
        pairing_active: false,
        pair_again: true,
      },
    });
    await page.goto("/");
    const notice = page.getByText(
      "Telefonen skal parres igen efter opdateringen.",
    );
    await expect(notice).toBeVisible();
    await page.getByRole("button", { name: "Ikke nu" }).click();
    await expect(notice).toHaveCount(0);
    // Under Telefon it stays until a phone is paired.
    await page.getByRole("button", { name: "Telefon" }).click();
    await expect(notice).toBeVisible();
    // And the window does not say it again after a reload.
    await page.reload();
    await expect(page.getByRole("navigation")).toBeVisible();
    await page.getByRole("button", { name: "Generelt" }).click();
    await expect(notice).toHaveCount(0);
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
    // Telefon was not shown, so pairing is offered after a dictation works.
    expect(state.wt.phone_offer_pending).toBe(true);
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
