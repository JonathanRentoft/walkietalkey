/**
 * Screenshots of every phone screen and state at 1x and 2x on an iPhone-sized screen (393x852),
 * for the design review (brief Phase 4). On demand only:
 *
 *   E2E_SCREENS=/abs/out/dir bunx playwright test e2e/screens.spec.ts --project=webkit
 *
 * E2E_SCREENS_VIEWPORT=393x793 is what an iPhone 15 home-screen app gets below the status bar;
 * E2E_SCREENS_SCHEME=dark shows the dark theme (the design system previews PhoneApp in dark).
 *
 * Files are `<screen>-<state>@1x.png` and `@2x.png`, plus `glow-<seconds>s@<n>x.png` frames of a
 * long recording.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { devices, type Browser, type Page } from "@playwright/test";
import { ScriptedComputer } from "./computer";
import { installFakeMedia } from "./fake-media";
import { TcpProxy } from "./proxy";
import {
  APP_URL,
  RELAY_PORT,
  RELAY_URL,
  expect,
  holdButton,
  label,
  preparePage,
  press,
  qrConfig,
  setHidden,
  sub,
  tap,
  test,
} from "./helpers";

const OUT = process.env.E2E_SCREENS ?? "";
const SCALES = (process.env.E2E_SCREENS_SCALES ?? "1,2").split(",").map(Number);
/** Seconds into a recording at which the glow is captured. */
const GLOW_AT = (process.env.E2E_SCREENS_GLOW ?? "0,2,5,10,20,40")
  .split(",")
  .map(Number);

test.skip(!OUT, "screenshots only on demand (E2E_SCREENS=<dir>)");
test.describe.configure({ mode: "serial" });
test.setTimeout(10 * 60_000);

const [VW, VH] = (process.env.E2E_SCREENS_VIEWPORT ?? "393x852")
  .split("x")
  .map(Number) as [number, number];

const SCHEME = process.env.E2E_SCREENS_SCHEME === "dark" ? "dark" : "light";
const { defaultBrowserType: _engine, ...iphone } = devices["iPhone 15"];
/** The owner's computer: a name that the old chip cut off. */
const NAME = "Jonathans MacBook Pro";

async function newPage(browser: Browser, scale: number, standalone = true) {
  const context = await browser.newContext({
    ...iphone,
    viewport: { width: VW, height: VH },
    screen: { width: VW, height: VH },
    colorScheme: SCHEME,
    deviceScaleFactor: scale,
    baseURL: APP_URL,
  });
  const page = await context.newPage();
  if (standalone) await preparePage(page, "webkit");
  return page;
}

/** Waits for transitions to settle, then saves the screenshot. */
async function shot(page: Page, scale: number, name: string, settleMs = 900) {
  await page.waitForTimeout(settleMs);
  await page.screenshot({ path: join(OUT, `${name}@${scale}x.png`) });
}

