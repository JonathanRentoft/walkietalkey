/* The living surfaces in CSS (and a little JavaScript): LiquidBackground, GlassStrips, DottedGlow, GradientBars,
   GradientFrame, GradientRows, BarField, GradientBackground, GradientMotion. */
import { useEffect, useRef, type CSSProperties, type ElementType, type ReactNode } from "react";
import { useAutoBlur, useFrames, useReducedMotion, useSpotlight } from "../lib/hooks";
import { GBG, GM, pal, type Palette } from "../lib/palettes";
import { cx, isDark, r2, rand, type Style } from "../lib/util";

type Tag = keyof JSX.IntrinsicElements;

function Blobs(p: { palette?: string }) {
  const kids: ReactNode[] = pal(p.palette).blobs.map((c, i) => (
    <span key={i} className={"wt-blob wt-blob-" + (i + 1)} style={{ "--c": "var(--" + c + ")", "--cd": "var(--" + c + "-dyb)" } as Style} />
  ));
  /* the sheen: a soft band of light that drifts across, like light on brushed metal */
  kids.push(<span key="band" className="wt-band" />);
  return <div className="wt-blobs" aria-hidden>{kids}</div>;
}

export function Grain() {
  return <span className="wt-grain" aria-hidden />;
}

/* ------------------------------------------------------- LiquidBackground */

export interface LiquidBackgroundProps {
  palette?: Palette;
  /** Multiplies the drift speed. Default 1 (a 28 s cycle). */
  speed?: number;
  /** Blob blur in px. Default: scales with the surface, 20 to 72. */
  blur?: number;
  /** The film grain layer. Default true. */
  grain?: boolean;
  /** Element to render. Default 'div'. */
  as?: Tag;
  className?: string;
  style?: CSSProperties;
  /** Content laid over the surface. Text in on-gradient / on-gradient-muted. */
  children?: ReactNode;
}

export function LiquidBackground(props: LiquidBackgroundProps) {
  const ref = useAutoBlur<HTMLElement>(props.blur);
  const El = (props.as || "div") as ElementType;
  return (
    <El ref={ref} className={cx("wt-liquid", props.className)}
      style={Object.assign({ "--wt-speed": props.speed || 1 }, props.blur != null ? { "--wt-blur": props.blur + "px" } : null, props.style)}>
      <Blobs palette={props.palette} />
      {props.grain === false ? null : <Grain />}
      <div className="wt-content">{props.children}</div>
    </El>
  );
}

export interface GlassStripsProps extends LiquidBackgroundProps {
  /** Number of fluted glass strips. Default 12. */
  strips?: number;
}

export function GlassStrips(props: GlassStripsProps) {
  const ref = useAutoBlur<HTMLElement>(props.blur);
  const n = props.strips || 12, strips: ReactNode[] = [];
  for (let i = 0; i < n; i++) strips.push(<span key={i} />);
  const El = (props.as || "div") as ElementType;
  return (
    <El ref={ref} className={cx("wt-liquid wt-strips", props.className)}
      style={Object.assign({ "--wt-speed": (props.speed || 1) * 1.8 }, props.blur != null ? { "--wt-blur": props.blur + "px" } : null, props.style)}>
      <Blobs palette={props.palette} />
      <div className="wt-strips-glass" aria-hidden>{strips}</div>
      {props.grain === false ? null : <Grain />}
      <div className="wt-content">{props.children}</div>
    </El>
  );
}

/* ------------------------------------------------------------ DottedGlow */

export interface DottedGlowProps {
  palette?: Palette;
  /** Grid pitch in px. Default 14. */
  gap?: number;
  /** Dot radius in px. Default 1.5. */
  radius?: number;
  speedMin?: number;
  speedMax?: number;
  /** 'radial' fades the grid out toward the edges (default); 'none' fills the box. */
  mask?: "radial" | "none";
  className?: string;
  style?: CSSProperties;
  children?: ReactNode;
}

