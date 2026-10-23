/* Logo loaders. The mark is two shields that overlap: drawn together with fill-rule evenodd, the overlap
   becomes the slit. GEO.shields holds each shield as one closed cubic path in the mark's own frame, so they can
   move apart and melt back together. A gooey filter (blur, then a hard alpha curve) grows the liquid bridges. */
import { useRef, type CSSProperties, type ReactNode, type RefObject } from "react";
import { GEO, type Shield } from "../lib/geo";
import { useFrames, useReducedMotion, useUid } from "../lib/hooks";
import type { Palette } from "../lib/palettes";
import { clamp01, cx, easeIn, easeInOut, easeOut, r2, seg, smooth, spring } from "../lib/util";
import { GradientDefs } from "./Logo";

const SH = GEO.shields;

/** a shield path: scaled and turned about a pivot (default: its own centre), then moved */
function shieldD(s: Shield, o: { px?: number; py?: number; sx?: number; sy?: number; rot?: number; dx?: number; dy?: number }): string {
  const n = s.n, px = o.px == null ? s.c[0] : o.px, py = o.py == null ? s.c[1] : o.py;
  const sx = o.sx == null ? 1 : o.sx, sy = o.sy == null ? 1 : o.sy, a = o.rot || 0;
  const cs = Math.cos(a), sn = Math.sin(a), dx = o.dx || 0, dy = o.dy || 0;
  function P(i: number) {
    const x = (n[i] - px) * sx, y = (n[i + 1] - py) * sy;
    return r2(px + x * cs - y * sn + dx) + " " + r2(py + x * sn + y * cs + dy);
  }
  let d = "M" + P(0);
  for (let i = 2; i < n.length; i += 6) d += "C" + P(i) + " " + P(i + 2) + " " + P(i + 4);
  return d + "Z";
}
function circleD(x: number, y: number, rx: number, ry: number): string {
  if (rx <= 0.05 || ry <= 0.05) return "";
  return "M" + r2(x - rx) + " " + r2(y) + "a" + r2(rx) + " " + r2(ry) + " 0 1 0 " + r2(rx * 2) + " 0a" + r2(rx) + " " + r2(ry) + " 0 1 0 " + r2(-rx * 2) + " 0Z";
}

type Tone = "ink" | "paper" | "gradient" | "current";
function fillFor(tone: Tone, gid: string): string {
  return tone === "paper" ? "var(--on-night)" : tone === "gradient" ? "url(#" + gid + ")" : tone === "current" ? "currentColor" : "var(--ink)";
}

/** Sets the goo: blur in user units, and an alpha curve steep enough for a crisp edge at the current pixel size. */
function setGoo(svg: SVGSVGElement, blurEl: SVGFEGaussianBlurElement, cmEl: SVGFEColorMatrixElement, blur: number, unitsWide: number) {
  blurEl.setAttribute("stdDeviation", String(r2(blur)));
  const px = svg.getBoundingClientRect().width / unitsWide * blur;
  const k = Math.max(7, Math.min(40, 2.6 * px));
  cmEl.setAttribute("values", "1 0 0 0 0 0 1 0 0 0 0 0 1 0 0 0 0 0 " + r2(k) + " " + r2(-(k * 0.45 - 0.5)));
}

function GooFilter(p: { id: string; box: readonly number[]; blurRef: RefObject<SVGFEGaussianBlurElement>; cmRef: RefObject<SVGFEColorMatrixElement> }) {
  const vb = p.box;
  return (
    <filter id={p.id} x={vb[0]} y={vb[1]} width={vb[2]} height={vb[3]} filterUnits="userSpaceOnUse" colorInterpolationFilters="sRGB">
      <feGaussianBlur ref={p.blurRef} in="SourceGraphic" stdDeviation={0} result="b" />
      <feColorMatrix ref={p.cmRef} in="b" type="matrix" values="1 0 0 0 0 0 1 0 0 0 0 0 1 0 0 0 0 0 12 -4.9" />
    </filter>
  );
}

