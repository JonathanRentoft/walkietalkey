/* The charts, in SVG and plain HTML: a line chart with a hover crosshair (training loss and WER),
   horizontal bars (minutes, progress, the pilot's small multiples) and stacked bars (the
   splits). Marks follow the dataviz rules: 2 px lines, >= 8 px markers with a surface ring,
   bars <= 24 px with a 4 px rounded end, hairline grid, text in text colours, a legend for two
   or more series and a table view. Colours: --series-1..3 (styles.css, validated). */
import {
  useEffect,
  useRef,
  useState,
  type PointerEvent,
  type ReactNode,
  type RefObject,
} from "react";
import type { Point } from "../api/types";
import { linearScale, linePath, nearest } from "../lib/chart";
import { S } from "../strings";

function useWidth<T extends HTMLElement>(
  fallback: number,
): [RefObject<T>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const cw = entries[0]?.contentRect.width;
      if (cw) setW((prev) => (Math.abs(cw - prev) > 1 ? Math.round(cw) : prev));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

/* ------------------------------------------------------------ legend */

export interface LegendItem {
  label: string;
  series: 1 | 2 | 3;
  mark?: "line" | "dot" | "block";
  faint?: boolean;
}

export function Legend({ items }: { items: LegendItem[] }) {
  return (
    <ul className="legend">
      {items.map((it) => (
        <li key={it.label}>
          <span
            className={`key key--${it.mark ?? "block"} s${it.series} ${it.faint ? "key--faint" : ""}`}
            aria-hidden="true"
          />
          {it.label}
        </li>
      ))}
    </ul>
  );
}

/* -------------------------------------------------------- line chart */

export interface LineSeries {
  id: string;
  label: string;
  series: 1 | 2 | 3;
  points: Point[];
  /** Points as dots (validation per epoch) as well as the line. */
  dots?: boolean;
  /** A thin, faint line under the main one (the raw train loss). */
  raw?: Point[];
}

const M = { top: 14, right: 64, bottom: 44, left: 52 };

export function LineChart({
  label,
  series,
  xDomain,
  y,
  yFormat,
  xFormat,
  xLabel,
  height = 240,
  empty,
}: {
  label: string;
  series: LineSeries[];
  xDomain: [number, number];
  y: { domain: [number, number]; ticks: number[] };
  yFormat: (v: number) => string;
  xFormat: (v: number) => string;
  xLabel: string;
  height?: number;
  empty?: ReactNode;
}) {
  const [ref, width] = useWidth<HTMLDivElement>(640);
  const [hover, setHover] = useState<number | null>(null);
  const w = Math.max(240, width);
  const x = linearScale(xDomain, [M.left, w - M.right]);
  const ys = linearScale(y.domain, [height - M.bottom, M.top]);
  const xt = xTicks(xDomain);
  const has = series.some((s) => s.points.length > 0);

  const onMove = (e: PointerEvent<SVGRectElement>) => {
    const r = (
      e.currentTarget.ownerSVGElement ?? e.currentTarget
    ).getBoundingClientRect();
    const px = e.clientX - r.left;
    setHover(
      Math.round(Math.min(xDomain[1], Math.max(xDomain[0], x.invert(px)))),
    );
  };

  const ends = series
    .filter((s) => s.points.length > 0)
    .map((s) => ({ s, p: s.points[s.points.length - 1] }));

  return (
    <div className="chart" ref={ref}>
      <svg
        width={w}
        height={height}
        viewBox={`0 0 ${w} ${height}`}
        role="img"
        aria-label={label}
      >
        <g className="grid">
          {y.ticks.map((t) => (
            <line key={t} x1={M.left} x2={w - M.right} y1={ys(t)} y2={ys(t)} />
          ))}
        </g>
        <g className="axis">
          {y.ticks.map((t) => (
            <text key={t} x={M.left - 8} y={ys(t)} dy="0.32em" textAnchor="end">
              {yFormat(t)}
            </text>
          ))}
          {xt.map((t) => (
            <text
              key={t}
              x={x(t)}
              y={height - M.bottom + 17}
              textAnchor="middle"
            >
              {xFormat(t)}
            </text>
          ))}
          <text
            className="axis-label"
            x={w - M.right}
            y={height - 2}
            textAnchor="end"
          >
            {xLabel}
          </text>
          <line
            className="baseline"
            x1={M.left}
            x2={w - M.right}
            y1={height - M.bottom}
            y2={height - M.bottom}
          />
        </g>
        {series.map((s) => (
          <g key={s.id} className={`series s${s.series}`}>
            {s.raw && s.raw.length > 1 && (
              <path className="line line--raw" d={linePath(s.raw, x, ys)} />
            )}
            {s.points.length > 1 && (
              <path className="line" d={linePath(s.points, x, ys)} />
            )}
            {s.dots &&
              s.points.map(([px, py]) => (
                <circle
                  key={px}
                  className="dot"
                  cx={x(px)}
                  cy={ys(py)}
                  r={4.5}
                />
              ))}
          </g>
        ))}
        {ends.map(({ s, p }) => (
          <text
            key={s.id}
            className="end-label"
            x={x(p[0]) + (s.dots ? 0 : 8)}
            y={ys(p[1]) - (s.dots ? 12 : 0)}
            dy="0.32em"
            textAnchor={s.dots ? "middle" : "start"}
          >
            {yFormat(p[1])}
          </text>
        ))}
        {hover !== null && has && (
          <line
            className="crosshair"
            x1={x(hover)}
            x2={x(hover)}
            y1={M.top}
            y2={height - M.bottom}
          />
        )}
        {hover !== null &&
          series.map((s) => {
            const p = nearest(s.points, hover);
            return p ? (
              <circle
                key={s.id}
                className={`hover-dot s${s.series}`}
                cx={x(p[0])}
                cy={ys(p[1])}
                r={5}
              />
            ) : null;
          })}
        <rect
          className="hit"
          x={M.left}
          y={M.top}
          width={Math.max(0, w - M.left - M.right)}
          height={height - M.top - M.bottom}
          onPointerMove={onMove}
          onPointerLeave={() => setHover(null)}
        />
      </svg>
      {!has && empty && <div className="chart-empty">{empty}</div>}
      {hover !== null && has && (
        <div
          className="tooltip"
          style={{
            left: `${Math.min(w - 180, Math.max(0, x(hover) + 12))}px`,
            top: `${M.top}px`,
          }}
          role="presentation"
        >
          <p className="tooltip-title">
            {S.training.tooltipStep(xFormat(hover))}
          </p>
          {series.map((s) => {
            const p = nearest(s.points, hover);
            if (!p) return null;
            return (
              <p key={s.id} className="tooltip-row">
                <span
                  className={`key key--${s.dots ? "dot" : "line"} s${s.series}`}
                  aria-hidden="true"
                />
                <span>{s.label}</span>
                <strong>{yFormat(p[1])}</strong>
                {p[0] !== hover && (
                  <span className="muted">
                    ({S.training.tooltipStep(xFormat(p[0]))})
                  </span>
                )}
              </p>
            );
          })}
        </div>
      )}
    </div>
  );
}

function xTicks([lo, hi]: [number, number]): number[] {
  const span = hi - lo;
  const raw = span / 6;
  const mag = 10 ** Math.floor(Math.log10(Math.max(1, raw)));
  const step =
    [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? mag * 10;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step)
    out.push(v);
  return out;
}

/* --------------------------------------------------------------- bars */

export interface BarRow {
  key: string;
  label: string;
  value: number;
  text: string;
  /** Optional second text under the value (the mix share). */
  sub?: string;
}

/** Horizontal bars from zero (or from `min`), one series, the value at the tip. */
export function Bars({
  rows,
  max,
  min = 0,
  series = 1,
  label,
  track,
  wide,
}: {
  rows: BarRow[];
  max: number;
  min?: number;
  series?: 1 | 2 | 3;
  label: string;
  /** Draw the unfilled track (for done of planned). */
  track?: boolean;
  /** Room for a longer value text. */
  wide?: boolean;
}) {
  const span = max - min || 1;
  return (
    <ul
      className={`bars ${track ? "bars--track" : ""} ${wide ? "bars--wide" : ""}`}
      aria-label={label}
    >
      {rows.map((r) => {
        const t = Math.min(1, Math.max(0, (r.value - min) / span));
        return (
          <li key={r.key} className="bar-row">
            <span className="bar-label">{r.label}</span>
            <span className="bar-cell">
              <span className={`bar-track s${series}`}>
                <span
                  className={`bar-fill s${series} ${t === 0 ? "bar-fill--zero" : ""}`}
                  style={{ width: `${t * 100}%` }}
                />
              </span>
              <span className="bar-value">
                {r.text}
                {r.sub && <span className="bar-sub">{r.sub}</span>}
              </span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}

export interface StackPart {
  label: string;
  value: number;
  text: string;
  series: 1 | 2 | 3;
}

/** One stacked bar (with the 2 px surface gap between segments) per row, a shared scale. */
export function StackedBars({
  rows,
  max,
  label,
}: {
  rows: { key: string; label: string; parts: StackPart[]; total: string }[];
  max: number;
  label: string;
}) {
  return (
    <ul className="bars bars--stacked" aria-label={label}>
      {rows.map((r) => (
        <li key={r.key} className="bar-row">
          <span className="bar-label">{r.label}</span>
          <span className="bar-cell">
            <span className="stack">
              {r.parts
                .filter((p) => p.value > 0)
                .map((p) => (
                  <span
                    key={p.label}
                    className={`stack-part s${p.series}`}
                    style={{ width: `${(max > 0 ? p.value / max : 0) * 100}%` }}
                    title={`${p.label}: ${p.text}`}
                  >
                    <span className="sr">
                      {p.label}: {p.text}
                    </span>
                  </span>
                ))}
            </span>
            <span className="bar-value">{r.total}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}
