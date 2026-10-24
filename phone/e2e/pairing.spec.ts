import { devices } from "@playwright/test";
import {
  APP_URL,
  statusName,
  expect,
  holdButton,
  label,
  preparePage,
  qrConfig,
  test,
} from "./helpers";

test.describe("pairing (PHONE-10..15)", () => {
  test("opened from the pairing link: fragment removed, name prefilled and sent encrypted, keys kept", async ({
    page,
    browserName,
    newComputer,
  }) => {
    const computer = await newComputer("Jonathans MacBook");
    await preparePage(page, browserName);
    const url = await computer.pairingUrl(APP_URL);
    expect(url).toContain("/p#");
    await page.goto(url);
    await expect(
      page.getByRole("heading", { name: "Hvad hedder telefonen?" }),
    ).toBeVisible();
    // PHONE-15: the secrets are gone from the address bar (and so from history) at once.
    expect(page.url()).toBe(`${APP_URL}/`);
    expect(await page.evaluate(() => location.hash)).toBe("");
    // PHONE-12: prefilled, with the owner from the computer's name (Phase 5).
    await expect(page.getByLabel("Telefonens navn")).toHaveValue(
      browserName === "webkit" ? "Jonathans iPhone" : "Jonathans Android",
    );
    await page.getByLabel("Telefonens navn").fill("Testtelefon");
    await page.getByRole("button", { name: "Par telefonen" }).click();

    await expect(holdButton(page)).toBeVisible();
    await expect(statusName(page)).toHaveText("Jonathans MacBook");
    await expect(label(page)).toHaveText("Hold for at tale");
    await expect(
      page.getByText("Krypteret fra telefon til computer"),
    ).toBeVisible();
    const phone = await computer.waitPhone();
    expect(phone.name).toBe("Testtelefon");
    expect(phone.platform).toBe(browserName === "webkit" ? "ios" : "android");

    // PHONE-13: the pairing survives a restart, and the private keys are not extractable.
    await page.reload();
    await expect(statusName(page)).toHaveText("Jonathans MacBook");
    const keys = await page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const r = indexedDB.open("walkietalkey");
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
      const get = (store: string, key?: IDBValidKey) =>
        new Promise<unknown>((resolve) => {
          const tx = db.transaction(store);
          const r =
            key === undefined
              ? tx.objectStore(store).getAll()
              : tx.objectStore(store).get(key);
          r.onsuccess = () => resolve(r.result);
        });
      const device = (await get("device", "keys")) as {
        signing: CryptoKeyPair;
        agreement: CryptoKeyPair;
      };
      const rooms = (await get("rooms")) as {
        keys: { p2c: CryptoKey; c2p: CryptoKey };
      }[];
      let exported = false;
      try {
        await crypto.subtle.exportKey("pkcs8", device.signing.privateKey);
        exported = true;
      } catch {
        /* expected */
      }
      return {
        signing: device.signing.privateKey.extractable,
        agreement: device.agreement.privateKey.extractable,
        pair: rooms.map((r) => [
          r.keys.p2c.extractable,
          r.keys.c2p.extractable,
        ]),
        exported,
        stores: Array.from(db.objectStoreNames).sort(),
      };
    });
    expect(keys).toEqual({
      signing: false,
      agreement: false,
      pair: [[false, false]],
      exported: false,
      stores: ["counters", "device", "pendingLeaves", "rooms", "settings"],
    });
  });

  test("scanning the QR code in the app (QR decoding in JavaScript)", async ({
    page,
    browserName,
    newComputer,
  }) => {
    const computer = await newComputer("Kontor-PC", "win");
    const url = await computer.pairingUrl("https://app.walkietalkey.com");
    await preparePage(page, browserName, { qr: qrConfig(url) });
    await page.goto("/");
    // The home-screen app (WebKit here) opens the scanner by itself on its first launch (Phase 5);
    // in a browser tab the first screen is PHONE-10's "Par med en computer".
    if (browserName !== "webkit") {
      await expect(
        page.getByRole("heading", { name: "Par med en computer" }),
      ).toBeVisible();
      await page
        .getByRole("button", { name: "Scan koden på din computer" })
        .click();
    }
    await expect(
      page.getByRole("heading", { name: "Hvad hedder telefonen?" }),
    ).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText("Navnet vises på Kontor-PC")).toBeVisible();
    await page.getByRole("button", { name: "Par telefonen" }).click();
    await expect(statusName(page)).toHaveText("Kontor-PC");
    expect((await computer.waitPhone()).name).toBe(
      browserName === "webkit" ? "iPhone" : "Android",
    );
  });

  test("an expired or used code says so", async ({
    page,
    browserName,
    newComputer,
  }) => {
    const computer = await newComputer();
    await preparePage(page, browserName);
    const url = await computer.pairingUrl(APP_URL);
    await computer.cancelAdmission();
    await page.goto(url);
    await page.getByRole("button", { name: "Par telefonen" }).click();
    await expect(
      page.getByRole("heading", {
        name: "Koden er udløbet. Lav en ny på computeren.",
      }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Annullér" }).click();
    await expect(
      page.getByRole("heading", { name: "Par med en computer" }),
    ).toBeVisible();
    expect(computer.phones.size).toBe(0);
  });

  test("a link that is not a pairing code is refused and removed", async ({
    page,
    browserName,
  }) => {
    await preparePage(page, browserName);
    await page.goto("/p#bm90LWEtY29kZQ");
    expect(page.url()).toBe(`${APP_URL}/`);
    await expect(
      page.getByText("Det er ikke en kode fra WalkieTalkey."),
    ).toBeVisible();
  });
});