for (const scale of SCALES) {
  test(`every screen and state @${scale}x`, async ({
    browser,
    browserName,
  }) => {
    test.skip(browserName !== "webkit", "iPhone screens: WebKit only");
    mkdirSync(OUT, { recursive: true });

    // A Safari tab on the iPhone (PHONE-04): install first.
    {
      const tab = await newPage(browser, scale, false);
      await tab.goto("/");
      await expect(
        tab.getByRole("heading", {
          name: "Føj WalkieTalkey til hjemmeskærmen for at bruge den",
        }),
      ).toBeVisible();
      await shot(tab, scale, "install-safari-tab");
      await tab.context().close();
    }

    const computer = await ScriptedComputer.create(RELAY_URL, NAME);
    await computer.connect();
    const proxy = await TcpProxy.start(RELAY_PORT);
    try {
      // The camera scanned the code: Safari opens the link in a tab (Phase 5).
      {
        const tab = await newPage(browser, scale, false);
        await tab.goto(
          await computer.pairingUrl(APP_URL, `ws://127.0.0.1:${proxy.port}`),
        );
        await expect(tab.getByText(`Den parrer med ${NAME}`)).toBeVisible();
        await shot(tab, scale, "install-safari-tab-from-link");
        await tab.context().close();
      }
      // The home-screen app's first launch without the link: the scanner opens by itself.
      {
        const page = await newPage(browser, scale, false);
        await page.addInitScript(installFakeMedia, {
          standalone: true,
          qr: { size: 21, bits: "0".repeat(21 * 21) },
        });
        await page.goto("/");
        await expect(page.locator(".wt-scan")).toBeVisible();
        await shot(page, scale, "onboarding-first-launch-scanner", 1500);
        await page.getByRole("button", { name: "Annullér" }).click();
        await expect(
          page.getByRole("heading", { name: "Par med en computer" }),
        ).toBeVisible();
        await shot(page, scale, "onboarding-pair");
        await page.context().close();
      }
      // A code that is not ours.
      {
        const page = await newPage(browser, scale, false);
        await page.addInitScript(installFakeMedia, {
          standalone: true,
          qr: qrConfig("https://example.com/not-a-code"),
        });
        await page.goto("/");
        await expect(
          page.getByText("Det er ikke en kode fra WalkieTalkey."),
        ).toBeVisible({ timeout: 20_000 });
        await shot(page, scale, "onboarding-scan-not-a-code");
        await page.context().close();
      }

      const page = await newPage(browser, scale);
      await page.clock.install();
      // The name screen, from the pairing link.
      const url = await computer.pairingUrl(
        APP_URL,
        `ws://127.0.0.1:${proxy.port}`,
      );
      await page.goto(url);
      await expect(
        page.getByRole("heading", { name: "Hvad hedder telefonen?" }),
      ).toBeVisible();
      await shot(page, scale, "onboarding-name");
      await page.getByRole("button", { name: "Par telefonen" }).click();
      await expect(holdButton(page)).toBeVisible();
      await computer.waitPhone();
      await expect(label(page)).toHaveText("Hold for at tale");
      await shot(page, scale, "main-idle", 1500);

      // Held (push-to-talk), then the finger slid off the button.
      computer.answer = () => null;
      {
        const p = await press(page);
        await expect(page.locator(".wt-app--rec")).toBeVisible();
        await shot(page, scale, "main-rec-hold", 1800);
        await p.slideOff();
        await expect(label(page)).toHaveText("Slip for at annullere");
        await shot(page, scale, "main-rec-slideoff");
        await p.release();
        await expect(label(page)).toHaveText("Hold for at tale");
      }

      // Hands-free: a quick tap starts a recording that goes on without the finger.
      await tap(page);
      await expect(label(page)).toHaveText("Tryk igen for at stoppe");
      await shot(page, scale, "main-rec-handsfree", 1800);
      // PHONE-29: the last 15 seconds count down.
      await page.clock.fastForward(4 * 60 * 1000 + 46 * 1000);
      await expect(page.getByRole("timer")).toBeVisible();
      await shot(page, scale, "main-rec-handsfree-countdown", 600);
      await tap(page);
      // No answer yet: sending.
      await expect(label(page)).toHaveText(`Sender til ${NAME}`);
      await shot(page, scale, "main-send", 1200);
      // PHONE-24: no result within 10 minutes.
      await page.clock.fastForward(10 * 60 * 1000 + 1000);
      await expect(label(page)).toHaveText(`Nåede ikke frem til ${NAME}.`);
      await shot(page, scale, "main-failed");
      const s = await computer.until(
        () =>
          [...computer.sessions.values()]
            .reverse()
            .find((x) => x.end && !x.cancelled && x.answered === 0),
        "the hands-free recording",
      );
      await computer.sendResult(s.sid, { ok: true });
      await expect(label(page)).toHaveText(`Klar på ${NAME}`);
      await shot(page, scale, "main-ready");

      // An error with Detaljer, and its sheet; paused; no speech.
      computer.answer = () => ({ ok: false, reason: "error" });
      await quick(page);
      await expect(label(page)).toHaveText("Noget gik galt. Prøv igen.");
      await shot(page, scale, "main-error");
      await sub(page).getByRole("button", { name: "Detaljer" }).click();
      await shot(page, scale, "main-error-details");
      await page.getByRole("button", { name: "OK", exact: true }).click();
      computer.answer = () => ({ ok: false, reason: "paused" });
      await quick(page);
      await expect(label(page)).toHaveText(`${NAME} er sat på pause.`);
      await shot(page, scale, "main-paused");
      computer.answer = () => ({ ok: false, reason: "no_speech" });
      await quick(page);
      await expect(label(page)).toHaveText("Hørte ikke noget");
      await shot(page, scale, "main-no-speech");

      // The computer is not online: the recording waits.
      computer.answer = () => ({ ok: true });
      computer.disconnect();
      await page.waitForTimeout(1500);
      await shot(page, scale, "main-idle-computer-away");
      await quick(page);
      await expect(label(page)).toHaveText(
        `${NAME} er ikke online. Optagelsen venter i 10 minutter.`,
      );
      await shot(page, scale, "main-offline");
      await computer.connect();
      await expect(label(page)).toHaveText(`Klar på ${NAME}`, {
        timeout: 20_000,
      });

      // No connection to the relay at all.
      proxy.blocked = true;
      proxy.dropAll();
      // Back from the background: a settled screen ("Klar på") goes back to idle.
      await page.evaluate(() =>
        document.dispatchEvent(new Event("visibilitychange")),
      );
      await expect(label(page)).toHaveText("Ingen forbindelse. Prøver igen.", {
        timeout: 15_000,
      });
      await shot(page, scale, "main-no-connection");
      proxy.blocked = false;
      await expect(label(page)).not.toHaveText(
        "Ingen forbindelse. Prøver igen.",
        { timeout: 20_000 },
      );

      // The computer picker and the settings.
      await page.locator(".wt-status").click();
      await expect(page.getByRole("dialog")).toBeVisible();
      await shot(page, scale, "main-picker");
      await page.getByRole("button", { name: "Indstillinger" }).click();
      await expect(
        page.getByRole("heading", { name: "Indstillinger" }),
      ).toBeVisible();
      await shot(page, scale, "settings-top");
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await shot(page, scale, "settings-bottom");
      await page.getByRole("button", { name: "Tilbage" }).click();
      await expect(holdButton(page)).toBeVisible();

      // The glow over a long recording, and after the app went to the background and back.
      computer.answer = () => ({ ok: true });
      {
        const p = await press(page);
        await expect(page.locator(".wt-app--rec")).toBeVisible();
        const t0 = Date.now();
        for (const at of GLOW_AT) {
          const wait = t0 + at * 1000 - Date.now();
          if (wait > 0) await page.waitForTimeout(wait);
          await page.screenshot({
            path: join(
              OUT,
              `glow-rec-${String(at).padStart(3, "0")}s@${scale}x.png`,
            ),
          });
        }
        // A hold, not a tap: it sends on release.
        await page.waitForTimeout(Math.max(0, t0 + 700 - Date.now()));
        await p.release();
      }
      await expect(label(page)).toHaveText(`Klar på ${NAME}`);
      await setHidden(page, true);
      await page.waitForTimeout(300);
      await setHidden(page, false);
      await expect(label(page)).toHaveText("Hold for at tale");
      {
        const p = await press(page);
        await expect(page.locator(".wt-app--rec")).toBeVisible();
        await shot(page, scale, "glow-rec-after-background", 2500);
        await p.release();
      }
      await page.context().close();
    } finally {
      await proxy.close();
      await computer.deleteRoom().catch(() => undefined);
    }
  });
}

/** A hold of 0.9 s: push-to-talk, it sends on release. */
async function quick(page: Page) {
  const p = await press(page);
  await expect(page.locator(".wt-app--rec")).toBeVisible();
  await page.waitForTimeout(900);
  await p.release();
  await expect(page.locator(".wt-app--rec")).toHaveCount(0);
}
