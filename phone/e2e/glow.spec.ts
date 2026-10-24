/**
 * The glow around the big button is never clipped (run 2, owner finding 5, Phase 4 "Phone").
 * The short checks run in the normal suite; the slow one runs on demand:
 *
 *   E2E_GLOW_MINUTES=5 bunx playwright test e2e/glow.spec.ts --project=webkit
 */
import type { Page } from "@playwright/test";
import type { ScriptedComputer } from "./computer";
import { MAX_GLOW_STEP, glowClipRisks, measureGlow } from "./glow";
import {
  expect,
  label,
  pairByLink,
  preparePage,
  press,
  setHidden,
  tap,
  test,
} from "./helpers";

const MINUTES = Number(process.env.E2E_GLOW_MINUTES || 0);
/** Rays that may show a step without it being a cut-off (rendering noise). */
const MAX_NOISY_RAYS = 2;

/** Lets a state change's transitions (0.6 s at most) finish. */
const settle = (page: Page) => page.waitForTimeout(900);

async function expectUnclipped(page: Page, state: string, minStrength = 3) {
  const r = await measureGlow(page);
  if (process.env.E2E_GLOW_LOG)
    console.log(
      `${state}: step ${r.maxStep}, ${r.steppedRays} rays, strength ${r.strength}`,
    );
  // A cut-off shows on many rays (the self-check below sees 26 to 49); allow a stray pixel or two.
  expect(
    r.steppedRays,
    `${state}: steps above ${MAX_GLOW_STEP} levels on ${r.steppedRays}/${r.rays} rays, the largest ${r.maxStep} at r=${r.at.r}px, ${r.at.angle} deg`,
  ).toBeLessThanOrEqual(MAX_NOISY_RAYS);
  expect(r.strength, `${state}: the glow is visible`).toBeGreaterThan(
    minStrength,
  );
  return r;
}

/** One round through every state of the main screen, checking the glow in each. */
async function everyState(page: Page, computer: ScriptedComputer) {
  await expectUnclipped(page, "idle");

  // Held (push-to-talk), then sending while the computer has not answered yet.
  computer.answer = () => null;
  const p = await press(page);
  await expect(label(page)).toHaveText("Slip for at sende");
  await settle(page);
  await expectUnclipped(page, "rec hold", 20);
  await page.waitForTimeout(1200);
  await expectUnclipped(page, "rec hold, later", 20);
  await p.release();
  await expect(label(page)).toHaveText(`Sender til ${computer.name}`);
  await settle(page);
  await expectUnclipped(page, "send");
  const s = await computer.until(
    () =>
      [...computer.sessions.values()]
        .reverse()
        .find((x) => x.end && !x.cancelled && x.answered === 0),
    "the held recording",
  );
  await computer.sendResult(s.sid, { ok: true });
  await expect(label(page)).toHaveText(`Klar på ${computer.name}`);
  await settle(page);
  await expectUnclipped(page, "ready");

  // Hands-free.
  computer.answer = () => ({ ok: true });
  await tap(page);
  await expect(label(page)).toHaveText("Tryk igen for at stoppe");
  await settle(page);
  await expectUnclipped(page, "rec hands-free", 20);
  await tap(page);
  await expect(label(page)).toHaveText(`Klar på ${computer.name}`);

  // An error.
  computer.answer = () => ({ ok: false, reason: "error" });
  await holdFor(page, 700);
  await expect(label(page)).toHaveText("Noget gik galt. Prøv igen.");
  await settle(page);
  await expectUnclipped(page, "error", 1);

  // The computer is not online.
  computer.answer = () => ({ ok: true });
  computer.disconnect();
  await holdFor(page, 700);
  await expect(label(page)).toHaveText(
    `${computer.name} er ikke online. Optagelsen venter i 10 minutter.`,
  );
  await settle(page);
  await expectUnclipped(page, "offline", 1);
  await computer.connect();
  await expect(label(page)).toHaveText(`Klar på ${computer.name}`, {
    timeout: 20_000,
  });

  // To the background and back.
  await setHidden(page, true);
  await page.waitForTimeout(300);
  await setHidden(page, false);
  await expect(label(page)).toHaveText("Hold for at tale");
  await settle(page);
  await expectUnclipped(page, "idle after the background");
  const q = await press(page);
  await expect(label(page)).toHaveText("Slip for at sende");
  await settle(page);
  await expectUnclipped(page, "rec after the background", 20);
  await q.release();
  await expect(label(page)).toHaveText(`Klar på ${computer.name}`);
}

