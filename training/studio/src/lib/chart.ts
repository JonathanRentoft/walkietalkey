/* Scales, ticks and smoothing for the SVG charts (training loss and WER, the pilot's small
   multiples). Small and pure, so the tests can pin them down. */
import type { Point } from "../api/types";

export interface Scale {
  (v: number): number;
  domain: [number, number];
  range: [number, number];
  invert: (px: number) => number;
}

export function linearScale(
  domain: [number, number],
  range: [number, number],
): Scale {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  const span = d1 - d0 || 1;
  const f = ((v: number) => r0 + ((v - d0) / span) * (r1 - r0)) as Scale;
  f.domain = domain;
  f.range = range;
  f.invert = (px: number) => d0 + ((px - r0) / (r1 - r0 || 1)) * span;
  return f;
}

/** A step of 1, 2, 2.5 or 5 times a power of ten that gives about `count` ticks. */
export function niceStep(span: number, count: number): number {
  if (!(span > 0) || !Number.isFinite(span)) return 1;
  const raw = span / Math.max(1, count);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step =
    norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10;
  return step * mag;
}

/** Round the domain out to whole steps and list the ticks. */
export function niceTicks(
  min: number,
  max: number,
  count = 5,
): { domain: [number, number]; ticks: number[]; step: number } {
  if (!Number.isFinite(min) || !Number.isFinite(max))
    return { domain: [0, 1], ticks: [0, 1], step: 1 };
  if (min === max) {
    const pad = Math.abs(min) * 0.1 || 1;
    min -= pad;
    max += pad;
  }
  const step = niceStep(max - min, count);
  const lo = Math.floor(min / step + 1e-9) * step;
  const hi = Math.ceil(max / step - 1e-9) * step;
  const ticks: number[] = [];
  for (let v = lo; v <= hi + step / 2; v += step)
    ticks.push(Number(v.toFixed(10)));
  return {
    domain: [Number(lo.toFixed(10)), Number(hi.toFixed(10))],
    ticks,
    step,
  };
}

/** How many decimals a tick step needs: 0.5 → 1, 0.25 → 2, 10 → 0. */
export function stepDecimals(step: number): number {
  if (!(step > 0)) return 0;
  for (let d = 0; d < 6; d++)
    if (Math.abs(Math.round(step * 10 ** d) - step * 10 ** d) < 1e-6) return d;
  return 6;
}

/** Exponential smoothing of a noisy series (TensorBoard style, with the start-up bias removed). */
export function smooth(points: readonly Point[], weight = 0.6): Point[] {
  const w = Math.min(0.99, Math.max(0, weight));
  let last = 0;
  let n = 0;
  return points.map(([x, y]) => {
    last = last * w + (1 - w) * y;
    n++;
    const debias = 1 - w ** n;
    return [x, last / (debias || 1)];
  });
}

export function extentOf(
  series: readonly (readonly Point[])[],
): [number, number] | null {
  let lo = Infinity;
  let hi = -Infinity;
  for (const s of series)
    for (const [, y] of s) {
      if (!Number.isFinite(y)) continue;
      if (y < lo) lo = y;
      if (y > hi) hi = y;
    }
  return lo <= hi ? [lo, hi] : null;
}

/** The y-domain for loss: never below zero, a little air above the highest point. */
export function lossDomain(series: readonly (readonly Point[])[]): {
  domain: [number, number];
  ticks: number[];
  step: number;
} {
  const ext = extentOf(series);
  if (!ext) return niceTicks(0, 1, 4);
  const [lo, hi] = ext;
  const pad = (hi - lo) * 0.08 || hi * 0.1 || 0.1;
  return niceTicks(Math.max(0, lo - pad), hi + pad, 4);
}

/** The x-domain for steps: 0 to the planned total, or to the last point when it runs past it. */
export function stepDomain(
  totalSteps: number | null | undefined,
  series: readonly (readonly Point[])[],
): [number, number] {
  let last = 0;
  for (const s of series) for (const [x] of s) if (x > last) last = x;
  const total = totalSteps && totalSteps > 0 ? totalSteps : 0;
  return [0, Math.max(total, last, 1)];
}

/** The point of a series nearest to x (for the hover crosshair). */
export function nearest(points: readonly Point[], x: number): Point | null {
  let best: Point | null = null;
  let d = Infinity;
  for (const p of points) {
    const dd = Math.abs(p[0] - x);
    if (dd < d) {
      d = dd;
      best = p;
    }
  }
  return best;
}

/** An SVG path through the points (nothing for no points). */
export function linePath(points: readonly Point[], x: Scale, y: Scale): string {
  let d = "";
  for (let i = 0; i < points.length; i++) {
    const [px, py] = points[i];
    if (!Number.isFinite(py)) continue;
    d += `${d ? "L" : "M"}${x(px).toFixed(1)},${y(py).toFixed(1)}`;
  }
  return d;
}