test.describe("iPhone in a Safari tab (PHONE-04) and the home-screen app (Phase 5)", () => {
  test("asks to install, and a pairing link never joins", async ({
    browser,
    newComputer,
  }) => {
    const { defaultBrowserType: _engine, ...iphone } = devices["iPhone 15"];
    const context = await browser.newContext({ ...iphone, baseURL: APP_URL });
    const page = await context.newPage();
    await page.goto("/");
    await expect(
      page.getByRole("heading", {
        name: "Føj WalkieTalkey til hjemmeskærmen for at bruge den",
      }),
    ).toBeVisible();
    await expect(
      page.getByText("Tryk på Del-knappen nederst i Safari."),
    ).toBeVisible();

    const computer = await newComputer();
    const url = await computer.pairingUrl(APP_URL);
    await page.goto(url);
    await expect(
      page.getByRole("heading", {
        name: "Føj WalkieTalkey til hjemmeskærmen for at bruge den",
      }),
    ).toBeVisible();
    await expect(
      page.getByText(
        "Åbn WalkieTalkey fra hjemmeskærmen. Den parrer med Testcomputer med det samme.",
      ),
    ).toBeVisible();
    await expect(
      page.getByText("Åbn WalkieTalkey fra hjemmeskærmen og scan koden der."),
    ).toBeVisible();
    // The link stays in the address bar for the home-screen app.
    expect(page.url()).toBe(url);
    await page.waitForTimeout(1500);
    expect(computer.phones.size).toBe(0);
    expect(computer.log.some((l) => l.startsWith("joined"))).toBe(false);
    // No keys were created in the tab.
    const dbs = await page.evaluate(async () =>
      ((await indexedDB.databases?.()) ?? []).map((d) => d.name),
    );
    expect(dbs).not.toContain("walkietalkey");
    // Another code is scanned while the tab is open: the page follows the new link.
    const other = await newComputer("Kontor-PC", "win");
    const second = await other.pairingUrl(APP_URL);
    await page.evaluate((u) => (location.href = u), second);
    await expect(page).toHaveURL(second);
    await expect(
      page.getByText("Den parrer med Kontor-PC med det samme."),
    ).toBeVisible();
    // An invalid link is removed and says to scan in the app, as before.
    await page.goto(`${APP_URL}/`);
    await page.goto(`${APP_URL}/p#bm90LWEtY29kZQ`);
    await expect(
      page.getByRole("heading", {
        name: "Åbn WalkieTalkey fra hjemmeskærmen og scan koden der.",
      }),
    ).toBeVisible();
    expect(page.url()).toBe(`${APP_URL}/`);
    await context.close();
  });

  test("added to the home screen from the link, the app pairs on its first launch without a second scan, once", async ({
    browser,
    browserName,
    newComputer,
  }) => {
    const { defaultBrowserType: _engine, ...iphone } = devices["iPhone 15"];
    const computer = await newComputer("Jonathans MacBook");
    const url = await computer.pairingUrl(APP_URL);

    // Scanned with the camera: Safari opens the link in a tab.
    const tabContext = await browser.newContext({
      ...iphone,
      baseURL: APP_URL,
    });
    const tab = await tabContext.newPage();
    await tab.goto(url);
    await expect(
      tab.getByText("Den parrer med Jonathans MacBook med det samme."),
    ).toBeVisible();
    // "Føj til hjemmeskærm" saves the page's URL: the manifest it links has no start_url.
    const manifest = await tab.evaluate(
      () =>
        document.querySelector<HTMLLinkElement>('link[rel="manifest"]')!.href,
    );
    expect(manifest).toBe(`${APP_URL}/manifest-ios.webmanifest`);
    const m = await (await tab.request.get(manifest)).json();
    expect(m.start_url).toBeUndefined();
    expect(m).toMatchObject({ id: "./", scope: "./", display: "standalone" });
    const startUrl = tab.url();
    expect(startUrl).toBe(url);
    await tabContext.close();
    expect(computer.phones.size).toBe(0);

    // The home-screen app: its own storage, started at that URL.
    const appContext = await browser.newContext({
      ...iphone,
      baseURL: APP_URL,
    });
    const app = await appContext.newPage();
    await preparePage(app, browserName, { standalone: true });
    await app.goto(startUrl);
    await expect(
      app.getByRole("heading", { name: "Hvad hedder telefonen?" }),
    ).toBeVisible();
    expect(app.url()).toBe(`${APP_URL}/`);
    // Closed before pairing (iOS killed it, say): the next launch still offers the link.
    await app.goto(startUrl);
    await expect(
      app.getByRole("heading", { name: "Hvad hedder telefonen?" }),
    ).toBeVisible();
    // PHONE-12: prefilled from the computer's name.
    await expect(app.getByLabel("Telefonens navn")).toHaveValue(
      "Jonathans iPhone",
    );
    await app.getByRole("button", { name: "Par telefonen" }).click();
    await expect(statusName(app)).toHaveText("Jonathans MacBook");
    expect((await computer.waitPhone()).name).toBe("Jonathans iPhone");

    // Every later launch starts at the same URL: the used link is ignored, no error, no join.
    await app.goto(startUrl);
    await expect(holdButton(app)).toBeVisible();
    await expect(statusName(app)).toHaveText("Jonathans MacBook");
    await app.waitForTimeout(1000);
    await expect(
      app.getByRole("heading", { name: "Hvad hedder telefonen?" }),
    ).toHaveCount(0);
    expect(computer.log.filter((l) => l.startsWith("joined")).length).toBe(1);
    await appContext.close();
  });

  test("an expired link in the home-screen app says so once; later launches are normal", async ({
    page,
    browserName,
    newComputer,
  }) => {
    const computer = await newComputer();
    const url = await computer.pairingUrl(APP_URL);
    await computer.cancelAdmission();
    await preparePage(page, browserName, { standalone: true });
    await page.goto(url);
    await page.getByRole("button", { name: "Par telefonen" }).click();
    await expect(
      page.getByRole("heading", {
        name: "Koden er udløbet. Lav en ny på computeren.",
      }),
    ).toBeVisible();
    await page.goto(url);
    await expect(
      page.getByRole("heading", { name: "Par med en computer" }),
    ).toBeVisible();
    await page.waitForTimeout(500);
    await expect(
      page.getByRole("heading", { name: "Hvad hedder telefonen?" }),
    ).toHaveCount(0);
    expect(computer.phones.size).toBe(0);
  });

  test("if iOS drops the link, the first launch opens the scanner by itself, and only the first", async ({
    page,
    browserName,
  }) => {
    await preparePage(page, browserName, { standalone: true });
    await page.goto("/");
    await expect(page.locator(".wt-scan")).toBeVisible();
    await page.getByRole("button", { name: "Annullér" }).click();
    await expect(
      page.getByRole("heading", { name: "Par med en computer" }),
    ).toBeVisible();
    await page.reload();
    await expect(
      page.getByRole("heading", { name: "Par med en computer" }),
    ).toBeVisible();
    await page.waitForTimeout(500);
    await expect(page.locator(".wt-scan")).toHaveCount(0);
  });

  test("a browser tab (Android) shows the first screen, not the scanner", async ({
    page,
    browserName,
  }) => {
    test.skip(
      browserName === "webkit",
      "the WebKit project is the home-screen app",
    );
    await preparePage(page, browserName);
    await page.goto("/");
    await expect(
      page.getByRole("heading", { name: "Par med en computer" }),
    ).toBeVisible();
    await page.waitForTimeout(500);
    await expect(page.locator(".wt-scan")).toHaveCount(0);
  });
});
