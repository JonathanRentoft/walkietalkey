import type * as React from "react";

/** A style object that may carry CSS custom properties. */
export type Style = React.CSSProperties & {
  [k: `--${string}`]: string | number | undefined;
};

export function cx(...parts: unknown[]): string {
  const out: string[] = [];
  for (const p of parts) if (p) out.push(p as string);
  return out.join(" ");
}

export function omit<T extends object, K extends keyof T>(
  obj: T,
  keys: readonly K[],
): Omit<T, K> {
  const out = {} as Record<string, unknown>;
  for (const k in obj)
    if (
      Object.prototype.hasOwnProperty.call(obj, k) &&
      !keys.includes(k as unknown as K)
    )
      out[k] = (obj as Record<string, unknown>)[k];
  return out as Omit<T, K>;
}

/** Deterministic pseudo random in [0, 1). */
export function rand(n: number): number {
  const x = Math.sin(n * 12.9898 + 78.233) * 43758.5453;
  return x - Math.floor(x);
}

/** True when the nearest [data-theme] (or the document) is dark. Call only in effects, never during render. */
export function isDark(el: Element | null): boolean {
  if (el && el.closest) {
    const t = el.closest("[data-theme]");
    if (t) return t.getAttribute("data-theme") === "dark";
  }
  return document.documentElement.getAttribute("data-theme") === "dark";
}

export function r2(v: number): number {
  return Math.round(v * 100) / 100;
}
export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
export function seg(t: number, a: number, b: number): number {
  return clamp01((t - a) / (b - a));
}
export function easeInOut(p: number): number {
  return p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
}
export function easeOut(p: number): number {
  return 1 - Math.pow(1 - p, 3);
}
export function easeIn(p: number): number {
  return p * p * p;
}
export function smooth(p: number): number {
  return p * p * (3 - 2 * p);
}
/** A damped spring from 0 to 1 that overshoots once. */
export function spring(u: number): number {
  return 1 - Math.exp(-5.2 * u) * Math.cos(9.5 * u);
}

/** m:ss */
export function fmt(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  return Math.floor(s / 60) + ":" + (s % 60 < 10 ? "0" : "") + (s % 60);
}

/** Fills {name} placeholders, e.g. fill("Klar på {computer}", { computer: "MacBook" }). */
export function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (m, k: string) =>
    k in values ? values[k] : m,
  );
}
