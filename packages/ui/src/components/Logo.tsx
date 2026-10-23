import type * as React from "react";
import { GEO } from "../lib/geo";
import { useReducedMotion, useUid } from "../lib/hooks";
import { pal, type Palette } from "../lib/palettes";
import { cx, type Style } from "../lib/util";

export function GradientDefs(p: {
  id: string;
  palette?: string;
  box: readonly number[];
  animate: boolean;
}) {
  const pl = pal(p.palette),
    stops = pl.metal || pl.stops;
  const b = p.box,
    cxp = b[0] + b[2] / 2,
    cyp = b[1] + b[3] / 2;
  const kids: React.ReactNode[] = stops.map((c, i) => (
    <stop
      key={c + i}
      offset={i / (stops.length - 1)}
      style={{ stopColor: "var(--" + c + ")" }}
    />
  ));
  if (p.animate) {
    kids.push(
      <animateTransform
        key="spin"
        attributeName="gradientTransform"
        type="rotate"
        from={"0 " + cxp + " " + cyp}
        to={"360 " + cxp + " " + cyp}
        dur="16s"
        repeatCount="indefinite"
      />,
    );
  }
  return (
    <defs>
      <linearGradient
        id={p.id}
        gradientUnits="userSpaceOnUse"
        x1={b[0]}
        y1={b[1]}
        x2={b[0] + b[2]}
        y2={b[1] + b[3]}
      >
        {kids}
      </linearGradient>
    </defs>
  );
}

export interface LogoProps {
  /** 'lockup' (default), 'mark', 'stacked' or 'wordmark'. */
  variant?: "lockup" | "mark" | "stacked" | "wordmark";
  /** 'ink' follows the theme (default); 'paper' is for night and dark photos; 'gradient' (liquid metal) for the mark on night at 64px and up; 'current' uses CSS color. */
  tone?: "ink" | "paper" | "gradient" | "current";
  /** Gradient palette when tone is 'gradient'. Default 'morgengry'. */
  palette?: Palette;
  /** Height in px. Defaults: mark 48, lockup 32, stacked 96. */
  size?: number;
  /** Let a gradient slowly turn (default true; always off with reduced motion). */
  animated?: boolean;
  /** Accessible name. Default 'WalkieTalkey'. */
  title?: string;
  /** Hide from assistive tech when the name is already written next to it. */
  decorative?: boolean;
  className?: string;
  style?: React.CSSProperties;
}

export function Logo(props: LogoProps) {
  const variant = props.variant || "lockup";
  const tone = props.tone || "ink";
  const reduced = useReducedMotion();
  const gid = useUid("wt-logo-");
  const g = GEO;
  let box: readonly number[], kids: React.ReactNode[];
  if (variant === "mark") {
    box = [0, 0, g.mark.w, g.mark.h];
    kids = [<path key="m" d={g.mark.d} />];
  } else if (variant === "wordmark") {
    box = g.word.box;
    kids = [<path key="w" d={g.word.d} />];
  } else if (variant === "stacked") {
    box = g.stacked.box;
    kids = [
      <path key="m" d={g.mark.d} transform={g.stacked.markT} />,
      <path key="w" d={g.word.d} transform={g.stacked.wordT} />,
    ];
  } else {
    box = g.lockup.box;
    kids = [
      <path key="m" d={g.mark.d} transform={g.lockup.markT} />,
      <path key="w" d={g.word.d} transform={g.lockup.wordT} />,
    ];
  }
  const height =
    props.size || (variant === "mark" ? 48 : variant === "stacked" ? 96 : 32);
  const width = Math.round(((height * box[2]) / box[3]) * 100) / 100;
  const fill =
    tone === "ink"
      ? "var(--ink)"
      : tone === "paper"
        ? "var(--on-night)"
        : tone === "gradient"
          ? "url(#" + gid + ")"
          : "currentColor";
  const a11y = props.decorative
    ? { "aria-hidden": true, focusable: "false" as const }
    : { role: "img", "aria-label": props.title || "WalkieTalkey" };
  return (
    <svg
      className={cx("wt-logo", props.className)}
      viewBox={box.join(" ")}
      width={width}
      height={height}
      style={props.style}
      {...a11y}
    >
      {tone === "gradient" ? (
        <GradientDefs
          id={gid}
          palette={props.palette}
          box={box}
          animate={props.animated !== false && !reduced}
        />
      ) : null}
      <g fill={fill}>{kids}</g>
    </svg>
  );
}

export interface FloatingMarkProps {
  /** Mark height in px. Default 160. */
  size?: number;
  /** 'ink' (default) on light surfaces and gradients; 'gradient' or 'paper' on night. */
  tone?: "ink" | "paper" | "gradient";
  palette?: Palette;
  /** Multiplies the speed of the 6 s float. Default 1. */
  speed?: number;
  /** The shadow (ink) or glow (gradient, paper) under the mark. Default true. */
  glow?: boolean;
  /** Accessible name; without it the mark is decorative. */
  title?: string;
  className?: string;
  style?: React.CSSProperties;
}

export function FloatingMark(props: FloatingMarkProps) {
  const size = props.size || 160;
  const w = Math.round((size * GEO.mark.w) / GEO.mark.h);
  const style = Object.assign(
    {
      width: w,
      height: Math.round(size * 1.32),
      "--wt-speed": props.speed || 1,
    } as Style,
    props.style,
  );
  return (
    <div className={cx("wt-float", props.className)} style={style}>
      {props.glow === false ? null : (
        <span
          className={cx(
            "wt-float-shadow",
            (props.tone === "gradient" || props.tone === "paper") &&
              "wt-float-shadow--glow",
          )}
          aria-hidden
        />
      )}
      <span className="wt-float-body">
        <Logo
          variant="mark"
          tone={props.tone || "ink"}
          palette={props.palette}
          size={size}
          title={props.title}
          decorative={!props.title}
        />
      </span>
    </div>
  );
}
