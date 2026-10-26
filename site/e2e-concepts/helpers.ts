/* Shared by the final pages' browser checks (run 8): which page this project tests, and how to see what moves. */
import type { Page, TestInfo } from "@playwright/test";
import type { Concept } from "../src/lib/build";

export const conceptOf = (info: TestInfo) =>
  info.project.metadata.concept as Concept;
export const deviceOf = (info: TestInfo) =>
  info.project.metadata.device as "desktop" | "mobile";

/** The parts of a living background that move (the design system's surfaces, and the privacy section's light). */
export const BG_LAYERS =
  ".wt-blobs > *, .wt-gbg-layer, .wt-gbg-pool, .wt-bars-row > .wt-bar, .wt-barfield-row > .wt-bf, .fp-light > i";

/** Counts WebGL draws per canvas, so a check can see which canvas is animating (add before the page loads). */
export async function countDraws(page: Page) {
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

/**
 * Which living backgrounds run right now: over `ms`, a background runs if its canvas draws more than once, if one of
 * its layers has an endless CSS animation running, or if its bars change (BarField's interactive mode).
 * Returns the [data-fp-bg] hosts that run, by their kind and position on the page.
 */
export async function runningBackgrounds(page: Page, ms = 450) {
  return page.evaluate(
    async ([layers, ms]) => {
      const w = window as unknown as { __draws?: WeakMap<object, number> };
      const hosts = [...document.querySelectorAll<HTMLElement>("[data-fp-bg]")];
      const canvases = (h: Element) => [...h.querySelectorAll("canvas")];
      const draws = (h: Element) =>
        canvases(h).reduce((n, c) => n + (w.__draws?.get(c) ?? 0), 0);
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
          const gl = draws(h) - before[i].d > 1;
          const moved = bars(h) !== before[i].b;
          return {
            kind: h.dataset.fpBg ?? "",
            top: Math.round(h.getBoundingClientRect().top + scrollY),
            running: css || gl || moved,
          };
        })
        .filter((h) => h.running);
    },
    [BG_LAYERS, ms] as const,
  );
}

/** Every endless animation on a background layer that no [data-fp-bg] host manages. */
export async function unmanagedBackgrounds(page: Page) {
  return page.evaluate((layers) => {
    return [...document.querySelectorAll(layers)]
      .filter((el) => !el.closest("[data-fp-bg]"))
      .map((el) => el.className);
  }, BG_LAYERS);
}

/** Scrolls through the whole page in steps, so in-view effects all run once. */
export async function scrollThrough(page: Page) {
  await page.evaluate(async () => {
    const step = Math.round(innerHeight * 0.6);
    for (let y = 0; y < document.documentElement.scrollHeight; y += step) {
      scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 120));
    }
  });
}

/** The animations that run forever (loops), with what they animate. */
export async function endlessAnimations(page: Page) {
  return page.evaluate(() =>
    document
      .getAnimations()
      .filter((a) => {
        const t = a.effect?.getComputedTiming();
        return a.playState === "running" && t?.iterations === Infinity;
      })
      .map((a) => {
        const el = (a.effect as KeyframeEffect | null)
          ?.target as Element | null;
        return `${(a as CSSAnimation).animationName ?? a.id} on ${el?.className ?? el?.tagName}`;
      }),
  );
}

/** The opacity an element shows, through all its ancestors. */
export const shownOpacity = (el: Element) => {
  let o = 1;
  for (let n: Element | null = el; n; n = n.parentElement)
    o *= Number(getComputedStyle(n).opacity);
  return o;
};
