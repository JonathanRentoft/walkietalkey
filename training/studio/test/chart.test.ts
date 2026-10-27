import { describe, expect, it } from "vitest";
import type { Point } from "../src/api/types";
import {
  linearScale,
  linePath,
  lossDomain,
  nearest,
  niceTicks,
  smooth,
  stepDecimals,
  stepDomain,
} from "../src/lib/chart";

describe("scales", () => {
  it("maps a domain onto a range and back", () => {
    const x = linearScale([0, 80], [40, 680]);
    expect(x(0)).toBe(40);
    expect(x(80)).toBe(680);
    expect(x(40)).toBe(360);
    expect(x.invert(360)).toBe(40);
  });

  it("flips for y (larger values higher up)", () => {
    const y = linearScale([0, 2], [200, 0]);
    expect(y(0)).toBe(200);
    expect(y(2)).toBe(0);
    expect(y(1.5)).toBe(50);
  });

  it("survives an empty domain", () => {
    const x = linearScale([3, 3], [0, 100]);
    expect(Number.isFinite(x(3))).toBe(true);
  });
});

describe("ticks", () => {
  it("rounds out to clean steps", () => {
    expect(niceTicks(0, 1.92, 4)).toEqual({
      domain: [0, 2],
      ticks: [0, 0.5, 1, 1.5, 2],
      step: 0.5,
    });
    expect(niceTicks(0, 80, 4).ticks).toEqual([0, 20, 40, 60, 80]);
    const wer = niceTicks(0.12, 0.21, 4);
    expect(wer.ticks[0]).toBeLessThanOrEqual(0.12);
    expect(wer.ticks[wer.ticks.length - 1]).toBeGreaterThanOrEqual(0.21);
    expect(wer.ticks.length).toBeGreaterThanOrEqual(4);
    expect(wer.ticks.length).toBeLessThanOrEqual(7);
  });

  it("gives a flat series some room", () => {
    const t = niceTicks(1.5, 1.5);
    expect(t.domain[0]).toBeLessThan(1.5);
    expect(t.domain[1]).toBeGreaterThan(1.5);
  });

  it("knows how many decimals a step needs", () => {
    expect(stepDecimals(0.5)).toBe(1);
    expect(stepDecimals(0.25)).toBe(2);
    expect(stepDecimals(20)).toBe(0);
    expect(stepDecimals(0.02)).toBe(2);
  });
});

describe("the training chart's axes", () => {
  const train: Point[] = [
    [1, 1.92],
    [2, 1.85],
    [3, 1.9],
    [31, 1.21],
  ];
  const validation: Point[] = [
    [0, 1.7],
    [16, 1.41],
  ];

  it("puts loss on a y-axis from zero (or just under the lowest point) to above the highest", () => {
    const { domain, ticks } = lossDomain([train, validation]);
    expect(domain[0]).toBeGreaterThanOrEqual(0);
    expect(domain[0]).toBeLessThanOrEqual(1.21);
    expect(domain[1]).toBeGreaterThanOrEqual(1.92);
    expect(ticks[0]).toBe(domain[0]);
    expect(ticks[ticks.length - 1]).toBe(domain[1]);
  });

  it("has a default when there are no points yet", () => {
    expect(lossDomain([[], []]).domain).toEqual([0, 1]);
  });

  it("runs x from step 0 to the planned total steps", () => {
    expect(stepDomain(80, [train, validation])).toEqual([0, 80]);
    expect(stepDomain(null, [train, validation])).toEqual([0, 31]);
    expect(stepDomain(20, [train])).toEqual([0, 31]);
    expect(stepDomain(0, [])).toEqual([0, 1]);
  });

  it("smooths the train loss without the start-up bias", () => {
    const s = smooth(train, 0.6);
    expect(s).toHaveLength(train.length);
    expect(s[0][1]).toBeCloseTo(1.92); // the first point is itself
    expect(s[1][1]).toBeGreaterThan(1.85);
    expect(s[1][1]).toBeLessThan(1.92);
    expect(s.map((p) => p[0])).toEqual(train.map((p) => p[0]));
  });

  it("finds the nearest point for the crosshair", () => {
    expect(nearest(validation, 10)).toEqual([16, 1.41]);
    expect(nearest(validation, 7)).toEqual([0, 1.7]);
    expect(nearest([], 3)).toBeNull();
  });

  it("draws a path through the points", () => {
    const x = linearScale([0, 16], [0, 160]);
    const y = linearScale([0, 2], [100, 0]);
    expect(linePath(validation, x, y)).toBe("M0.0,15.0L160.0,29.5");
    expect(linePath([], x, y)).toBe("");
  });
});