export function DottedGlow(props: DottedGlowProps) {
  const wrap = useRef<HTMLDivElement>(null), cv = useRef<HTMLCanvasElement>(null);
  const reduced = useReducedMotion();
  const gap = props.gap || 14, radius = props.radius || 1.5;
  const smin = props.speedMin || 0.25, smax = props.speedMax || 1.1;
  const palette = props.palette || "morgengry";
  useEffect(() => {
    const el = wrap.current, c = cv.current;
    if (!el || !c) return undefined;
    const ctx = c.getContext("2d");
    if (!ctx) return undefined;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    let W = 0, H = 0, dots: { x: number; y: number; p: number; s: number; g: number }[] = [], raf = 0, running = false, visible = true;
    let colors: { dot: string; glow: string[]; base: number } = { dot: "#1b1a19", glow: [], base: 0.13 };
    const hues = pal(palette).stops;
    function readColors() {
      const cs = getComputedStyle(el!), dark = isDark(el);
      colors = {
        dot: cs.getPropertyValue("--ink").trim() || "#1b1a19",
        glow: hues.map((n) => cs.getPropertyValue(dark ? "--" + n : "--" + n + "-dyb").trim() || "#e0859f"),
        base: dark ? 0.16 : 0.13,
      };
    }
    function layout() {
      const r = el!.getBoundingClientRect();
      W = r.width; H = r.height;
      c!.width = Math.max(1, Math.round(W * dpr)); c!.height = Math.max(1, Math.round(H * dpr));
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
      dots = [];
      const rows = Math.ceil(H / gap) + 1, cols = Math.ceil(W / gap) + 1;
      for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
          dots.push({ x: x * gap + (y % 2 ? gap / 2 : 0), y: y * gap, p: Math.random() * 2, s: smin + Math.random() * (smax - smin), g: (Math.random() * hues.length) | 0 });
        }
      }
    }
    function draw(t: number) {
      const g = ctx!;
      g.clearRect(0, 0, W, H);
      const time = t / 1000;
      for (let i = 0; i < dots.length; i++) {
        const d = dots[i];
        const ph = (d.p + time * d.s * 0.5) % 2;
        const tri = ph < 1 ? ph : 2 - ph;
        const k = Math.pow(tri, 6);
        if (k > 0.62) {
          g.globalAlpha = Math.min(1, 0.2 + k * 0.8);
          g.shadowBlur = 12 * k;
          g.shadowColor = colors.glow[d.g];
          g.fillStyle = colors.glow[d.g];
          g.beginPath(); g.arc(d.x, d.y, radius * (1 + 0.35 * k), 0, 6.2832); g.fill();
        } else {
          g.globalAlpha = colors.base + 0.3 * k;
          g.shadowBlur = 0;
          g.fillStyle = colors.dot;
          g.beginPath(); g.arc(d.x, d.y, radius, 0, 6.2832); g.fill();
        }
      }
      g.globalAlpha = 1; g.shadowBlur = 0;
    }
    function loop(t: number) { draw(t); raf = requestAnimationFrame(loop); }
    function start() { if (running || reduced || !visible) return; running = true; raf = requestAnimationFrame(loop); }
    function stop() { running = false; cancelAnimationFrame(raf); }
    readColors(); layout(); draw(reduced ? 1700 : performance.now()); start();
    const ro = new ResizeObserver(() => { layout(); draw(reduced ? 1700 : performance.now()); });
    ro.observe(el);
    const io = new IntersectionObserver((es) => { visible = es[0].isIntersecting; if (visible) start(); else stop(); });
    io.observe(el);
    const mo = new MutationObserver(() => { readColors(); draw(reduced ? 1700 : performance.now()); });
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "class"] });
    return () => { stop(); ro.disconnect(); io.disconnect(); mo.disconnect(); };
  }, [gap, radius, smin, smax, palette, reduced]);
  return (
    <div ref={wrap} className={cx("wt-dots", props.mask === "none" ? null : "wt-dots--masked", props.className)} style={props.style}>
      <canvas ref={cv} className="wt-dots-canvas" aria-hidden />
      {props.children ? <div className="wt-content">{props.children}</div> : null}
    </div>
  );
}

/* ---------------------------------------------------------- GradientBars */

export interface GradientBarsProps {
  /** 'glow' is a surface with bars rising from the bottom; 'meter' is an inline voice meter. */
  variant?: "glow" | "meter";
  palette?: Palette;
  /** Number of bars. Defaults: glow 28, meter 9. */
  bars?: number;
  /** Meter height in px. Default 24. */
  height?: number;
  /** false stops the bars flat (a muted meter). Default true. */
  active?: boolean;
  speed?: number;
  grain?: boolean;
  className?: string;
  style?: CSSProperties;
  /** glow only: content over the surface, kept in the top third. */
  children?: ReactNode;
}

