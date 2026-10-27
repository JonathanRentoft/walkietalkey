/* Numbers, times and dates in Danish: comma decimals ("6,32 %"), a point between thousands
   ("1.041"), a real minus sign, and a no-break space before a unit so "%" never wraps alone. */

export const NBSP = "\u00a0";
const MINUS = "\u2212";

const cache = new Map<string, Intl.NumberFormat>();
function nf(min: number, max: number): Intl.NumberFormat {
  const key = `${min}:${max}`;
  let f = cache.get(key);
  if (!f) {
    f = new Intl.NumberFormat("da-DK", {
      minimumFractionDigits: min,
      maximumFractionDigits: max,
    });
    cache.set(key, f);
  }
  return f;
}

function finite(n: number | null | undefined): n is number {
  return typeof n === "number" && Number.isFinite(n);
}

/** A number with exactly `digits` decimals: 3.4 → "3,4", -38 → "\u221238". */
export function decimal(n: number, digits = 1): string {
  const s = nf(digits, digits).format(n === 0 ? 0 : n);
  return s.startsWith("-") ? MINUS + s.slice(1) : s;
}

/** A number with as many decimals as it has (a setting): 0.0002 → "0,0002". */
export function plain(n: number): string {
  if (Number.isInteger(n)) return int(n);
  const s = nf(0, 10).format(n);
  return s.startsWith("-") ? MINUS + s.slice(1) : s;
}

/** A whole number with thousands points: 1041 → "1.041". */
export function int(n: number): string {
  return decimal(Math.round(n), 0);
}

/** A fraction as percent: 0.0632 → "6,32 %". */
export function pct(fraction: number | null | undefined, digits = 2): string {
  if (!finite(fraction)) return "ingen";
  return `${decimal(fraction * 100, digits)}${NBSP}%`;
}

/** A value that already is percent (the mix's shares): 40 → "40 %". */
export function percent(value: number, digits = 0): string {
  return `${decimal(value, digits)}${NBSP}%`;
}

/** A 95 % interval of two fractions: [0.0626, 0.0718] → "6,26 til 7,18 %". */
export function interval(
  ci: readonly [number, number] | null | undefined,
  digits = 2,
): string {
  if (!ci || !finite(ci[0]) || !finite(ci[1])) return "ingen";
  return `${decimal(ci[0] * 100, digits)} til ${decimal(ci[1] * 100, digits)}${NBSP}%`;
}

/** A change of a fraction in percentage points: -0.008 → "\u22120,80 point". */
export function points(delta: number | null | undefined, digits = 2): string {
  if (!finite(delta)) return "ingen";
  const s = decimal(delta * 100, digits);
  return `${delta > 0 ? "+" : ""}${s}${NBSP}point`;
}

export function minutes(m: number | null | undefined): string {
  if (!finite(m)) return "ingen";
  return `${decimal(m, 1)}${NBSP}min`;
}

export function seconds(s: number | null | undefined): string {
  if (!finite(s)) return "ingen";
  return `${decimal(s, 1)}${NBSP}s`;
}

/** A level: -38.2 → "\u221238 dBFS". */
export function dbfs(v: number | null | undefined): string {
  if (!finite(v)) return "ingen";
  return `${decimal(v, 0)}${NBSP}dBFS`;
}

/** A level difference: 22.8 → "23 dB". */
export function db(v: number | null | undefined): string {
  if (!finite(v)) return "ingen";
  return `${decimal(v, 0)}${NBSP}dB`;
}

/** Elapsed seconds as a clock: 3.2 → "0:03", 75 → "1:15". */
export function clock(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

const DATE = new Intl.DateTimeFormat("da-DK", {
  day: "numeric",
  month: "short",
  year: "numeric",
});
const DATE_TIME = new Intl.DateTimeFormat("da-DK", {
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

function parse(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  // A bare date ("2026-10-27") is a calendar day, not midnight UTC.
  const d = /^\d{4}-\d{2}-\d{2}$/.test(iso)
    ? new Date(`${iso}T12:00:00`)
    : new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** "26. okt. 2026" (or the text itself when it is not a date). */
export function date(iso: string | null | undefined): string {
  const d = parse(iso);
  return d ? DATE.format(d) : (iso ?? "");
}

/** "26. okt. 2026 kl. 17.07". */
export function dateTime(iso: string | null | undefined): string {
  const d = parse(iso);
  if (!d) return iso ?? "";
  if (iso && /^\d{4}-\d{2}-\d{2}$/.test(iso)) return DATE.format(d);
  return DATE_TIME.format(d).replace(", ", " kl. ");
}
