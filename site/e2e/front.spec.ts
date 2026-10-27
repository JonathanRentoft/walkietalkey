/* Run 10: the final front page in a browser (the owner's pick; SITE-02, SITE-06, spec 6.17).
     - the hero's 40 BarField bars stand still until the pointer moves, a touch or a scroll, and settle back;
     - one living background at a time, the most visible one, all the way down; with reduced motion nothing loops;
     - right, left, right, left: every row has its words on one side and its box on the other, alternating, with
       never two boxes side by side, at 1440 and 1024 px; on a phone the words come above their box;
     - no pending notes, stray words or em dashes on the page, and the devices scene without a card frame;
     - the hero's words land at release, and the page reads in full without JavaScript. */
import { expect, test, type Page } from "@playwright/test";
import {
  PLANS,
  ROW_ORDER,
  SHOWCASE,
  SHOWCASE_ORDER,
  TRY,
} from "../src/lib/features";

const isMobile = (name: string) => name === "mobile";

/** The parts of a living background that move (the design system's CSS surfaces). */
const BG_LAYERS =
  ".wt-blobs > *, .wt-gbg-layer, .wt-gbg-pool, .wt-bars-row > .wt-bar, .wt-barfield-row > .wt-bf";

/** Counts WebGL draws per canvas, so a check can see which canvas is animating (add before the page loads). */
async function countDraws(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __draws: WeakMap<object, number> };
    w.__draws = new WeakMap();
    const proto = WebGLRenderingContext.prototype;
    const draw = proto.drawArrays;
    proto.drawArrays = function (
      this: WebGLRenderingContext,
      ...a: Parameters<WebGLRenderingContext["drawArrays"]>
    ) {
      w.__draws.set(this.canvas, (w.__draws.get(this.canvas) ?? 0) + 1);
      return draw.apply(this, a);
    };
  });
}

/** Which living backgrounds ([data-fp-bg]) run over `ms`: a canvas that draws, an endless CSS animation that runs,
    or bars that change. */
async function runningBackgrounds(page: Page, ms = 450) {
  return page.evaluate(
    async ([layers, ms]) => {
      const w = window as unknown as { __draws?: WeakMap<object, number> };
      const hosts = [...document.querySelectorAll<HTMLElement>("[data-fp-bg]")];
      const draws = (h: Element) =>
        [...h.querySelectorAll("canvas")].reduce(
          (n, c) => n + (w.__draws?.get(c) ?? 0),
          0,
        );
      const bars = (h: Element) =>
        [...h.querySelectorAll<HTMLElement>(".wt-bf")]
          .map((b) => b.style.transform)
          .join("|");
      const before = hosts.map((h) => ({ d: draws(h), b: bars(h) }));
      await new Promise((r) => setTimeout(r, ms as number));
      return hosts
        .map((h, i) => {
          const css = [...h.querySelectorAll(layers as string)].some((el) =>
            el
              .getAnimations()
              .some(
                (a) =>
                  a.playState === "running" &&
                  a.effect?.getComputedTiming().iterations === Infinity,
              ),
          );
          return {
            kind: h.dataset.fpBg ?? "",
            top: Math.round(h.getBoundingClientRect().top + scrollY),
            running:
              css || draws(h) - before[i].d > 1 || bars(h) !== before[i].b,
          };
        })
        .filter((h) => h.running);
    },
    [BG_LAYERS, ms] as const,
  );
}

/** Every endless animation on a background layer that no [data-fp-bg] host manages. */
const unmanaged = (page: Page) =>
  page.evaluate(
    (layers) =>
      [...document.querySelectorAll(layers)]
        .filter((el) => !el.closest("[data-fp-bg]"))
        .map((el) => el.className),
    BG_LAYERS,
  );

/** The animations that run forever. */
const endless = (page: Page) =>
  page.evaluate(() =>
    document
      .getAnimations()
      .filter(
        (a) =>
          a.playState === "running" &&
          a.effect?.getComputedTiming().iterations === Infinity,
      )
      .map((a) => {
        const el = (a.effect as KeyframeEffect | null)
          ?.target as Element | null;
        return `${(a as CSSAnimation).animationName ?? a.id} on ${el?.className ?? el?.tagName}`;
      }),
  );

