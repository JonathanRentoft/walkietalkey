/* Shared by the concept specs (run 6): which concept this project tests, and the page's motion. */
import type { Page, TestInfo } from "@playwright/test";
import type { Concept } from "../src/lib/build";

export const conceptOf = (info: TestInfo) =>
  info.project.metadata.concept as Concept;
export const deviceOf = (info: TestInfo) =>
  info.project.metadata.device as "desktop" | "mobile";

/** Scrolls through the whole page in steps, so scroll-driven and in-view effects all run once. */
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
