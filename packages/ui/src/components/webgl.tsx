/* The WebGL surfaces: FluidMesh, LightWaves and FluidImage. At most one per page (design system rule, SITE-06). */
import { useEffect, useRef, useState, type CSSProperties, type ElementType, type ReactNode } from "react";
import { fallbackBg, mountGL, tokenLin, type GLHandle } from "../lib/gl";
import { useReducedMotion } from "../lib/hooks";
import { MESH, WAVES } from "../lib/palettes";
import { cx, isDark } from "../lib/util";

type Tag = keyof JSX.IntrinsicElements;

/* ------------------------------------------------------------ FluidMesh */

const FRAG_MESH = [
  "uniform vec3 uVoid, uC1, uC2, uC3, uC4; uniform float uScale, uDist, uBloom, uScrim, uScrimMode, uBias;",
  "vec3 ramp(float s){ vec3 c = mix(uVoid, uC1, smoothstep(0.0, 0.35, s)); c = mix(c, uC2, smoothstep(0.25, 0.6, s));",
  "  c = mix(c, uC3, smoothstep(0.5, 0.85, s)); return mix(c, uC4, smoothstep(0.75, 1.0, s)); }",
  "void main(){",
  "  vec2 uv = gl_FragCoord.xy / uRes; float asp = uRes.x / uRes.y; float t = uTime;",
  "  vec2 p = vec2(uv.x * asp, uv.y), m = vec2(uMouse.x * asp, uMouse.y);",
  "  vec2 d = p - m; float infl = exp(-dot(d, d) * 3.0) * uMouseAmt * uDist;",
  "  float a = infl * 1.5; p = m + mat2(cos(a), -sin(a), sin(a), cos(a)) * d - d * infl * 0.25;",
  "  vec2 q = p * uScale * 0.85;",
  "  vec2 w = vec2(fbm3(q + vec2(0.0, t * 0.03)), fbm3(q + vec2(5.2, 1.3) - t * 0.026));",
  "  float n = fbm3(q * 0.7 + 1.4 * w + vec2(t * 0.018, -t * 0.012));",
  "  float x = dot(vec2(p.x / asp, p.y) - 0.5, normalize(vec2(1.0, 0.6)));",
  "  x += (n - 0.5) * 0.85 * uDist + (w.x - 0.5) * 0.35;",
  "  float c = 0.16 * sin(t * 0.045) - 0.04;",
  "  float b = exp(-pow((x - c) / 0.21, 2.0));",
  "  b += 0.7 * exp(-pow((x - c - 0.52) / 0.13, 2.0));",
  "  b += 0.5 * exp(-pow((x - c + 0.55) / 0.15, 2.0));",
  "  float s = clamp(b, 0.0, 1.0); s = mix(s, s * s, uBias);",
  "  vec3 col = ramp(s);",
  "  float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));",
  "  col += uBloom * smoothstep(0.3, 0.9, lum) * 0.18 * col;",
  "  float k = 0.0;",
  "  if (uScrimMode > 0.5 && uScrimMode < 1.5) k = 1.0 - smoothstep(0.42, 0.78, uv.x);",
  "  else if (uScrimMode > 1.5 && uScrimMode < 2.5) k = 1.0 - smoothstep(0.1, 0.62, length((uv - vec2(0.5, 0.5)) * vec2(asp * 0.5, 1.0)));",
  "  else if (uScrimMode > 2.5) k = smoothstep(0.7, 0.0, uv.y);",
  "  if (uScrimMode > 0.5) k = max(k, smoothstep(0.76, 0.9, uv.y));",
  "  col = mix(col, uVoid, k * uScrim);",
  "  gl_FragColor = vec4(finish(col), 1.0);",
  "}",
].join("\n");

const SCRIM: Record<string, number> = { none: 0, left: 1, center: 2, bottom: 3 };

