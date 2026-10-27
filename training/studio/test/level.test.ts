import { describe, expect, it } from "vitest";
import type { Limits } from "../src/api/types";
import {
  bandIsBad,
  envelopeHeights,
  levelBand,
  meterBands,
  meterPosition,
} from "../src/lib/level";

// The whisper limits of the example state in API.md.
const WHISPER: Limits = {
  quiet_dbfs: -50,
  silent_dbfs: -62,
  loud_dbfs: -6,
  good_dbfs: [-45, -25],
};

describe("level bands", () => {
  it("places a level against the session's limits", () => {
    expect(levelBand(-66, WHISPER)).toBe("silent");
    expect(levelBand(-55, WHISPER)).toBe("tooQuiet");
    expect(levelBand(-47, WHISPER)).toBe("quiet");
    expect(levelBand(-38.2, WHISPER)).toBe("good");
    expect(levelBand(-15, WHISPER)).toBe("loud");
    expect(levelBand(-3, WHISPER)).toBe("tooLoud");
  });

  it("treats the edges as the check does", () => {
    expect(levelBand(-62, WHISPER)).toBe("tooQuiet"); // not below silent
    expect(levelBand(-50, WHISPER)).toBe("quiet"); // not below quiet
    expect(levelBand(-45, WHISPER)).toBe("good");
    expect(levelBand(-25, WHISPER)).toBe("good");
    expect(levelBand(-6, WHISPER)).toBe("tooLoud");
  });

  it("keeps the bands in order when limits overlap", () => {
    const odd: Limits = { ...WHISPER, good_dbfs: [-55, -30] }; // good starts below quiet
    expect(levelBand(-52, odd)).toBe("tooQuiet");
    expect(levelBand(-40, odd)).toBe("good");
    const spans = meterBands(odd);
    for (let i = 1; i < spans.length; i++)
      expect(spans[i].from).toBe(spans[i - 1].to);
  });

  it("names the bands the check refuses or sends back", () => {
    expect(bandIsBad("silent")).toBe(true);
    expect(bandIsBad("tooQuiet")).toBe(true);
    expect(bandIsBad("tooLoud")).toBe(true);
    expect(bandIsBad("quiet")).toBe(false);
    expect(bandIsBad("good")).toBe(false);
    expect(bandIsBad("loud")).toBe(false);
  });
});

describe("the meter's geometry", () => {
  it("maps -70..0 dBFS onto 0..1 and clamps", () => {
    expect(meterPosition(-70)).toBe(0);
    expect(meterPosition(0)).toBe(1);
    expect(meterPosition(-35)).toBeCloseTo(0.5);
    expect(meterPosition(-90)).toBe(0);
    expect(meterPosition(5)).toBe(1);
    expect(meterPosition(Number.NaN)).toBe(0);
  });

  it("covers the whole meter with the six bands in order", () => {
    const spans = meterBands(WHISPER);
    expect(spans.map((s) => s.band)).toEqual([
      "silent",
      "tooQuiet",
      "quiet",
      "good",
      "loud",
      "tooLoud",
    ]);
    expect(spans[0].from).toBe(0);
    expect(spans[spans.length - 1].to).toBe(1);
    const good = spans.find((s) => s.band === "good")!;
    expect(good.from).toBeCloseTo(25 / 70);
    expect(good.to).toBeCloseTo(45 / 70);
  });

  it("turns the envelope into bar heights", () => {
    expect(envelopeHeights([-70, -35, 0, -100])).toEqual([0, 0.5, 1, 0]);
  });
});
