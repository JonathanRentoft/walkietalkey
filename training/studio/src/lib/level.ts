/* The level meter's logic: where a take's level sits against the session's limits
   (recording state `limits`, from recorder/checks.py for the session's style).

   On the dBFS scale, from quiet to loud:
     silent   below silent_dbfs: nothing was said (the recorder refuses these)
     tooQuiet below quiet_dbfs: said, but too quiet (sent back)
     quiet    below the good band: a little quiet, still usable
     good     inside good_dbfs
     loud     above the good band, below loud_dbfs: strong, still usable
     tooLoud  at or above loud_dbfs */
import type { Limits } from "../api/types";

export type Band =
  "silent" | "tooQuiet" | "quiet" | "good" | "loud" | "tooLoud";

export const BANDS: readonly Band[] = [
  "silent",
  "tooQuiet",
  "quiet",
  "good",
  "loud",
  "tooLoud",
];

/** The meter's scale in dBFS. */
export const METER_MIN = -70;
export const METER_MAX = 0;

/** The band boundaries, kept in order even if the limits overlap. */
function bounds(l: Limits): [number, number, number, number, number] {
  const b1 = l.silent_dbfs;
  const b2 = Math.max(l.quiet_dbfs, b1);
  const b3 = Math.max(l.good_dbfs[0], b2);
  const b4 = Math.max(l.good_dbfs[1], b3);
  const b5 = Math.max(l.loud_dbfs, b4);
  return [b1, b2, b3, b4, b5];
}

export function levelBand(level: number, limits: Limits): Band {
  const [b1, b2, b3, b4, b5] = bounds(limits);
  if (level < b1) return "silent";
  if (level < b2) return "tooQuiet";
  if (level < b3) return "quiet";
  if (level <= b4) return "good";
  if (level < b5) return "loud";
  return "tooLoud";
}

/** Whether a band is outside what the check accepts. */
export function bandIsBad(band: Band): boolean {
  return band === "silent" || band === "tooQuiet" || band === "tooLoud";
}

/** 0..1 along the meter for a level (clamped to the scale). */
export function meterPosition(db: number): number {
  if (!Number.isFinite(db)) return 0;
  const t = (db - METER_MIN) / (METER_MAX - METER_MIN);
  return Math.min(1, Math.max(0, t));
}

export interface BandSpan {
  band: Band;
  from: number;
  to: number;
}

/** The bands as spans of the meter (0..1), left to right, empty spans left out. */
export function meterBands(limits: Limits): BandSpan[] {
  const [b1, b2, b3, b4, b5] = bounds(limits);
  const edges = [METER_MIN, b1, b2, b3, b4, b5, METER_MAX].map(meterPosition);
  return BANDS.map((band, i) => ({
    band,
    from: edges[i],
    to: edges[i + 1],
  })).filter((s) => s.to > s.from);
}

/** The envelope (dBFS per 48th of the take) as bar heights 0..1 on the meter's scale. */
export function envelopeHeights(envelope: readonly number[]): number[] {
  return envelope.map((v) => meterPosition(v));
}