export interface FluidMeshProps {
  /** 'auto' (default) picks 'nat' in dark sections and 'morgengry' otherwise. 'skumring' is for dark sections only. */
  palette?: "auto" | "morgengry" | "flint" | "rav" | "nat" | "skumring";
  /** Calms the mesh behind text: 'left', 'center' or 'bottom'. Also calms the top, behind a menu. Default 'none'. */
  scrim?: "none" | "left" | "center" | "bottom";
  /** How strongly the scrim calms (0 to 1). Default 0.8. */
  scrimAmount?: number;
  /** Size of the bands. Default 1.1. */
  scale?: number;
  /** How much the bands bend, and how much the pointer bends them (0 to 2). Default 1. */
  distortion?: number;
  /** Film grain (0 to 0.15). Default 0.045. */
  grain?: number;
  /** Extra light in the bright bands (0 to 1). Default 0.6. */
  bloom?: number;
  /** How softly the bands follow the pointer (0.02 slow to 0.2 fast). Default 0.06. */
  lag?: number;
  speed?: number;
  /** Follow the pointer. Default true. */
  interactive?: boolean;
  as?: Tag;
  className?: string;
  style?: CSSProperties;
  children?: ReactNode;
}

export function FluidMesh(props: FluidMeshProps) {
  const wrap = useRef<HTMLElement>(null), cv = useRef<HTMLCanvasElement>(null);
  const reduced = useReducedMotion();
  const palette = props.palette || "auto", scrim = props.scrim || "none";
  const deps = [palette, scrim, reduced, props.scale, props.distortion, props.grain, props.bloom, props.lag, props.speed, props.scrimAmount, props.interactive];
  useEffect(() => {
    const el = wrap.current, c = cv.current;
    if (!el || !c) return undefined;
    function names() { const p = palette === "auto" ? (isDark(el) ? "nat" : "morgengry") : palette; return MESH[p] || MESH.morgengry; }
    const g = mountGL(el, c, FRAG_MESH, {
      still: reduced, lag: props.lag, speed: props.speed, interactive: props.interactive, t0: 7,
      grain: props.grain == null ? 0.045 : props.grain,
      setup: (gl, loc) => {
        const n = names(), keys = ["uVoid", "uC1", "uC2", "uC3", "uC4"];
        for (let i = 0; i < 5; i++) { const v = tokenLin(el, n[i]); gl.uniform3f(loc(keys[i]), v[0], v[1], v[2]); }
        gl.uniform1f(loc("uScale"), props.scale == null ? 1.1 : props.scale);
        gl.uniform1f(loc("uDist"), props.distortion == null ? 1 : props.distortion);
        gl.uniform1f(loc("uBloom"), props.bloom == null ? 0.6 : props.bloom);
        gl.uniform1f(loc("uScrimMode"), SCRIM[scrim] || 0);
        gl.uniform1f(loc("uScrim"), props.scrimAmount == null ? 0.8 : props.scrimAmount);
        const p = palette === "auto" ? (isDark(el) ? "nat" : "morgengry") : palette;
        gl.uniform1f(loc("uBias"), p === "nat" ? 0.35 : p === "skumring" ? 0.2 : 0.0);
      },
    });
    if (!g) { fallbackBg(el, names()); return undefined; }
    return g.cleanup;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  const El = (props.as || "div") as ElementType;
  return (
    <El ref={wrap} className={cx("wt-gl", props.className)} style={props.style}>
      <canvas ref={cv} className="wt-gl-canvas" aria-hidden />
      {props.children ? <div className="wt-content">{props.children}</div> : null}
    </El>
  );
}

/* ----------------------------------------------------------- LightWaves */

const FRAG_WAVES = [
  "uniform vec3 uVoid, uTop, uMid, uBot; uniform float uDensity, uIntensity, uSens, uLift;",
  "void main(){",
  "  vec2 uv = gl_FragCoord.xy / uRes; float t = uTime;",
  "  float mx = (uMouse.x - 0.5) * uMouseAmt * uSens, my = (uMouse.y - 0.5) * uMouseAmt * uSens;",
  "  vec3 col = uVoid;",
  "  for (int i = 0; i < 3; i++) {",
  "    float fi = float(i);",
  "    float freq = uDensity * (0.7 + fi * 0.45);",
  "    float ph = t * (0.12 + fi * 0.04) + fi * 2.1 + mx * 2.2;",
  "    float base = 0.20 + fi * 0.11 + my * 0.12 + uLift;",
  "    float wave = 0.06 * sin(uv.x * freq * 6.2831 + ph) + 0.025 * sin(uv.x * freq * 14.0 - ph * 1.3)",
  "      + 0.06 * (fbm3(vec2(uv.x * 1.8 + fi * 9.0, t * 0.06)) - 0.5) + mx * 0.05 * (uv.x - 0.5);",
  "    float d = uv.y - (base + wave);",
  "    float core = exp(-pow(d / (0.018 + fi * 0.006), 2.0));",
  "    float tail = smoothstep(-0.01, 0.03, d) * exp(-max(d, 0.0) * (9.0 + fi * 2.0));",
  "    float rays = 0.6 + 0.4 * fbm3(vec2(uv.x * 46.0 + fi * 13.0 + mx * 3.0, t * 0.1 + fi));",
  "    vec3 c = fi < 0.5 ? uBot : (fi < 1.5 ? uMid : uTop);",
  "    col += c * (core * 0.9 + tail * 0.6 * rays) * uIntensity * (0.75 - fi * 0.15);",
  "  }",
  "  float glow = exp(-pow((uv.y - 0.26 - my * 0.1 - uLift) * 4.0, 2.0)) * 0.08 * uIntensity;",
  "  col += uMid * glow;",
  "  gl_FragColor = vec4(finish(col), 1.0);",
  "}",
].join("\n");

export interface LightWavesProps {
  palette?: "morgengry" | "flint" | "rav" | "skumring";
  /** Number of waves. Default 1. */
  density?: number;
  /** Brightness. Default 1. */
  intensity?: number;
  /** How much the pointer moves the waves. Default 1. */
  sensitivity?: number;
  /** Moves the waves up (positive) or down (negative), in fractions of the height. Default 0. */
  lift?: number;
  grain?: number;
  speed?: number;
  interactive?: boolean;
  as?: Tag;
  className?: string;
  style?: CSSProperties;
  children?: ReactNode;
}

export function LightWaves(props: LightWavesProps) {
  const wrap = useRef<HTMLElement>(null), cv = useRef<HTMLCanvasElement>(null);
  const reduced = useReducedMotion();
  const palette = props.palette || "morgengry";
  useEffect(() => {
    const el = wrap.current, c = cv.current;
    if (!el || !c) return undefined;
    const n = WAVES[palette] || WAVES.morgengry;
    const g = mountGL(el, c, FRAG_WAVES, {
      still: reduced, speed: props.speed, lag: 0.05, t0: 3, interactive: props.interactive,
      grain: props.grain == null ? 0.05 : props.grain,
      setup: (gl, loc) => {
        const v = tokenLin(el, n[3] || "night"); gl.uniform3f(loc("uVoid"), v[0], v[1], v[2]);
        const keys = ["uTop", "uMid", "uBot"];
        for (let i = 0; i < 3; i++) { const w = tokenLin(el, n[i]); gl.uniform3f(loc(keys[i]), w[0], w[1], w[2]); }
        gl.uniform1f(loc("uDensity"), props.density == null ? 1 : props.density);
        gl.uniform1f(loc("uIntensity"), props.intensity == null ? 1 : props.intensity);
        gl.uniform1f(loc("uSens"), props.sensitivity == null ? 1 : props.sensitivity);
        gl.uniform1f(loc("uLift"), props.lift == null ? 0 : props.lift);
      },
    });
    if (!g) { fallbackBg(el, ["night", n[2], "night"]); return undefined; }
    return g.cleanup;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [palette, reduced, props.speed, props.grain, props.density, props.intensity, props.sensitivity, props.interactive, props.lift]);
  const El = (props.as || "div") as ElementType;
  return (
    <El ref={wrap} className={cx("wt-gl wt-waves", props.className)} style={props.style}>
      <canvas ref={cv} className="wt-gl-canvas" aria-hidden />
      {props.children ? <div className="wt-content">{props.children}</div> : null}
    </El>
  );
}

/* ------------------------------------------------------------ FluidImage */

const FRAG_IMAGE = [
  "uniform sampler2D uTex; uniform vec2 uTex2; uniform float uStrength, uRadius; uniform vec3 uBg;",
  "void main(){",
  "  vec2 uv = gl_FragCoord.xy / uRes; float ca = uRes.x / uRes.y, ta = uTex2.x / uTex2.y;",
  "  vec2 sc = ca > ta ? vec2(1.0, ta / ca) : vec2(ca / ta, 1.0);",
  "  vec2 d = uv - uMouse; d.x *= ca; float dist = length(d);",
  "  float fall = exp(-(dist * dist) / (uRadius * uRadius));",
  "  vec2 dir = dist > 0.0001 ? d / dist : vec2(0.0);",
  "  float ripple = sin(dist * 30.0 - uTime * 3.2) * 0.014 * uStrength * fall * uMouseAmt;",
  "  vec2 wob = (vec2(fbm(uv * 2.6 + uTime * 0.08), fbm(uv * 2.6 + 4.7 - uTime * 0.07)) - 0.5) * 0.016 * uStrength * (0.3 + 0.7 * uMouseAmt);",
  "  vec2 off = dir * ripple * vec2(1.0 / ca, 1.0) + wob + dir * fall * uMouseAmt * 0.02 * uStrength * vec2(1.0 / ca, 1.0);",
  "  vec2 tuv = (uv - 0.5 + off) * sc + 0.5;",
  "  vec4 c = texture2D(uTex, vec2(tuv.x, 1.0 - tuv.y));",
  "  vec3 lin = mix(uBg, pow(c.rgb, vec3(2.2)), c.a);",
  "  gl_FragColor = vec4(finish(lin), 1.0);",
  "}",
].join("\n");

export interface FluidImageProps {
  /** Same-origin image, e.g. an upload in this system. */
  src: string;
  alt: string;
  /** How much the image flows. Default 1. */
  strength?: number;
  /** Size of the area the pointer moves (fraction of the height). Default 0.35. */
  radius?: number;
  grain?: number;
  className?: string;
  style?: CSSProperties;
}

export function FluidImage(props: FluidImageProps) {
  const wrap = useRef<HTMLDivElement>(null), cv = useRef<HTMLCanvasElement>(null);
  const reduced = useReducedMotion();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const el = wrap.current, c = cv.current;
    if (!el || !c || !props.src) return undefined;
    let g: GLHandle | null = null, alive = true;
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      if (!alive) return;
      let tex: WebGLTexture | null = null, texFailed = false;
      g = mountGL(el, c, FRAG_IMAGE, {
        still: reduced, lag: 0.08, grain: props.grain == null ? 0.02 : props.grain,
        setup: (gl, loc) => {
          if (!tex) {
            tex = gl.createTexture();
            gl.bindTexture(gl.TEXTURE_2D, tex);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
            try { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img); } catch { texFailed = true; }
          }
          gl.uniform1i(loc("uTex"), 0);
          const bg = tokenLin(el, "surface-300"); gl.uniform3f(loc("uBg"), bg[0], bg[1], bg[2]);
          gl.uniform2f(loc("uTex2"), img.naturalWidth, img.naturalHeight);
          gl.uniform1f(loc("uStrength"), props.strength == null ? 1 : props.strength);
          gl.uniform1f(loc("uRadius"), props.radius == null ? 0.35 : props.radius);
        },
      });
      if (!g || texFailed) { if (g) g.cleanup(); g = null; setFailed(true); }
    };
    img.onerror = () => { if (alive) setFailed(true); };
    img.src = props.src;
    return () => { alive = false; if (g) g.cleanup(); };
  }, [props.src, reduced, props.strength, props.radius, props.grain]);
  return (
    <div ref={wrap} className={cx("wt-gl wt-fluidimg", props.className)} style={props.style} role="img" aria-label={props.alt || ""}>
      {failed ? <img className="wt-fluidimg-fallback" src={props.src} alt="" /> : <canvas ref={cv} className="wt-gl-canvas" aria-hidden />}
    </div>
  );
}