export function GradientBars(props: GradientBarsProps) {
  const variant = props.variant || "glow";
  const n = props.bars || (variant === "meter" ? 9 : 28);
  const stops = pal(props.palette).stops;
  const bars: ReactNode[] = [];
  for (let i = 0; i < n; i++) {
    const r1 = rand(i + 1), r2v = rand(i + 41);
    let style: Style;
    if (variant === "meter") {
      const col = stops[i % stops.length];
      style = { "--c": "var(--" + col + ")", "--cd": "var(--" + col + "-dyb)" };
    } else {
      /* glow: the colour runs smoothly across the row, mixed between neighbouring stops */
      const pos = (n === 1 ? 0 : i / (n - 1)) * (stops.length - 1);
      const a = Math.min(stops.length - 2, Math.floor(pos)), b = a + 1, mix = Math.round((1 - (pos - a)) * 100);
      style = {
        "--c": "color-mix(in oklab, var(--" + stops[a] + ") " + mix + "%, var(--" + stops[b] + "))",
        "--cd": "color-mix(in oklab, var(--" + stops[a] + "-dyb) " + mix + "%, var(--" + stops[b] + "-dyb))",
      };
    }
    if (variant === "meter") {
      style["--d"] = (0.42 + r1 * 0.5).toFixed(2) + "s";
      style["--delay"] = (-r2v * 1.2).toFixed(2) + "s";
      style["--lo"] = (0.16 + r2v * 0.18).toFixed(2);
      style["--hi"] = (0.62 + r1 * 0.38).toFixed(2);
    } else {
      const wave = 0.5 + 0.5 * Math.sin(i / n * Math.PI);
      style["--delay"] = (-(i / n) * 3.6).toFixed(2) + "s";
      style["--lo"] = (0.22 + 0.18 * wave).toFixed(2);
      style["--hi"] = (0.55 + 0.45 * wave * (0.7 + 0.3 * r1)).toFixed(2);
    }
    bars.push(<span key={i} className="wt-bar" style={style} />);
  }
  const cls = cx("wt-bars", "wt-bars--" + variant, props.active === false && "wt-bars--off", props.className);
  const st = Object.assign({ "--wt-speed": props.speed || 1 } as Style, props.height ? { "--wt-h": props.height + "px" } : null, props.style);
  if (variant === "meter") return <span className={cls} style={st} aria-hidden>{bars}</span>;
  return (
    <div className={cls} style={st}>
      <div className="wt-bars-row" aria-hidden>{bars}</div>
      {props.grain === false ? null : <Grain />}
      {props.children ? <div className="wt-content">{props.children}</div> : null}
    </div>
  );
}

/* --------------------------------------------------------- GradientFrame */

export interface GradientFrameProps {
  palette?: Palette;
  /** 'pill' (default) around buttons; 'lg' around cards. */
  radius?: "pill" | "lg";
  /** Frame thickness in px. Default 6. */
  padding?: number;
  speed?: number;
  className?: string;
  style?: CSSProperties;
  /** One button or one card. */
  children?: ReactNode;
}

export function GradientFrame(props: GradientFrameProps) {
  const ref = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotion();
  const speed = props.speed || 1;
  useEffect(() => {
    const el = ref.current;
    if (!el || reduced) return undefined;
    const pts = [0, 1, 2].map((i) => ({ x: 20 + 60 * rand(i + 7), y: 20 + 60 * rand(i + 13), vx: 0, vy: 0, tx: 0, ty: 0, next: 0 }));
    let raf = 0, last = performance.now();
    function step(now: number) {
      const dt = Math.min(64, now - last) / 16.67; last = now;
      for (let i = 0; i < pts.length; i++) {
        const p = pts[i];
        if (now > p.next) {
          const a = Math.random() * Math.PI * 2, sp = (0.10 + Math.random() * 0.14) * speed;
          p.tx = Math.cos(a) * sp; p.ty = Math.sin(a) * sp; p.next = now + 1500 + Math.random() * 1500;
        }
        p.vx += (p.tx - p.vx) * 0.04 * dt; p.vy += (p.ty - p.vy) * 0.04 * dt;
        p.x += p.vx * dt; p.y += p.vy * dt;
        if (p.x < 4 || p.x > 96) { p.tx = -p.tx; p.vx = -p.vx; p.x = Math.max(4, Math.min(96, p.x)); }
        if (p.y < 4 || p.y > 96) { p.ty = -p.ty; p.vy = -p.vy; p.y = Math.max(4, Math.min(96, p.y)); }
        el!.style.setProperty("--wt-x" + i, p.x.toFixed(2) + "%");
        el!.style.setProperty("--wt-y" + i, p.y.toFixed(2) + "%");
      }
      raf = requestAnimationFrame(step);
    }
    raf = requestAnimationFrame(step);
    return () => { cancelAnimationFrame(raf); };
  }, [reduced, speed]);
  const s = pal(props.palette).stops;
  const st: Style = {
    "--wt-pad": (props.padding == null ? 6 : props.padding) + "px",
    "--c0": "var(--" + s[1 % s.length] + "-dyb)", "--c1": "var(--" + s[2 % s.length] + "-dyb)", "--c2": "var(--" + s[(s.length - 1)] + "-dyb)",
  };
  return (
    <div ref={ref} className={cx("wt-frame", "wt-frame--" + (props.radius || "pill"), props.className)} style={Object.assign(st, props.style)}>
      <Grain />
      <span className="wt-frame-sheen" aria-hidden />
      <div className="wt-frame-inner">{props.children}</div>
    </div>
  );
}

