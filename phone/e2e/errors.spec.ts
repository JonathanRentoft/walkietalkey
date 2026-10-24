import {
  statusName,
  expect,
  hold,
  label,
  pairByLink,
  preparePage,
  press,
  sub,
  test,
} from "./helpers";

test.describe("errors (PHONE-14, PHONE-25, PHONE-30)", () => {
  test("the computer removes the phone: 4401, the pairing and its keys are dropped", async ({
    page,
    browserName,
    newComputer,
  }) => {
    const computer = await newComputer("MacBook");
    await preparePage(page, browserName);
    const phone = await pairByLink(page, computer);
    await computer.revoke(phone.id);
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toContainText(
      "Parringen med MacBook er fjernet. Par igen for at bruge den.",
    );
    await dialog.getByRole("button", { name: "OK" }).click();
    await expect(
      page.getByRole("heading", { name: "Par med en computer" }),
    ).toBeVisible();
    const rooms = await page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((resolve) => {
        const r = indexedDB.open("walkietalkey");
        r.onsuccess = () => resolve(r.result);
      });
      return new Promise<number>((resolve) => {
        const r = db.transaction("rooms").objectStore("rooms").count();
        r.onsuccess = () => resolve(r.result);
      });
    });
    expect(rooms).toBe(0);
    await page.reload();
    await expect(
      page.getByRole("heading", { name: "Par med en computer" }),
    ).toBeVisible();
  });

  test("a room that no longer exists (4404) is dropped too", async ({
    page,
    browserName,
    newComputer,
  }) => {
    const computer = await newComputer("Gammel Mac");
    await preparePage(page, browserName);
    await pairByLink(page, computer);
    await computer.deleteRoom();
    await expect(page.getByRole("alertdialog")).toContainText(
      "Parringen med Gammel Mac er fjernet. Par igen for at bruge den.",
    );
    // Run 5: one button, "Par igen", straight to pairing.
    await page.getByRole("button", { name: "Par igen" }).click();
    await expect(
      page.getByRole("button", { name: "Scan koden på din computer" }),
    ).toBeVisible();
  });

  test("results: no speech, paused, and an error with Detaljer", async ({
    page,
    browserName,
    newComputer,
  }) => {
    const computer = await newComputer();
    await preparePage(page, browserName);
    await pairByLink(page, computer);

    computer.answer = () => ({ ok: false, reason: "no_speech" });
    await hold(page, 700);
    await expect(label(page)).toHaveText("Hørte ikke noget");

    computer.answer = () => ({ ok: false, reason: "paused" });
    await hold(page, 700);
    await expect(label(page)).toHaveText("Testcomputer er sat på pause.");

    computer.answer = () => ({ ok: false, reason: "model_not_ready" });
    await hold(page, 700);
    await expect(label(page)).toHaveText("Noget gik galt. Prøv igen.");
    await sub(page).getByRole("button", { name: "Detaljer" }).click();
    const details = page.getByRole("dialog", { name: "Detaljer" });
    await expect(details).toContainText("Talemodellen er ikke klar endnu");
    await expect(details).toContainText("model_not_ready");
    await details.getByRole("button", { name: "OK" }).click();

    computer.answer = () => ({ ok: true });
    await hold(page, 700);
    await expect(label(page)).toHaveText("Klar på Testcomputer");
  });

  test("the microphone is refused", async ({
    page,
    browserName,
    newComputer,
  }) => {
    const computer = await newComputer();
    await preparePage(page, browserName, { denyMic: true });
    await pairByLink(page, computer);
    const p = await press(page, { warm: false });
    await expect(label(page)).toHaveText(
      "WalkieTalkey skal bruge mikrofonen. Slå den til i indstillingerne.",
    );
    await p.release();
    await expect(label(page)).toHaveText(
      "WalkieTalkey skal bruge mikrofonen. Slå den til i indstillingerne.",
    );
    await expect(statusName(page)).toHaveText("Testcomputer");
  });

  test("no result in 10 minutes: Nåede ikke frem, and Prøv igen resends from memory", async ({
    page,
    browserName,
    newComputer,
  }) => {
    const computer = await newComputer();
    await preparePage(page, browserName);
    await page.clock.install();
    await pairByLink(page, computer);
    computer.answer = () => null;
    await hold(page, 800);
    await expect(label(page)).toHaveText("Sender til Testcomputer");
    const first = await computer.waitEnded();
    await page.clock.fastForward(10 * 60 * 1000 + 1000);
    await expect(label(page)).toHaveText("Nåede ikke frem til Testcomputer.");
    computer.answer = () => ({ ok: true });
    await sub(page).getByRole("button", { name: "Prøv igen" }).click();
    await computer.until(() => first.starts >= 2, "the resend");
    await expect(label(page)).toHaveText("Klar på Testcomputer");
    expect(first.mismatches).toBe(0);
  });
});