/** Scrolls through the whole page in steps, so in-view effects all run once. */
const scrollThrough = (page: Page) =>
  page.evaluate(async () => {
    const step = Math.round(innerHeight * 0.6);
    for (let y = 0; y < document.documentElement.scrollHeight; y += step) {
      scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 120));
    }
  });

/** The opacity an element shows, through all its ancestors. */
const shownOpacity = (el: Element) => {
  let o = 1;
  for (let n: Element | null = el; n; n = n.parentElement)
    o *= Number(getComputedStyle(n).opacity);
  return o;
};

/** the hero's bars: their inline transforms (empty at rest) */
const bars = (page: Page) =>
  page.evaluate(() =>
    [
      ...document.querySelectorAll<HTMLElement>('[data-section="hero"] .wt-bf'),
    ].map((b) => b.style.transform),
  );
const heroHydrated = (page: Page) =>
  expect(page.locator('[data-section="hero"] astro-island[ssr]')).toHaveCount(
    0,
    { timeout: 8000 },
  );

/** Each row's words and box, as laid out now (document coordinates). */
function layout(page: Page) {
  return page.evaluate(() => {
    const rect = (el: Element) => {
      const r = el.getBoundingClientRect();
      return {
        left: r.left,
        right: r.right,
        top: r.top + scrollY,
        bottom: r.bottom + scrollY,
      };
    };
    return [...document.querySelectorAll<HTMLElement>("main [data-row]")].map(
      (row) => ({
        key: row.dataset.row!,
        box: row.dataset.box!,
        copy: rect(row.querySelector("[data-row-copy]")!),
        demo: rect(row.querySelector("[data-row-box]")!),
      }),
    );
  });
}

test("loads without errors and never scrolls sideways", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.goto("/");
  await scrollThrough(page);
  await page.waitForTimeout(400);
  expect(errors).toEqual([]);
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    ),
  ).toBeLessThanOrEqual(0);
});

for (const width of [1440, 1024]) {
  test(`at ${width} px every row alternates: words left and box right, then box left and words right, never two boxes side by side`, async ({
    page,
  }, info) => {
    test.skip(isMobile(info.project.name), "a wide screen");
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/");
    await scrollThrough(page);
    await page.waitForTimeout(300);
    const rows = await layout(page);
    expect(rows.map((r) => r.key)).toEqual(ROW_ORDER);
    rows.forEach((r, i) => {
      const want = i % 2 === 0 ? "right" : "left";
      expect(r.box, r.key).toBe(want);
      /* side by side: they share a band of the page, and do not overlap sideways */
      expect(r.copy.top, r.key).toBeLessThan(r.demo.bottom);
      expect(r.demo.top, r.key).toBeLessThan(r.copy.bottom);
      if (want === "right")
        expect(r.copy.right, r.key).toBeLessThanOrEqual(r.demo.left + 1);
      else expect(r.demo.right, r.key).toBeLessThanOrEqual(r.copy.left + 1);
      /* the box gets real room */
      expect(r.demo.right - r.demo.left, r.key).toBeGreaterThan(width * 0.36);
    });
    /* no two boxes side by side: every box has its band of the page to itself, and the two plans are words that
       stack in the price's column, not cards in a row */
    const bands = (sel: string) =>
      page.evaluate(
        (sel) =>
          [...document.querySelectorAll(sel)]
            .filter((el) => !el.parentElement?.closest(sel))
            .map((el) => {
              const r = el.getBoundingClientRect();
              return { top: r.top + scrollY, bottom: r.bottom + scrollY };
            }),
        sel,
      );
    for (const sel of ["main [data-row-box], main .wt-show", "main .fp-plan"]) {
      const boxes = await bands(sel);
      for (let a = 0; a < boxes.length; a++)
        for (let b = a + 1; b < boxes.length; b++) {
          const overlap =
            Math.min(boxes[a].bottom, boxes[b].bottom) -
            Math.max(boxes[a].top, boxes[b].top);
          expect(overlap, `${sel}: ${a} and ${b}`).toBeLessThanOrEqual(0);
        }
    }
  });
}