const MW = GEO.mark.w; /* 127.34: the mark is 100 tall */
type Variant = "smelt" | "kviksolv" | "drabe" | "fyld" | "ekko" | "glans";
/* view boxes per variant, in mark units: room for what moves */
const LOADER_BOX: Record<Variant, readonly number[]> = {
  smelt: [-30, -14, MW + 60, 128],
  kviksolv: [-10, -10, MW + 20, 120],
  drabe: [-8, -6, MW + 16, 178],
  fyld: [-4, -4, MW + 8, 108],
  ekko: [-48, -40, MW + 96, 180],
  glans: [-4, -4, MW + 8, 108],
};
const LOADER_SPEED: Record<Variant, number> = { smelt: 3.0, kviksolv: 3.9, drabe: 2.9, fyld: 3.4, ekko: 2.4, glans: 2.4 };

/* Kviksølv: each stroke runs out into three beads of mercury that chase each other round, then pool back into the mark. */
const CX = MW / 2, CY = 50;
const BEADS: { s: "al" | "ar"; ox: number; oy: number }[] = [
  { s: "al", ox: 11, oy: -27 }, { s: "al", ox: 0, oy: 0 }, { s: "al", ox: -9, oy: 28 },
  { s: "ar", ox: 22, oy: -27 }, { s: "ar", ox: 0, oy: 0 }, { s: "ar", ox: -18, oy: 27 },
];

export interface LogoLoaderProps {
  /** 'smelt' (default) the strokes melt apart and back; 'kviksolv' mercury beads; 'drabe' a drop falls from a tip; 'fyld' liquid fill (progress); 'ekko' radio rings; 'glans' a small sheen for buttons. */
  variant?: Variant;
  /** Height of the mark in px. Default 64. The box is larger where the motion needs room. */
  size?: number;
  tone?: Tone;
  palette?: Palette;
  /** 'fyld' only: 0 to 1. Makes it a determinate progressbar. */
  progress?: number;
  /** Multiplies the tempo. Default 1. */
  speed?: number;
  /** Accessible name. Default 'Indlæser', or 'Henter' with progress. */
  label?: string;
  className?: string;
  style?: CSSProperties;
}

