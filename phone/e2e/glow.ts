/**
 * Pixel checks for the glow around the big button (run 2, owner finding 5: "the coloured glow
 * gets clipped by an invisible square after a while"). A soft glow changes by about one colour
 * level per pixel; a cut-off is a sudden step. From the button's centre, rays go out over the
 * glow until they meet another element or the screen's edge, and the largest step between
 * neighbouring pixels along any ray is reported. A square cut-off at any size between the button
 * and the screen's edge shows up as a step on most rays (the ones crossing its sides).
 */
import type { Page } from "@playwright/test";
import { PNG } from "pngjs";

/** Larger steps than this between neighbouring pixels are an edge, not a glow. */
export const MAX_GLOW_STEP = 6;

/** Elements drawn over the glow; a ray stops when it reaches one. */
const OVER_GLOW = [
  ".wt-app-head",
  ".wt-app-rec",
  ".wt-app-meter",
  ".wt-app-label",
  ".wt-app-sub",
  ".wt-app-foot",
  ".wt-stage-countdown",
  ".wt-stage-cancel",
  ".wt-status",
  "[role=dialog]",
];

interface Geometry {
  dpr: number;
  cx: number;
  cy: number;
  /** Radius of the button as drawn (CSS px). */
  r: number;
  width: number;
  height: number;
  em: number;
  boxes: { x: number; y: number; w: number; h: number }[];
}

export interface GlowReport {
  /** Largest colour step (0-255, any channel) over two neighbouring pixels on a ray. */
  maxStep: number;
  /** Where it was (CSS px from the button's centre, and the ray's angle in degrees). */
  at: { r: number; angle: number };
  /** How many rays had a step above MAX_GLOW_STEP. */
  steppedRays: number;
  rays: number;
  /** The glow is there at all: the strongest colour difference from the page's background. */
  strength: number;
}

async function geometry(page: Page): Promise<Geometry> {
  return page.evaluate((over) => {
    const btn = document.querySelector(".wt-app-btn")!.getBoundingClientRect();
    const boxes: { x: number; y: number; w: number; h: number }[] = [];
    for (const sel of over)
      for (const el of document.querySelectorAll(sel)) {
        const b = el.getBoundingClientRect();
        if (b.width && b.height)
          boxes.push({ x: b.left, y: b.top, w: b.width, h: b.height });
      }
    const inner = document.querySelector(".wt-stage-inner");
    return {
      dpr: window.devicePixelRatio,
      cx: btn.left + btn.width / 2,
      cy: btn.top + btn.height / 2,
      r: btn.width / 2,
      width: document.documentElement.clientWidth,
      height: document.documentElement.clientHeight,
      em: inner ? parseFloat(getComputedStyle(inner).fontSize) : 14,
      boxes,
    };
  }, OVER_GLOW);
}

/** Screenshot and measure. */
export async function measureGlow(page: Page): Promise<GlowReport> {
  const g = await geometry(page);
  const png = PNG.sync.read(await page.screenshot());
  return analyse(png, g);
}

function analyse(png: PNG, g: Geometry): GlowReport {
  const { dpr } = g;
  const px = (x: number, y: number): [number, number, number] => {
    const xi = Math.min(png.width - 1, Math.max(0, Math.round(x * dpr)));
    const yi = Math.min(png.height - 1, Math.max(0, Math.round(y * dpr)));
    const i = (yi * png.width + xi) * 4;
    return [png.data[i]!, png.data[i + 1]!, png.data[i + 2]!];
  };
  const pad = 6;
  const blocked = (x: number, y: number) =>
    g.boxes.some(
      (b) =>
        x >= b.x - pad &&
        x <= b.x + b.w + pad &&
        y >= b.y - pad &&
        y <= b.y + b.h + pad,
    );
  const bg = px(2, g.height - 2);
  const rIn = g.r + 4;
  const rMax = Math.min(18 * g.em, g.width, g.height);
  let maxStep = 0;
  let at = { r: 0, angle: 0 };
  let steppedRays = 0;
  let strength = 0;
  const rays = 120;
  const step = 1 / dpr;
  for (let k = 0; k < rays; k++) {
    const a = (k / rays) * 2 * Math.PI;
    const dx = Math.cos(a);
    const dy = Math.sin(a);
    // The last two samples: an edge antialiased over one device pixel still shows in full.
    let prev: [number, number, number] | null = null;
    let prev2: [number, number, number] | null = null;
    let rayMax = 0;
    for (let r = rIn; r < rMax; r += step) {
      const x = g.cx + dx * r;
      const y = g.cy + dy * r;
      if (x < 3 || y < 3 || x > g.width - 3 || y > g.height - 3) break;
      if (blocked(x, y)) break;
      const c = px(x, y);
      strength = Math.max(
        strength,
        Math.abs(c[0] - bg[0]),
        Math.abs(c[1] - bg[1]),
        Math.abs(c[2] - bg[2]),
      );
      let d = 0;
      for (const q of [prev, prev2])
        if (q)
          d = Math.max(
            d,
            Math.abs(c[0] - q[0]),
            Math.abs(c[1] - q[1]),
            Math.abs(c[2] - q[2]),
          );
      if (d > rayMax) rayMax = d;
      if (d > maxStep) {
        maxStep = d;
        at = { r: Math.round(r), angle: Math.round((a * 180) / Math.PI) };
      }
      prev2 = prev;
      prev = c;
    }
    if (rayMax > MAX_GLOW_STEP) steppedRays++;
  }
  return { maxStep, at, steppedRays, rays, strength };
}

/**
 * What can clip the glow (the root cause of finding 5): a glow layer whose paint reaches outside
 * its own box (a blur filter, a box shadow), which WebKit may cut at the layer's bounds once the
 * layer is composited; and any ancestor between the glow and the screen that clips (overflow,
 * contain, clip-path), other than the screen itself.
 */
export async function glowClipRisks(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const risks: string[] = [];
    const screen = document.querySelector(".wt-stage")!.getBoundingClientRect();
    for (const sel of [".wt-app-glow", ".wt-app-halo"]) {
      const el = document.querySelector(sel) as HTMLElement | null;
      if (!el) {
        risks.push(`${sel} missing`);
        continue;
      }
      const cs = getComputedStyle(el);
      if (cs.filter && cs.filter !== "none")
        risks.push(`${sel} filter ${cs.filter}`);
      if (cs.boxShadow && cs.boxShadow !== "none")
        risks.push(`${sel} box-shadow`);
      for (
        let p = el.parentElement;
        p && p !== document.body;
        p = p.parentElement
      ) {
        const ps = getComputedStyle(p);
        const b = p.getBoundingClientRect();
        // The screen itself (or a box at least as large) may clip; anything smaller is a cut-off.
        const screenSized =
          b.left <= screen.left + 1 &&
          b.top <= screen.top + 1 &&
          b.right >= screen.right - 1 &&
          b.bottom >= screen.bottom - 1;
        const clips =
          ps.overflow !== "visible" ||
          ps.overflowX !== "visible" ||
          ps.overflowY !== "visible" ||
          /paint|strict|content/.test(ps.contain) ||
          (ps.clipPath && ps.clipPath !== "none");
        if (clips && !screenSized)
          risks.push(
            `${sel} clipped by <${p.tagName.toLowerCase()} class="${p.className}">`,
          );
      }
    }
    return risks;
  });
}