test("on a phone the words come above their box, in one column", async ({
  page,
}, info) => {
  test.skip(!isMobile(info.project.name), "a phone");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await scrollThrough(page);
  await page.waitForTimeout(300);
  for (const r of await layout(page)) {
    expect(r.copy.bottom, r.key).toBeLessThanOrEqual(r.demo.top + 1);
    expect(r.demo.right - r.demo.left, r.key).toBeGreaterThan(330);
  }
});

test("shows nothing pending, no stray words and no em dashes", async ({
  page,
}) => {
  await page.goto("/");
  const text = await page.locator("body").innerText();
  expect(text).not.toMatch(/TODO|bekræft|mangler at blive|ikke målt/i);
  expect(text).not.toMatch(/hvisk/i);
  expect(text).not.toMatch(/—/);
  /* the slogan's words never stand on their own */
  const lines = text.split("\n").map((l) => l.trim());
  for (const l of ["Tal.", "Slip.", "Indsæt."])
    expect(lines, l).not.toContain(l);
});

test("gives the devices scene its row without a card frame", async ({
  page,
}) => {
  await page.goto("/");
  const box = page.locator('[data-row="devices"] [data-row-box]');
  await box.scrollIntoViewIfNeeded();
  await expect(box.locator(".wt-show")).toHaveCount(0);
  await expect(box.locator("astro-island[ssr]")).toHaveCount(0, {
    timeout: 8000,
  });
  const frame = await box.evaluate((el) => {
    const s = getComputedStyle(el);
    return {
      shadow: s.boxShadow,
      border: s.borderTopWidth,
      bg: s.backgroundColor,
      clip: s.overflow,
    };
  });
  expect(frame.shadow).toBe("none");
  expect(frame.border).toBe("0px");
  expect(frame.bg).toBe("rgba(0, 0, 0, 0)");
  expect(frame.clip).not.toBe("hidden");
  expect((await box.boundingBox())!.height).toBeGreaterThan(160);
});

test.describe("the hero's bars", () => {
  test("has 40 bars that stand still until the pointer moves, rise near it, and settle back to still", async ({
    page,
  }, info) => {
    test.skip(isMobile(info.project.name), "a pointer that hovers");
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    await heroHydrated(page);
    await expect(page.locator('[data-section="hero"] .wt-bf')).toHaveCount(40);
    await page.waitForTimeout(800);
    const rest = await bars(page);
    expect(rest.every((t) => t === "")).toBe(true);
    await page.waitForTimeout(800);
    expect(await bars(page)).toEqual(rest);

    const box = (await page
      .locator('[data-section="hero"] .wt-barfield')
      .boundingBox())!;
    await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.7);
    await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.7, {
      steps: 6,
    });
    await page.waitForTimeout(220);
    const lifted = await bars(page);
    const scale = (t: string) => Number(/scaleY\(([\d.]+)\)/.exec(t)?.[1] ?? 0);
    const n = lifted.length;
    expect(scale(lifted[Math.round(n * 0.3)])).toBeGreaterThan(
      scale(lifted[Math.round(n * 0.85)]) + 0.1,
    );
    await expect.poll(() => bars(page), { timeout: 5000 }).toEqual(rest);
  });

  test("sends a wave through the bars when the page scrolls, then rests", async ({
    page,
  }) => {
    await page.goto("/");
    await heroHydrated(page);
    await page.waitForTimeout(500);
    expect((await bars(page)).every((t) => t === "")).toBe(true);
    await expect(
      page.locator('[data-section="hero"] [data-fp-bg]'),
    ).not.toHaveAttribute("data-paused", "");
    await page.evaluate(() => scrollBy(0, 160));
    await expect
      .poll(async () => (await bars(page)).some((t) => t !== ""), {
        timeout: 2000,
        intervals: [50],
      })
      .toBe(true);
    await expect
      .poll(async () => (await bars(page)).every((t) => t === ""), {
        timeout: 5000,
      })
      .toBe(true);
  });

  test("responds to a touch on a phone", async ({ page }, info) => {
    test.skip(!isMobile(info.project.name), "touch");
    await page.goto("/");
    await heroHydrated(page);
    await page.waitForTimeout(500);
    const box = (await page
      .locator('[data-section="hero"] .wt-barfield')
      .boundingBox())!;
    await page.touchscreen.tap(
      box.x + box.width * 0.5,
      box.y + box.height * 0.85,
    );
    await expect
      .poll(async () => (await bars(page)).some((t) => t !== ""), {
        timeout: 2000,
        intervals: [50],
      })
      .toBe(true);
  });
});

