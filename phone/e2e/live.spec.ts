/* Opt-in live check of a deployment: E2E_LIVE=1 [E2E_LIVE_APP=https://app.walkietalkey.com]
   [E2E_LIVE_RELAY=wss://relay.walkietalkey.com] npx playwright test e2e/live.spec.ts --project=chromium
   Pairs the deployed app with a scripted computer on the live relay, records, and cleans up. */
import { ScriptedComputer } from "./computer";
import {
  statusName,
  expect,
  hold,
  holdButton,
  label,
  preparePage,
  test,
} from "./helpers";

const APP = process.env.E2E_LIVE_APP || "https://app.walkietalkey.com";
const RELAY = process.env.E2E_LIVE_RELAY || "wss://relay.walkietalkey.com";

test("live: the deployed app pairs and streams through the live relay", async ({
  page,
  browserName,
}) => {
  test.skip(
    !process.env.E2E_LIVE,
    "set E2E_LIVE=1 to run against the deployment",
  );
  const computer = await ScriptedComputer.create(RELAY, "Live testcomputer");
  await computer.connect();
  try {
    await preparePage(page, browserName);
    await page.goto(await computer.pairingUrl(APP));
    expect(page.url()).toBe(`${APP}/`);
    await page.getByRole("button", { name: "Par telefonen" }).click();
    await expect(holdButton(page)).toBeVisible();
    await expect(statusName(page)).toHaveText("Live testcomputer");
    await computer.waitPhone();
    await hold(page, 1500);
    const s = await computer.waitEnded(20_000);
    expect(s.blocks.size).toBe(s.end!.chunks);
    await expect(label(page)).toHaveText("Klar på Live testcomputer");
  } finally {
    await computer.deleteRoom().catch(() => undefined);
  }
});