/* --------------------------------------------------------- GradientRows */

export interface GradientRowsProps {
  palette?: Palette;
  /** Angle of the rows in degrees. Default -14. */
  angle?: number;
  /** Number of rows. Default 16. */
  rows?: number;
  /** Row thickness in px. Default 18. */
  thickness?: number;
  /** Visibility of the rows outside the spotlight (0 to 1). Default 0.5. */
  ambient?: number;
  /** Spotlight radius in px. Default 260. */
  spotlight?: number;
  /** Fades the rows out where text sits: 'left', 'bottom' or 'center'. Default 'none'. */
  fade?: "none" | "left" | "bottom" | "center";
  grain?: boolean;
  className?: string;
  style?: CSSProperties;
  children?: ReactNode;
}

export function GradientRows(props: GradientRowsProps) {
  const ref = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotion();
  useSpotlight(ref, reduced);
  const n = props.rows || 16;
  function set(lit: boolean) {
    const rows: ReactNode[] = [];
    for (let i = 0; i < n; i++) {
      rows.push(<span key={i} style={{ "--d": (7 + rand(i + 3) * 7).toFixed(2) + "s", "--o": (-rand(i + 11) * 9).toFixed(2) + "s" } as Style} />);
    }
    return <div className={cx("wt-rows-set", lit && "wt-rows-set--lit")}>{rows}</div>;
  }
  const s = pal(props.palette).stops;
  return (
    <div ref={ref} className={cx("wt-rows", props.className)}
      style={Object.assign({
        "--wt-rot": (props.angle == null ? -14 : props.angle) + "deg", "--wt-thick": (props.thickness == null ? 18 : props.thickness) + "px",
        "--wt-ambient": props.ambient == null ? 0.5 : props.ambient, "--wt-spot": (props.spotlight || 260) + "px",
        "--r1": "var(--" + s[0] + ")", "--r2": "var(--" + s[1] + ")", "--r3": "var(--" + s[s.length - 1] + ")",
        "--rd1": "var(--" + s[1] + "-dyb)", "--rd2": "var(--" + s[s.length - 1] + "-dyb)",
      }, props.style)}>
      <div className={cx("wt-rows-fade", props.fade && props.fade !== "none" && "wt-rows-fade--" + props.fade)} aria-hidden>
        <div className="wt-rows-layer">{set(false)}</div>
        <div className="wt-rows-layer wt-rows-layer--lit">{set(true)}</div>
      </div>
      {props.grain === false ? null : <Grain />}
      {props.children ? <div className="wt-content">{props.children}</div> : null}
    </div>
  );
}

/* ------------------------------------------------------------- BarField */

export interface BarFieldProps {
  palette?: Palette;
  /** 'wave' (default), 'pulse', 'float' or 'none'. */
  mode?: "wave" | "pulse" | "float" | "none";
  /** 'x' vertical bars (default) or 'y' horizontal bars. */
  direction?: "x" | "y";
  /** 1 to 80. Default 36. */
  bars?: number;
  /** 'arch' (default), 'even' or 'random'. */
  heights?: "arch" | "even" | "random";
  /** Token names for the bottom and top colour. Default: the palette's deepest and lightest. */
  from?: string;
  to?: string;
  /** Gap between bars in px. Default 6. */
  gap?: number;
  /** One cycle in ms. Default 2400. */
  duration?: number;
  /** Strength of the motion (0 to 1). Default 0.5. */
  intensity?: number;
  /** Delay between bars in s. Default 0.08. */
  stagger?: number;
  grain?: boolean;
  className?: string;
  style?: CSSProperties;
  children?: ReactNode;
}