test("runs one living background at a time, the most visible one, all the way down", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await countDraws(page);
  await page.goto("/");
  await page.waitForLoadState("load");
  await page.waitForTimeout(1200);
  expect(await unmanaged(page)).toEqual([]);
  /* at the top only the hero's bars may run, and they wait for the visitor */
  expect(await runningBackgrounds(page)).toEqual([]);
  const height = await page.evaluate(
    () => document.documentElement.scrollHeight - innerHeight,
  );
  const step = Math.round(page.viewportSize()!.height * 0.45);
  let seen = 0;
  const kinds = new Set<string>();
  for (let y = 0; y <= height + step; y += step) {
    await page.evaluate((y) => scrollTo(0, y), y);
    await page.waitForTimeout(350);
    const running = await runningBackgrounds(page);
    expect(
      running.length,
      `at ${y}px: ${running.map((r) => `${r.kind}@${r.top}`).join(", ")}`,
    ).toBeLessThanOrEqual(1);
    seen += running.length;
    running.forEach((r) => kinds.add(r.kind));
  }
  expect(seen).toBeGreaterThan(2);
  /* FluidMesh in Nat behind privacy is among them */
  expect([...kinds]).toContain("mesh");
});

test("shows every feature with its demo, coming to life in view", async ({
  page,
}) => {
  await page.goto("/");
  for (const key of SHOWCASE_ORDER) {
    const row = page.locator(`[data-row="${key}"]`);
    const title = row.getByRole("heading", { name: SHOWCASE[key].title });
    await title.scrollIntoViewIfNeeded();
    await expect(title, key).toBeVisible();
    await expect(row.getByText(SHOWCASE[key].text), key).toBeVisible();
    /* a ShowcaseCard scene, or the devices row's frameless SpeakToDesk */
    await expect(
      row.locator("[data-row-box] :is(.wt-sc, .wt-spk)").first(),
      key,
    ).toBeVisible();
    await expect(row.locator("astro-island[ssr]"), key).toHaveCount(0, {
      timeout: 8000,
    });
  }
});

/** Seeks the hero's sequence (the stage's own CSS animations) to p, 0 to 1, after the stage has come up. */
async function seekStage(page: Page, p: number) {
  await page.evaluate((p) => {
    const stage = document.querySelector("[data-stage]")!;
    for (const a of stage.getAnimations({ subtree: true })) {
      const name = (a as CSSAnimation).animationName ?? "";
      if (name === "fp-rise") a.finish();
      if (!name.startsWith("fp-seq")) continue;
      const t = a.effect!.getTiming();
      a.pause();
      a.currentTime = Number(t.delay ?? 0) + p * Number(t.duration);
    }
  }, p);
}

test("the hero's words land at release: nothing is written while fn is held (DESK-46)", async ({
  page,
}) => {
  await page.goto("/");
  const stage = page.locator("[data-stage]");
  const line = stage.locator("[data-stage-line]");
  const listening = stage.locator(".wt-pill--listening");
  const processing = stage.locator(".wt-pill--processing");
  const pasted = stage.locator(".wt-pill--pasted");
  const op = (l: typeof line) => l.evaluate(shownOpacity);
  for (const p of [0.2, 0.35, 0.5]) {
    await seekStage(page, p);
    expect(await op(listening), `listening at ${p}`).toBeGreaterThan(0.95);
    expect(await op(line), `no text while held (${p})`).toBeLessThan(0.05);
    expect(await op(pasted)).toBeLessThan(0.05);
  }
  await seekStage(page, 0.63);
  expect(await op(processing)).toBeGreaterThan(0.95);
  expect(await op(line), "no text while it cleans up").toBeLessThan(0.05);
  await seekStage(page, 1);
  expect(await op(line)).toBeGreaterThan(0.95);
  expect(await op(pasted)).toBeGreaterThan(0.95);
  await expect(pasted).toContainText("Indsat");
});

