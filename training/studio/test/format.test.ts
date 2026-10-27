import { describe, expect, it } from "vitest";
import {
  clock,
  date,
  dateTime,
  db,
  dbfs,
  decimal,
  int,
  interval,
  minutes,
  NBSP,
  pct,
  percent,
  points,
  seconds,
} from "../src/lib/format";

describe("Danish numbers", () => {
  it("writes WER and CER fractions as percent with a comma", () => {
    expect(pct(0.0632)).toBe(`6,32${NBSP}%`);
    expect(pct(0.0672)).toBe(`6,72${NBSP}%`);
    expect(pct(0)).toBe(`0,00${NBSP}%`);
    expect(pct(0.21, 1)).toBe(`21,0${NBSP}%`);
    expect(pct(null)).toBe("ingen");
  });

  it("writes shares that already are percent", () => {
    expect(percent(40)).toBe(`40${NBSP}%`);
  });

  it("writes the 95 % interval with 'til', never a dash", () => {
    expect(interval([0.0626, 0.0718])).toBe(`6,26 til 7,18${NBSP}%`);
    expect(interval(null)).toBe("ingen");
  });

  it("writes minutes, seconds and levels with units", () => {
    expect(minutes(3.4)).toBe(`3,4${NBSP}min`);
    expect(minutes(12.5)).toBe(`12,5${NBSP}min`);
    expect(seconds(3.1)).toBe(`3,1${NBSP}s`);
    expect(dbfs(-38.2)).toBe(`\u221238${NBSP}dBFS`);
    expect(db(22.8)).toBe(`23${NBSP}dB`);
  });

  it("groups thousands with a point and uses a real minus", () => {
    expect(int(1041)).toBe("1.041");
    expect(decimal(-0.5, 1)).toBe("\u22120,5");
    expect(decimal(-0, 1)).toBe("0,0");
  });

  it("writes changes in percentage points with a sign", () => {
    expect(points(-0.008)).toBe(`\u22120,80${NBSP}point`);
    expect(points(0.012)).toBe(`+1,20${NBSP}point`);
  });

  it("writes a running clock", () => {
    expect(clock(3.2)).toBe("0:03");
    expect(clock(75)).toBe("1:15");
    expect(clock(-1)).toBe("0:00");
  });

  it("writes dates in Danish, in Copenhagen time", () => {
    expect(date("2026-10-26T17:07:53+01:00")).toBe("26. okt. 2026");
    expect(dateTime("2026-10-26T17:07:53+01:00")).toBe(
      "26. okt. 2026 kl. 17.07",
    );
    expect(date("2026-10-27")).toBe("27. okt. 2026");
    expect(dateTime("2026-10-27")).toBe("27. okt. 2026");
    expect(date("not a date")).toBe("not a date");
    expect(date(null)).toBe("");
  });
});

describe("settings", () => {
  it("writes a setting's number with the decimals it has", async () => {
    const { plain } = await import("../src/lib/format");
    expect(plain(0.0002)).toBe("0,0002");
    expect(plain(0.05)).toBe("0,05");
    expect(plain(16)).toBe("16");
    expect(plain(10000)).toBe("10.000");
  });
});