export function BarField(props: BarFieldProps) {
  const n = Math.max(1, Math.min(80, props.bars || 36));
  const dir = props.direction === "y" ? "y" : "x", mode = props.mode || "wave";
  const s = pal(props.palette).stops;
  const from = props.from || s[s.length - 1], to = props.to || s[0];
  const shape = props.heights || "arch", stagger = props.stagger == null ? 0.08 : props.stagger;
  const bars: ReactNode[] = [];
  for (let i = 0; i < n; i++) {
    const f = n === 1 ? 0.5 : i / (n - 1);
    const hgt = shape === "even" ? 0.8 : shape === "random" ? 0.35 + 0.6 * rand(i + 5) : 0.42 + 0.5 * Math.sin(f * Math.PI) * (0.82 + 0.18 * rand(i + 2));
    bars.push(<span key={i} className="wt-bf" style={{ "--h": (hgt * 100).toFixed(1) + "%", "--delay": (-(i * stagger)).toFixed(2) + "s" } as Style} />);
  }
  return (
    <div className={cx("wt-barfield", "wt-barfield--" + dir, "wt-barfield--" + mode, props.className)}
      style={Object.assign({
        "--wt-from": "var(--" + from + ")", "--wt-to": "var(--" + to + ")",
        "--wt-dur": (props.duration || 2400) + "ms", "--wt-int": props.intensity == null ? 0.5 : props.intensity,
        "--wt-bf-gap": (props.gap == null ? 6 : props.gap) + "px",
      }, props.style)}>
      <div className="wt-barfield-row" aria-hidden>{bars}</div>
      {props.grain === false ? null : <Grain />}
      {props.children ? <div className="wt-content">{props.children}</div> : null}
    </div>
  );
}

/* ================================================= GradientBackground */

export interface GradientBackgroundProps {
  palette?: "morgengry" | "flint" | "rav" | "nat" | "skumring";
  speed?: number;
  /** Band width. Default 1. */
  scale?: number;
  /** Band angle in degrees. Default 115. */
  angle?: number;
  /** Move the pools of light, in %. */
  offsetX?: number;
  offsetY?: number;
  /** Grain, 0 to 1. Default 1. */
  noise?: number;
  as?: Tag;
  className?: string;
  style?: CSSProperties;
  children?: ReactNode;
}

/** Slow silk: wide bands of the palette that pan and turn, with two pools of light and grain.
    Pure CSS, so it costs almost nothing and stops by itself with reduced motion. */
export function GradientBackground(props: GradientBackgroundProps & { preset?: string }) {
  const name = props.palette || props.preset || "morgengry";
  const c = GBG[name] || GBG.morgengry;
  const dark = name === "nat" || name === "skumring";
  const st: Style = {
    "--g0": "var(--" + c[0] + ")", "--g1": "var(--" + c[1] + ")", "--g2": "var(--" + c[2] + ")", "--g3": "var(--" + c[3] + ")",
    "--wt-gbg-dur": (34 / (props.speed || 1)) + "s", "--wt-gbg-scale": props.scale == null ? 1 : props.scale,
    "--wt-gbg-ox": (props.offsetX || 0) + "%", "--wt-gbg-oy": (props.offsetY || 0) + "%", "--wt-gbg-angle": (props.angle == null ? 115 : props.angle) + "deg",
    "--wt-gbg-noise": props.noise == null ? 1 : props.noise,
  };
  const El = (props.as || "div") as ElementType;
  return (
    <El className={cx("wt-gbg", dark && "wt-gbg--dark", props.className)} style={Object.assign(st, props.style)}>
      <div className="wt-gbg-layer" aria-hidden />
      <div className="wt-gbg-pool" aria-hidden />
      {props.noise === 0 ? null : <Grain />}
      {props.children ? <div className="wt-content">{props.children}</div> : null}
    </El>
  );
}

/* ===================================================== GradientMotion */

export interface GradientMotionProps {
  palette?: "nat" | "morgengry" | "rav" | "flint" | "skumring";
  shape?: "blob" | "glow" | "wave" | "mesh" | "streak";
  motion?: "drift" | "pulse" | "orbit" | "flow" | "rotate";
  /** 1 to 8. Default 4. */
  count?: number;
  /** px. Default 90. */
  blur?: number;
  /** px of movement. Default 60. */
  range?: number;
  speed?: number;
  opacity?: number;
  seed?: number;
  grain?: boolean;
  as?: Tag;
  className?: string;
  style?: CSSProperties;
  children?: ReactNode;
}