test("plays the hero's sequence once, ends with the text in place, and shifts nothing", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const w = window as unknown as { __cls: number };
    w.__cls = 0;
    new PerformanceObserver((list) => {
      for (const e of list.getEntries() as (PerformanceEntry & {
        value: number;
        hadRecentInput: boolean;
      })[])
        if (!e.hadRecentInput) w.__cls += e.value;
    }).observe({ type: "layout-shift", buffered: true });
  });
  await page.goto("/");
  const line = page.locator("[data-stage] [data-stage-line]");
  await expect
    .poll(() => line.evaluate(shownOpacity), { timeout: 15_000 })
    .toBeGreaterThan(0.95);
  expect((await endless(page)).filter((a) => a.startsWith("fp-seq"))).toEqual(
    [],
  );
  expect(
    await page.evaluate(() => (window as unknown as { __cls: number }).__cls),
  ).toBeLessThan(0.01);
});

test("getting started and the price respond: the permissions and the computer count", async ({
  page,
}) => {
  await page.goto("/");
  const free = page.locator('[data-feature="free"]');
  const count = free.locator("[data-count]");
  await count.scrollIntoViewIfNeeded();
  await expect(count).toHaveText(TRY.many.replace("{n}", "1.000"));
  await expect(free.locator("[data-price]")).toHaveText(PLANS.free.price);
  const range = free.locator('input[type="range"]');
  await range.focus();
  await page.keyboard.press("Home");
  await expect(count).toHaveText(TRY.one);
  await expect(free.locator("[data-price]")).toHaveText(PLANS.free.price);
  await page.keyboard.press("End");
  await expect(count).toHaveText(TRY.many.replace("{n}", "1.000"));

  const start = page.locator('[data-feature="start"]');
  const ready = start.locator("[data-ready-label]");
  await ready.scrollIntoViewIfNeeded();
  await expect(ready).toHaveText(TRY.waiting);
  for (const s of await start.locator('[role="switch"]').all()) {
    await s.click();
    await expect(s).toHaveAttribute("aria-checked", "true");
  }
  await expect(ready).toHaveText(TRY.ready);
});

test.describe("with reduced motion", () => {
  test.use({ reducedMotion: "reduce" });
  test("nothing loops, no background runs, the bars never move and the stage stands finished", async ({
    page,
  }) => {
    await countDraws(page);
    await page.goto("/");
    await page.waitForLoadState("load");
    await heroHydrated(page);
    await page.waitForTimeout(1200);
    const line = page.locator("[data-stage] [data-stage-line]");
    expect(await line.evaluate(shownOpacity)).toBeGreaterThan(0.95);
    expect(
      await page
        .locator("[data-stage] .wt-pill--listening")
        .evaluate(shownOpacity),
    ).toBeLessThan(0.05);
    expect(await endless(page)).toEqual([]);
    await page.mouse.move(200, 600);
    await page.mouse.move(500, 650, { steps: 6 });
    await page.evaluate(() => scrollBy(0, 160));
    await page.waitForTimeout(200);
    expect((await bars(page)).every((t) => t === "")).toBe(true);
    await scrollThrough(page);
    await page.waitForTimeout(600);
    expect(await endless(page)).toEqual([]);
    expect(await runningBackgrounds(page, 700)).toEqual([]);
  });
});

test.describe("without JavaScript", () => {
  test.use({ javaScriptEnabled: false });
  test("the hero paints, the stage lands, and every row reads", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(page.locator("h1")).toBeVisible();
    await expect(page.locator("[data-stage] .wt-laptop")).toBeVisible();
    await expect
      .poll(
        () =>
          page.locator("[data-stage] [data-stage-line]").evaluate(shownOpacity),
        { timeout: 15_000 },
      )
      .toBeGreaterThan(0.95);
    for (const key of SHOWCASE_ORDER) {
      const title = page
        .locator(`[data-row="${key}"]`)
        .getByRole("heading", { name: SHOWCASE[key].title });
      await title.scrollIntoViewIfNeeded();
      await expect(title, key).toBeVisible();
    }
  });
});