export function LogoLoader(props: LogoLoaderProps) {
  const variant: Variant = props.variant && LOADER_BOX[props.variant] ? props.variant : "smelt";
  const tone = props.tone || "ink";
  const reduced = useReducedMotion();
  const gid = useUid("wt-ll-g-"), fid = useUid("wt-ll-f-"), cid = useUid("wt-ll-c-");
  const svg = useRef<SVGSVGElement>(null), blurRef = useRef<SVGFEGaussianBlurElement>(null), cmRef = useRef<SVGFEColorMatrixElement>(null);
  const gooRef = useRef<SVGGElement>(null), exactRef = useRef<SVGPathElement>(null);
  const aRef = useRef<SVGPathElement>(null), bRef = useRef<SVGPathElement>(null), cRef = useRef<SVGPathElement>(null);
  const beadRefs = useRef<(SVGPathElement | null)[]>([]);
  const box = LOADER_BOX[variant];
  const size = props.size || 64;
  const height = Math.round(size * box[3] / 100);
  const width = Math.round(size * box[2] / 100);
  const period = (LOADER_SPEED[variant] || 3) / (props.speed || 1);
  const fill = fillFor(tone, gid);
  const determinate = variant === "fyld" && typeof props.progress === "number";
  const prog = useRef(0);
  const target = useRef(0);
  target.current = determinate ? clamp01(props.progress as number) : -1;

  const goo = variant === "smelt" || variant === "kviksolv" || variant === "drabe";

  useFrames(svg, reduced || variant === "ekko" || variant === "glans", (t) => {
    const el = svg.current;
    if (!el) return;
    if (t < 0) { /* reduced motion: the still mark; a fill shows its level */
      if (variant === "fyld") drawFill(determinate ? target.current : 0.62, 0);
      return;
    }
    const u = (t / period) % 1;
    if (variant === "smelt") drawSmelt(u);
    else if (variant === "kviksolv") drawMercury(u, t);
    else if (variant === "drabe") drawDrip(u, Math.floor(t / period));
    else if (variant === "fyld") {
      let lvl: number;
      if (determinate) { prog.current += (target.current - prog.current) * 0.08; lvl = prog.current; }
      else lvl = 0.1 + 0.8 * (0.5 - 0.5 * Math.cos(u * 6.2832));
      drawFill(lvl, t);
    }
  }, [variant, reduced, period, determinate]);

  /* The exact mark sits on top of the liquid layer. While the liquid is on, the mark fades out and back in over it,
     so the outline never thins during the hand-over. */
  function layers(ex: number, on: boolean) {
    if (exactRef.current) exactRef.current.style.opacity = String(r2(ex));
    if (gooRef.current) gooRef.current.style.opacity = on ? "1" : "0";
  }
  function goo_(blur: number) { setGoo(svg.current!, blurRef.current!, cmRef.current!, blur, box[2]); }

  /* Smelt: the two shields of the mark swing open on the neck like a hinge, the neck stretches into a liquid
     thread and lets go, and they swing back and fuse with a small squash. */
  function drawSmelt(u: number) {
    const B = 3.4, gap = 15, P = SH.cusp;
    let th = 0, dx = 0, dy = 0, sx = 1, sy = 1, blur = 0, ex = 1, on = false;
    if (u < 0.08) { ex = 1; }
    else if (u < 0.3) {
      const p = easeInOut(seg(u, 0.08, 0.3));
      th = 0.16 * p; blur = B * smooth(seg(u, 0.08, 0.15)); ex = 1 - smooth(seg(u, 0.12, 0.18)); on = true;
    } else if (u < 0.52) {
      const q = easeInOut(seg(u, 0.3, 0.52));
      th = 0.16 - 0.08 * q; dx = gap * q; dy = -2.5 * Math.sin(Math.PI * q); blur = B; ex = 0; on = true;
    } else if (u < 0.62) {
      const w = seg(u, 0.52, 0.62);
      th = 0.12; dx = gap; sy = 1 + 0.035 * Math.sin(w * Math.PI * 3) * (1 - w); sx = 1 - 0.6 * (sy - 1); blur = B; ex = 0; on = true;
    } else if (u < 0.88) {
      const r = seg(u, 0.62, 0.88), sp = spring(r * 1.3), hit = Math.max(0, sp - 0.92);
      dx = gap * (1 - sp); th = 0.12 * (1 - sp); sy = 1 - 0.7 * hit; sx = 1 + 0.55 * hit;
      blur = B * (1 - 0.65 * smooth(seg(u, 0.8, 0.88))); ex = 0; on = true;
    } else if (u < 0.96) {
      const e = seg(u, 0.88, 0.96);
      blur = B * 0.35; ex = smooth(e); on = true;
    }
    goo_(blur);
    aRef.current!.setAttribute("d",
      shieldD(SH.al, { px: P[0], py: P[1], rot: -th, dx: -dx, dy, sx, sy }) +
      shieldD(SH.ar, { px: P[0], py: P[1], rot: th, dx, dy, sx, sy }));
    layers(ex, on);
  }

  function drawMercury(u: number, t: number) {
    const B = 3.6;
    let blur = 0, ex = 1, on = false, k = 0;
    if (u < 0.08) { ex = 1; }
    else if (u < 0.3) { k = easeInOut(seg(u, 0.08, 0.3)); blur = B * smooth(seg(u, 0.08, 0.13)); ex = 1 - smooth(seg(u, 0.085, 0.11)); on = true; }
    else if (u < 0.68) { k = 1; blur = B; ex = 0; on = true; }
    else if (u < 0.9) { k = 1 - easeInOut(seg(u, 0.68, 0.9)); blur = B * (1 - 0.65 * smooth(seg(u, 0.84, 0.9))); ex = 0; on = true; }
    else if (u < 0.97) { const e = seg(u, 0.9, 0.97); blur = B * 0.35; ex = smooth(e); on = true; }
    const sc = Math.max(0.001, 1 - k * 1.05);
    for (let i = 0; i < BEADS.length; i++) {
      const b = BEADS[i], s = SH[b.s];
      const hx = s.c[0] + b.ox, hy = s.c[1] + b.oy;
      const ang = -Math.PI / 2 + i * (Math.PI / 3) + t * 1.1 + 0.55 * Math.sin(t * 1.3 + i * 2.1);
      const rr = 1 + 0.1 * Math.sin(t * 1.7 + i * 1.3);
      const ox = CX + Math.cos(ang) * 50 * rr, oy = CY + Math.sin(ang) * 36 * rr;
      const kk = smooth(k);
      const x = hx + (ox - hx) * kk, y = hy + (oy - hy) * kk;
      const rad = (9 - 2.2 * kk) * (k > 0 ? 1 : 0) + kk * 0.6 * Math.sin(t * 2.3 + i);
      const el = beadRefs.current[i];
      if (el) el.setAttribute("d", on ? circleD(x, y, rad, rad) : "");
    }
    goo_(blur);
    aRef.current!.setAttribute("d", shieldD(SH.al, { sx: sc, sy: sc }) + shieldD(SH.ar, { sx: sc, sy: sc }));
    layers(ex, on);
  }

  /* Dråbe: a drop gathers at a tip and stretches on a liquid neck, lets go, falls and splashes into a small pool.
     Left and right tip take turns. */
  function drawDrip(u: number, cycle: number) {
    const left = cycle % 2 === 0, s = left ? SH.al : SH.ar;
    const tx = s.tip[0] + (left ? 3.2 : 3.6), ty = s.tip[1];
    const poolY = ty + 62;
    let dropY = ty, rad = 0, sq = 1, poolW = 0, poolH = 0, spl = 0;
    if (u < 0.34) { const p = easeInOut(seg(u, 0, 0.34)); rad = 7 * Math.min(1, p * 1.4); dropY = ty - 5 + 15 * p; sq = 1 + 0.28 * p; }
    else if (u < 0.6) { const q = seg(u, 0.34, 0.6); rad = 7 - 0.6 * q; dropY = ty + 10 + (poolY - ty - 12) * q * q; sq = 1.28 - 0.12 * q; }
    else if (u < 0.82) {
      const r = seg(u, 0.6, 0.82); rad = 6.4 * (1 - easeOut(r)); dropY = poolY - 2 + 3 * r; sq = 0.75;
      poolW = 5 + 13 * easeOut(r); poolH = 2.6 + 1.4 * Math.sin(Math.PI * r); spl = r;
    } else { const e = seg(u, 0.82, 1); poolW = 18 * (1 - easeIn(e)); poolH = 3.4 * (1 - e); }
    const drops = circleD(tx, dropY, rad / Math.sqrt(sq), rad * sq) + circleD(tx, ty - 6, 5, 5);
    let splash = "";
    if (spl > 0 && spl < 1) {
      const hgt = 10 * Math.sin(Math.PI * spl), rs = 1.9 * (1 - spl * 0.6);
      splash = circleD(tx - 6 - 13 * spl, poolY - hgt, rs, rs) + circleD(tx + 6 + 13 * spl, poolY - hgt * 0.8, rs * 0.85, rs * 0.85);
    }
    goo_(3.2);
    bRef.current!.setAttribute("d", drops);
    cRef.current!.setAttribute("d", circleD(tx, poolY + 2, poolW, poolH) + splash);
  }

  /* Fyld: liquid metal rises inside the mark. Determinate with `progress`, otherwise it breathes. */
  function drawFill(level: number, t: number) {
    const y = 100 - level * 100, amp = 2.4 * (0.4 + 0.6 * Math.sin(Math.PI * clamp01(level))) + 0.4;
    function wave(ph: number, a: number, k: number) {
      let d = "M-8 108L-8 " + r2(y + a * Math.sin(k * -8 + ph));
      for (let x = -4; x <= MW + 8; x += 4) d += "L" + x + " " + r2(y + a * Math.sin(k * x + ph));
      return d + "L" + (MW + 8) + " 108Z";
    }
    if (aRef.current) aRef.current.setAttribute("d", wave(t * 2.6 + 1.7, amp * 0.9, 0.075));
    if (bRef.current) bRef.current.setAttribute("d", wave(-t * 3.1, amp, 0.062));
  }

  const sp = props.speed || 1;
  const defs: ReactNode[] = [];
  if (tone === "gradient") defs.push(<GradientDefs key="g" id={gid} palette={props.palette} box={box} animate={!reduced} />);
  if (goo) defs.push(<GooFilter key="f" id={fid} box={box} blurRef={blurRef} cmRef={cmRef} />);
  if (variant === "fyld") defs.push(<clipPath key="c" id={cid}><path d={GEO.mark.d} /></clipPath>);

  let body: ReactNode[];
  if (variant === "smelt" || variant === "kviksolv") {
    const beads: ReactNode[] = [];
    if (variant === "kviksolv") for (let i = 0; i < BEADS.length; i++) {
      const k = i;
      beads.push(<path key={"b" + k} ref={(el) => { beadRefs.current[k] = el; }} />);
    }
    body = [
      <g key="goo" ref={gooRef} filter={"url(#" + fid + ")"} fill={fill} style={{ opacity: 0 }}>
        <path ref={aRef} d={shieldD(SH.al, {}) + shieldD(SH.ar, {})} />{beads}
      </g>,
      <path key="x" ref={exactRef} d={GEO.mark.d} fill={fill} className={reduced ? "wt-loader-breathe" : undefined} />,
    ];
  } else if (variant === "drabe") {
    body = [
      <g key="goo" filter={"url(#" + fid + ")"} fill={fill}>
        <path ref={bRef} /><path ref={cRef} />
      </g>,
      <path key="x" d={GEO.mark.d} fill={fill} className={reduced ? "wt-loader-breathe" : undefined} />,
    ];
  } else if (variant === "fyld") {
    body = [
      <path key="ghost" d={GEO.mark.d} fill={fill} opacity={0.14} />,
      <g key="liq" clipPath={"url(#" + cid + ")"} fill={fill}>
        <path ref={aRef} opacity={0.45} />
        <path ref={bRef} />
      </g>,
    ];
  } else if (variant === "ekko") {
    body = [0, 1, 2].map((k) => (
      <path key={"e" + k} className="wt-echo" d={GEO.mark.d} fill="none" stroke={tone === "gradient" ? "var(--rav-dyb)" : fill} strokeWidth={1.5} vectorEffect="non-scaling-stroke"
        style={{ animationDelay: (-k * 0.8 / sp) + "s", animationDuration: (2.4 / sp) + "s" }} />
    )).concat([<path key="x" className="wt-echo-mark" d={GEO.mark.d} fill={fill} style={{ animationDuration: (0.8 / sp) + "s" }} />]);
  } else { /* glans */
    body = [
      <path key="x" className="wt-glans-mark" d={GEO.mark.d} fill={fill} />,
      <path key="s" d={GEO.mark.d} fill={"url(#" + gid + "-sheen)"} style={{ mixBlendMode: tone === "ink" ? "normal" : "screen" }} />,
    ];
    defs.push(
      <linearGradient key="sh" id={gid + "-sheen"} gradientUnits="userSpaceOnUse" x1={-40} y1={0} x2={0} y2={0}>
        <stop offset={0} stopColor="#ffffff" stopOpacity={0} />
        <stop offset={0.5} stopColor="#ffffff" stopOpacity={tone === "ink" ? 0.5 : 0.75} />
        <stop offset={1} stopColor="#ffffff" stopOpacity={0} />
        {reduced ? null : <animateTransform attributeName="gradientTransform" type="translate" values={"-30 0; " + (MW + 70) + " 0; " + (MW + 70) + " 0"} keyTimes="0; 0.7; 1" dur={(2.4 / sp) + "s"} repeatCount="indefinite" />}
      </linearGradient>,
    );
  }

  const label = props.label || (determinate ? "Henter" : "Indlæser");
  const a11y = determinate
    ? { role: "progressbar", "aria-label": label, "aria-valuemin": 0, "aria-valuemax": 100, "aria-valuenow": Math.round(clamp01(props.progress as number) * 100) }
    : { role: "status", "aria-label": label };
  return (
    <span className={cx("wt-loader", "wt-loader--" + variant, props.className)} style={Object.assign({ width, height }, props.style)} {...a11y}>
      <svg ref={svg} viewBox={box.join(" ")} width={width} height={height} aria-hidden focusable="false" style={{ overflow: "visible" }}>
        <defs>{defs}</defs>{body}
      </svg>
    </span>
  );
}

