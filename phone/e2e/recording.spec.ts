import { bestCorrelation, bytesToInt16, rms } from "./audio";
import { ScriptedComputer } from "./computer";
import { RELAY_PORT, chip, expect, hold, holdButton, label, pairByLink, preparePage, press, sub, test } from "./helpers";
import { TcpProxy } from "./proxy";

test.describe("recording and streaming (PHONE-20..23, PHONE-30..32)", () => {
  test("streams 200 ms blocks while talking; the computer gets the audio; Klar på and ⌘V", async ({ page, browserName, newComputer }) => {
    const computer = await newComputer("MacBook");
    await preparePage(page, browserName);
    await pairByLink(page, computer);

    const p = await press(page);
    await expect(label(page)).toHaveText("Slip for at sende");
    await expect(page.locator(".wt-app--rec")).toBeVisible();
    // PHONE-31: blocks reach the computer while the button is still held.
    const live = await computer.waitSession((s) => s.blocks.size >= 3, "three live blocks", 10_000);
    expect(live.end).toBeNull();
    await page.waitForTimeout(1500);
    await p.release();

    const s = await computer.waitEnded();
    expect(s.starts).toBe(1);
    expect(s.duplicates).toBe(0);
    const n = s.end!.chunks;
    expect(n).toBeGreaterThanOrEqual(10);
    expect(s.blocks.size).toBe(n);
    // Exactly 3,200 samples per block; only the last may be shorter.
    for (let i = 0; i < n - 1; i++) expect(s.blocks.get(i)!.length).toBe(6400);
    const last = s.blocks.get(n - 1)!.length;
    expect(last).toBeGreaterThan(0);
    expect(last).toBeLessThanOrEqual(6400);
    const pcm = ScriptedComputer.pcm(s);
    expect(s.end!.durationMs).toBe(Math.round(pcm.length / 2 / 16));
    // The fake microphone's signal arrives intact (same waveform, 16 kHz, mono).
    const samples = bytesToInt16(pcm);
    expect(rms(samples)).toBeGreaterThan(0.05);
    expect(bestCorrelation(samples)).toBeGreaterThan(0.9);

    // PHONE-23: the result.
    await expect(label(page)).toHaveText("Klar på MacBook");
    await expect(sub(page)).toHaveText("Tryk ⌘V for at indsætte");
  });

  test("a Windows computer says Ctrl+V", async ({ page, browserName, newComputer }) => {
    const computer = await newComputer("ThinkPad", "win");
    await preparePage(page, browserName);
    await pairByLink(page, computer);
    await hold(page, 800);
    await expect(label(page)).toHaveText("Klar på ThinkPad");
    await expect(sub(page)).toHaveText("Tryk Ctrl+V for at indsætte");
  });

  test("sliding off the button cancels (PHONE-26)", async ({ page, browserName, newComputer }) => {
    const computer = await newComputer();
    await preparePage(page, browserName);
    await pairByLink(page, computer);
    const p = await press(page);
    await expect(label(page)).toHaveText("Slip for at sende");
    await computer.waitSession((s) => s.blocks.size >= 2, "some audio", 10_000);
    await p.slideOff();
    await expect(label(page)).toHaveText("Slip for at annullere");
    await p.slideBack();
    await expect(label(page)).toHaveText("Slip for at sende");
    await p.slideOff();
    await expect(label(page)).toHaveText("Slip for at annullere");
    await p.release();
    await expect(label(page)).toHaveText("Hold for at tale");
    const s = await computer.waitSession((x) => x.cancelled, "audio_cancel");
    expect(s.end).toBeNull();
    expect(s.answered).toBe(0);
  });

  test("tap to start and stop (PHONE-26 setting)", async ({ page, browserName, newComputer }) => {
    const computer = await newComputer();
    await preparePage(page, browserName);
    await pairByLink(page, computer);
    await chip(page).click();
    await page.getByRole("button", { name: "Indstillinger" }).click();
    await page.getByLabel("Tryk for at starte og stoppe").check();
    await page.getByRole("button", { name: "Tilbage" }).click();
    await holdButton(page).click();
    await expect(label(page)).toHaveText("Slip for at sende");
    await page.waitForTimeout(1200);
    await expect(label(page)).toHaveText("Slip for at sende");
    await holdButton(page).click();
    await computer.waitEnded();
    await expect(label(page)).toHaveText("Klar på Testcomputer");
  });
});

test.describe("offline computer (PHONE-24)", () => {
  test("the recording waits for the computer and arrives when it connects", async ({ page, browserName, newComputer }) => {
    const computer = await newComputer();
    await preparePage(page, browserName);
    await pairByLink(page, computer);
    computer.disconnect();
    await expect(page.locator(".wt-stage--away")).toBeVisible();
    await hold(page, 1500);
    await expect(label(page)).toHaveText("Testcomputer er ikke online. Optagelsen venter i 10 minutter.");
    expect(computer.sessions.size).toBe(0);

    await computer.connect();
    const s = await computer.waitEnded();
    expect(s.end!.chunks).toBeGreaterThanOrEqual(7);
    await expect(label(page)).toHaveText("Klar på Testcomputer");
  });
});

test.describe("resend after reconnect (PHONE-32)", () => {
  test("the phone's socket drops mid-recording; the whole session is resent and nothing is lost", async ({ page, browserName, newComputer }) => {
    const proxy = await TcpProxy.start(RELAY_PORT);
    try {
      const computer = await newComputer();
      await preparePage(page, browserName);
      await pairByLink(page, computer, { relayUrl: `ws://127.0.0.1:${proxy.port}` });
      const p = await press(page);
      await computer.waitSession((s) => s.blocks.size >= 4, "live blocks", 10_000);
      proxy.dropAll();
      await page.waitForTimeout(1600);
      await p.release();
      const s = await computer.waitEnded(20_000);
      // audio_start again on the new socket, and the blocks again, identical.
      expect(s.starts).toBeGreaterThanOrEqual(2);
      expect(s.duplicates).toBeGreaterThan(0);
      expect(s.mismatches).toBe(0);
      expect(s.blocks.size).toBe(s.end!.chunks);
      expect(s.end!.chunks).toBeGreaterThanOrEqual(12);
      expect(bestCorrelation(bytesToInt16(ScriptedComputer.pcm(s)))).toBeGreaterThan(0.9);
      await expect(label(page)).toHaveText("Klar på Testcomputer");
    } finally {
      await proxy.close();
    }
  });

  test("no connection says so, and the recording goes once the relay is back", async ({ page, browserName, newComputer }) => {
    const proxy = await TcpProxy.start(RELAY_PORT);
    try {
      const computer = await newComputer();
      await preparePage(page, browserName);
      await pairByLink(page, computer, { relayUrl: `ws://127.0.0.1:${proxy.port}` });
      proxy.blocked = true;
      proxy.dropAll();
      await expect(label(page)).toHaveText("Ingen forbindelse. Prøver igen.", { timeout: 10_000 });
      await hold(page, 1000);
      await expect(label(page)).toHaveText("Ingen forbindelse. Prøver igen.");
      proxy.blocked = false;
      const s = await computer.waitEnded(30_000);
      expect(s.blocks.size).toBe(s.end!.chunks);
      await expect(label(page)).toHaveText("Klar på Testcomputer");
    } finally {
      await proxy.close();
    }
  });
});