const GM_SHAPES: Record<string, string> = {
  blob: "50% 45% 55% 50% / 50% 55% 45% 50%",
  glow: "50%",
  wave: "60% 40% 30% 70% / 60% 30% 70% 40%",
  mesh: "40%",
  streak: "10% 90% 10% 90% / 90% 10% 90% 10%",
};
function mulberry(a: number) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

/** Glowing shapes on night, blended with screen: blobs, glows, waves or streaks that drift, pulse, orbit, flow or turn.
    The layout comes from a seed, so the same seed always looks the same. */
export function GradientMotion(props: GradientMotionProps) {
  const ref = useRef<HTMLElement>(null), els = useRef<(HTMLSpanElement | null)[]>([]);
  const reduced = useReducedMotion();
  const n = Math.max(1, Math.min(8, props.count || 4));
  const shape = props.shape && GM_SHAPES[props.shape] ? props.shape : "blob";
  const motion = props.motion || "drift";
  const seed = props.seed == null ? 7 : props.seed;
  const colors = (props.palette && GM[props.palette]) || GM.nat;
  const range = props.range == null ? 60 : props.range;
  const rnd = mulberry(seed);
  const blobs: { x: number; y: number; size: number; dir: number; phase: number; rot: number; c: string }[] = [];
  for (let i = 0; i < n; i++) {
    const size = 55 + rnd() * 30;
    blobs.push({
      x: (i + 0.5) / n * 100 + (rnd() - 0.5) * 30, y: 30 + rnd() * 40, size,
      dir: rnd() * Math.PI * 2, phase: rnd(), rot: rnd() * 360, c: colors[i % colors.length],
    });
  }
  const speed = (props.speed == null ? 1 : props.speed) / 15;
  useFrames(ref, reduced, (t) => {
    const tick = t < 0 ? 0 : t * speed;
    for (let k = 0; k < blobs.length; k++) {
      const b = blobs[k], el = els.current[k];
      if (!el) continue;
      const lt = ((tick + b.phase * 6) % 6) / 6, e = (Math.sin((lt - 0.25) * 6.2832) + 1) / 2, sw = Math.sin(e * 6.2832);
      let tx = 0, ty = 0, rot = 0, sc = 1;
      if (motion === "pulse") sc = 1 + range / 100 * (0.5 + 0.5 * sw) * 0.5;
      else if (motion === "rotate") rot = e * 360;
      else if (motion === "flow") { tx = Math.sin(e * 6.2832 + k) * range; ty = Math.cos(e * 12.566 + k) * range / 2; }
      else if (motion === "orbit") { tx = Math.cos(e * 6.2832 + k) * range; ty = Math.sin(e * 6.2832 + k) * range; }
      else { tx = Math.cos(b.dir) * range * sw; ty = Math.sin(b.dir) * range * sw; }
      el.style.transform = "translate(-50%, -50%) translate(" + r2(tx) + "px, " + r2(ty) + "px) rotate(" + r2(b.rot + rot) + "deg) scale(" + r2(sc) + ")";
    }
  }, [reduced, n, shape, motion, seed, range, speed, props.palette]);
  const blur = props.blur == null ? 90 : props.blur;
  const El = (props.as || "div") as ElementType;
  return (
    <El ref={ref} className={cx("wt-gm", props.className)} style={Object.assign({ "--wt-gm-blur": blur + "px", "--wt-gm-opacity": props.opacity == null ? 0.85 : props.opacity }, props.style)}>
      <div className="wt-gm-layer" aria-hidden>
        {blobs.map((b, k) => {
          const st = shape === "streak" ? { width: b.size * 2.2 + "%", height: b.size * 0.6 + "%" } : { width: b.size + "%", height: b.size + "%" };
          return (
            <span key={k} ref={(el) => { els.current[k] = el; }} className="wt-gm-blob"
              style={Object.assign({
                left: b.x + "%", top: b.y + "%", borderRadius: GM_SHAPES[shape],
                background: shape === "glow" ? "radial-gradient(circle, var(--" + b.c + ") 0%, transparent 70%)" : "var(--" + b.c + ")",
                transform: "translate(-50%, -50%) rotate(" + b.rot + "deg)",
              }, st)} />
          );
        })}
      </div>
      {props.grain === false ? null : <Grain />}
      {props.children ? <div className="wt-content">{props.children}</div> : null}
    </El>
  );
}