async function holdFor(page: Page, ms: number) {
  const p = await press(page);
  await expect(label(page)).toHaveText("Slip for at sende");
  await page.waitForTimeout(ms);
  await p.release();
}

test.describe("the glow around the button is never clipped (Phase 4)", () => {
  test("no glow layer paints outside its own box, and only the screen clips it", async ({
    page,
    browserName,
    newComputer,
  }) => {
    const computer = await newComputer();
    await preparePage(page, browserName);
    await pairByLink(page, computer);
    expect(await glowClipRisks(page)).toEqual([]);
    const p = await press(page);
    await settle(page);
    expect(await glowClipRisks(page)).toEqual([]);
    await p.release();
  });

  test("the pixel check catches a square cut-off", async ({
    page,
    browserName,
    newComputer,
  }) => {
    const computer = await newComputer();
    await preparePage(page, browserName);
    await pairByLink(page, computer);
    const p = await press(page);
    await settle(page);
    const cut = async (css: string) => {
      const style = await page.addStyleTag({ content: css });
      await page.waitForTimeout(200);
      const r = await measureGlow(page);
      await style.evaluate((el) => (el as Element).remove());
      return r;
    };
    // v1 on an iPhone home-screen app: PhoneApp's box, narrower than the screen, clipped.
    const v1 = await cut(
      ".wt-stage-inner { width: calc(100% - 26px) !important; } .wt-stage .wt-app { overflow: hidden !important; }",
    );
    if (process.env.E2E_GLOW_LOG) console.log("v1 cut", v1);
    expect(v1.maxStep).toBeGreaterThan(MAX_GLOW_STEP);
    expect(v1.steppedRays).toBeGreaterThanOrEqual(8);
    // A compositing layer cut to a square a little larger than the button.
    const square = await cut(".wt-app-btnwrap { clip-path: inset(-2.5em); }");
    if (process.env.E2E_GLOW_LOG) console.log("square cut", square);
    expect(square.maxStep).toBeGreaterThan(MAX_GLOW_STEP);
    expect(square.steppedRays).toBeGreaterThanOrEqual(8);
    // And without either: clean.
    expect((await measureGlow(page)).steppedRays).toBeLessThanOrEqual(
      MAX_NOISY_RAYS,
    );
    await p.release();
  });

  test("every state, and after the background: no cut-off", async ({
    page,
    browserName,
    newComputer,
  }) => {
    const computer = await newComputer("MacBook");
    await preparePage(page, browserName);
    await pairByLink(page, computer);
    await everyState(page, computer);
  });

  test("minutes of state changes (slow, on demand)", async ({
    page,
    browserName,
    newComputer,
  }) => {
    test.skip(!MINUTES, "E2E_GLOW_MINUTES=<n> runs it");
    test.setTimeout((MINUTES + 3) * 60_000);
    const computer = await newComputer("MacBook");
    await preparePage(page, browserName);
    await pairByLink(page, computer);
    const end = Date.now() + MINUTES * 60_000;
    let rounds = 0;
    while (Date.now() < end) {
      await everyState(page, computer);
      // A long hands-free recording, checked every few seconds.
      await tap(page);
      await expect(label(page)).toHaveText("Tryk igen for at stoppe");
      for (let i = 0; i < 6; i++) {
        await page.waitForTimeout(2500);
        await expectUnclipped(page, `long hands-free, ${i * 2.5} s`, 20);
      }
      await tap(page);
      await expect(label(page)).toHaveText(`Klar på ${computer.name}`);
      rounds++;
    }
    expect(rounds).toBeGreaterThan(0);
  });
});
