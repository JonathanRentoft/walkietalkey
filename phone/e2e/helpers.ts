import { test as base, expect, type Page } from "@playwright/test";
import QRCode from "qrcode";
import type { ComputerOs } from "@walkietalkey/protocol";
import { testSignal } from "./audio";
import { ScriptedComputer } from "./computer";
import { installFakeMedia, type FakeMediaConfig } from "./fake-media";

export const APP_URL = `http://127.0.0.1:${Number(process.env.E2E_APP_PORT || 4173)}`;
export const RELAY_PORT = Number(process.env.E2E_RELAY_PORT || 8787);
export const RELAY_URL = `ws://127.0.0.1:${RELAY_PORT}`;

const SIGNAL_B64 = Buffer.from(testSignal().buffer).toString("base64");

export const test = base.extend<{
  newComputer: (name?: string, os?: ComputerOs) => Promise<ScriptedComputer>;
}>({
  newComputer: async ({}, use) => {
    const made: ScriptedComputer[] = [];
    await use(async (name = "Testcomputer", os: ComputerOs = "mac") => {
      const c = await ScriptedComputer.create(RELAY_URL, name, os);
      await c.connect();
      made.push(c);
      return c;
    });
    for (const c of made) await c.deleteRoom().catch(() => undefined);
  },
});

export { expect };

/** Fake media per engine: Chromium's microphone comes from the launch flags; WebKit's from the init script. */
export async function preparePage(
  page: Page,
  browserName: string,
  extra: FakeMediaConfig = {},
): Promise<void> {
  const cfg: FakeMediaConfig = { ...extra };
  if (browserName === "webkit") {
    cfg.audio = SIGNAL_B64;
    cfg.standalone = extra.standalone ?? true;
  }
  await page.addInitScript(installFakeMedia, cfg);
}

export function qrConfig(text: string): { size: number; bits: string } {
  const qr = QRCode.create(text, { errorCorrectionLevel: "M" });
  let bits = "";
  for (let y = 0; y < qr.modules.size; y++)
    for (let x = 0; x < qr.modules.size; x++)
      bits += qr.modules.get(y, x) ? "1" : "0";
  return { size: qr.modules.size, bits };
}

export const holdButton = (page: Page) => page.locator("button.wt-hold");
export const label = (page: Page) =>
  page.locator(".wt-app-label > span:last-child");
export const sub = (page: Page) => page.locator(".wt-app-sub");
/** The target computer's name in the status line at the top; tapping it opens the picker. */
export const statusName = (page: Page) => page.locator(".wt-status-name");

/** Pairs through the link the computer shows (the app opened from the QR's URL, PHONE-11). */
export async function pairByLink(
  page: Page,
  computer: ScriptedComputer,
  opts: { name?: string; relayUrl?: string } = {},
) {
  const url = await computer.pairingUrl(APP_URL, opts.relayUrl);
  await page.goto(url);
  await expect(
    page.getByRole("heading", { name: "Hvad hedder telefonen?" }),
  ).toBeVisible();
  if (opts.name) await page.getByLabel("Telefonens navn").fill(opts.name);
  await page.getByRole("button", { name: "Par telefonen" }).click();
  await expect(holdButton(page)).toBeVisible();
  await expect(statusName(page)).toHaveText(computer.name);
  const phone = await computer.waitPhone();
  await expect(label(page)).toHaveText("Hold for at tale");
  return phone;
}

async function center(page: Page) {
  const box = (await holdButton(page).boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2, h: box.height };
}

/** Presses the big button and keeps holding until `release()` is called. */
export async function press(page: Page) {
  const c = await center(page);
  await page.mouse.move(c.x, c.y);
  await page.mouse.down();
  return {
    slideOff: () => page.mouse.move(c.x, c.y + c.h * 1.6, { steps: 4 }),
    slideBack: () => page.mouse.move(c.x, c.y, { steps: 4 }),
    release: () => page.mouse.up(),
  };
}

/** Holds the button for at least `ms` (push-to-talk when that is 0.5 s or more, PHONE-26). */
export async function hold(page: Page, ms: number): Promise<void> {
  const p = await press(page);
  await expect(label(page)).toHaveText("Slip for at sende");
  await page.waitForTimeout(ms);
  await p.release();
}

/**
 * The unpaired app's first screen (PHONE-10). A home-screen app's first launch opens the scanner
 * by itself (run 2, Phase 5); this closes it.
 */
export async function closeScannerIfOpen(page: Page): Promise<void> {
  const heading = page.getByRole("heading", { name: "Par med en computer" });
  const scan = page.locator(".wt-scan");
  await expect(heading.or(scan)).toBeVisible();
  if (await scan.isVisible())
    await page.getByRole("button", { name: "Annullér" }).click();
  await expect(heading).toBeVisible();
}

/** A quick tap on the big button (released well within 0.5 s): hands-free. */
export async function tap(page: Page): Promise<void> {
  const c = await center(page);
  await page.mouse.move(c.x, c.y);
  await page.mouse.down();
  await page.mouse.up();
}

/** The microphone streams the app opened (recorded by the fake-media init script). */
export async function mics(page: Page) {
  return page.evaluate(() => {
    const list =
      (
        window as unknown as {
          __wtMics?: { stream: MediaStream; constraints: unknown }[];
        }
      ).__wtMics ?? [];
    return {
      opened: list.length,
      live: list.filter((m) =>
        m.stream.getAudioTracks().some((t) => t.readyState === "live"),
      ).length,
      constraints: list.map((m) => m.constraints),
    };
  });
}

/** The page goes to the background (or comes back): visibilitychange, pagehide and pageshow. */
export async function setHidden(page: Page, hidden: boolean): Promise<void> {
  await page.evaluate((h) => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => (h ? "hidden" : "visible"),
    });
    Object.defineProperty(document, "hidden", {
      configurable: true,
      get: () => h,
    });
    if (h) {
      document.dispatchEvent(new Event("visibilitychange"));
      window.dispatchEvent(
        new PageTransitionEvent("pagehide", { persisted: true }),
      );
    } else {
      window.dispatchEvent(
        new PageTransitionEvent("pageshow", { persisted: true }),
      );
      document.dispatchEvent(new Event("visibilitychange"));
    }
  }, hidden);
}