/* ------------------------------------------------------------ LogoIntro */

export interface LogoIntroProps {
  /** Show the wordmark sliding out from behind the mark. Default true. */
  wordmark?: boolean;
  /** Height in px. Defaults: 56 with wordmark, 96 without. */
  size?: number;
  tone?: Tone;
  palette?: Palette;
  speed?: number;
  /** Demo only: replay every N seconds. */
  loop?: number;
  /** Called once when the intro has played (also with reduced motion, where it stands finished at once). */
  onDone?: () => void;
  title?: string;
  decorative?: boolean;
  className?: string;
  style?: CSSProperties;
}

/** The shields fly in from each side, collide, melt into the mark, and the name slides out from behind it. Plays once. */
export function LogoIntro(props: LogoIntroProps) {
  const reduced = useReducedMotion();
  const withWord = props.wordmark !== false;
  const tone = props.tone || "ink";
  const gid = useUid("wt-li-g-"), fid = useUid("wt-li-f-"), cid = useUid("wt-li-c-");
  const svg = useRef<SVGSVGElement>(null), blurRef = useRef<SVGFEGaussianBlurElement>(null), cmRef = useRef<SVGFEColorMatrixElement>(null);
  const gooRef = useRef<SVGGElement>(null), exactRef = useRef<SVGPathElement>(null), aRef = useRef<SVGPathElement>(null);
  const wordRef = useRef<SVGPathElement>(null), clipRef = useRef<SVGRectElement>(null);
  const g = GEO;
  const box: readonly number[] = withWord ? g.lockup.box : [0, 0, g.mark.w, g.mark.h];
  const size = props.size || (withWord ? 56 : 96);
  const height = size, width = Math.round(size * box[2] / box[3]);
  const fill = fillFor(tone, gid);
  const dur = 2.2 / (props.speed || 1), wordDur = 0.8 / (props.speed || 1);
  const loop = props.loop ? Math.max(props.loop, dur + wordDur + 0.5) : 0;
  const done = useRef(false);
  const wb = g.word.box;

  function reportDone() {
    if (!done.current) { done.current = true; if (props.onDone) props.onDone(); }
  }

  useFrames(svg, reduced, (t) => {
    if (!svg.current) return;
    if (t < 0) { finish(); reportDone(); return; }
    if (loop) t = t % loop; else if (t > dur + wordDur + 0.1) { finish(); reportDone(); return; }
    const u = Math.min(1, t / dur), gap = 78, B = 3.4;
    const fly = easeOut(seg(u, 0, 0.3)), s = u < 0.3 ? 0 : spring((u - 0.3) / 0.7 * 1.6);
    const dx = u < 0.3 ? gap * (1 - fly) + 10 : 10 * (1 - s);
    const hit = u < 0.3 ? 0 : Math.exp(-6 * (u - 0.3) / 0.7) * Math.max(0, Math.sin(Math.min(1, (u - 0.3) / 0.1) * Math.PI / 2));
    const sx = u < 0.3 ? 1 + 0.12 * (1 - fly) : 1 + 0.07 * hit, sy = u < 0.3 ? 1 - 0.06 * (1 - fly) : 1 - 0.09 * hit;
    const blur = B * (u < 0.75 ? 1 : 1 - smooth(seg(u, 0.75, 0.92)) * 0.65), ex = smooth(seg(u, 0.92, 1));
    const op = smooth(seg(u, 0, 0.18));
    setGoo(svg.current, blurRef.current!, cmRef.current!, blur, box[2] / (withWord ? g.lockup.markS : 1));
    aRef.current!.setAttribute("d", shieldD(SH.al, { dx: -dx, sx, sy, rot: -0.12 * (1 - fly) }) + shieldD(SH.ar, { dx, sx, sy, rot: 0.12 * (1 - fly) }));
    gooRef.current!.style.opacity = ex >= 1 ? "0" : String(r2(op));
    exactRef.current!.style.opacity = String(ex);
    if (withWord) {
      const w = easeOut(seg(t, dur * 0.82, dur * 0.82 + wordDur));
      clipRef.current!.setAttribute("width", String(r2(wb[2] * w + 2)));
      wordRef.current!.setAttribute("transform", "translate(" + r2(-18 * (1 - w)) + " 0)");
      wordRef.current!.style.opacity = String(r2(Math.min(1, w * 1.6)));
    }
  }, [reduced, dur, loop, withWord]);

  function finish() {
    if (gooRef.current) gooRef.current.style.opacity = "0";
    if (exactRef.current) exactRef.current.style.opacity = "1";
    if (withWord && clipRef.current) { clipRef.current.setAttribute("width", String(wb[2] + 2)); wordRef.current!.setAttribute("transform", ""); wordRef.current!.style.opacity = "1"; }
  }

  const markGroup = [
    <g key="goo" ref={gooRef} filter={"url(#" + fid + ")"} fill={fill} style={{ opacity: 0 }}>
      <path ref={aRef} />
    </g>,
    <path key="x" ref={exactRef} d={g.mark.d} fill={fill} style={{ opacity: 0 }} />,
  ];
  const a11y = props.decorative ? { "aria-hidden": true } : { role: "img", "aria-label": props.title || "WalkieTalkey" };
  return (
    <svg ref={svg} className={cx("wt-logo", "wt-intro", props.className)} viewBox={box.join(" ")} width={width} height={height} style={Object.assign({ overflow: "visible" }, props.style)} {...a11y}>
      <defs>
        {tone === "gradient" ? <GradientDefs id={gid} palette={props.palette} box={box} animate={!reduced} /> : null}
        <GooFilter id={fid} box={[-100, -40, g.mark.w + 200, 180]} blurRef={blurRef} cmRef={cmRef} />
        {withWord ? <clipPath id={cid}><rect ref={clipRef} x={wb[0] - 1} y={wb[1] - 20} width={0} height={wb[3] + 40} /></clipPath> : null}
      </defs>
      {withWord ? <g transform={g.lockup.markT}>{markGroup}</g> : markGroup}
      {withWord ? (
        <g transform={g.lockup.wordT}>
          <g clipPath={"url(#" + cid + ")"}><path ref={wordRef} d={g.word.d} fill={fill} style={{ opacity: 0 }} /></g>
        </g>
      ) : null}
    </svg>
  );
}
