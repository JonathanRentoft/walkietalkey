/* WebGL helpers for FluidMesh, LightWaves and FluidImage. Used only inside effects. */

/* Shared GLSL: hash, value noise, fbm. */
export const GLSL_COMMON = [
  "precision highp float;",
  "uniform vec2 uRes; uniform float uTime; uniform vec2 uMouse; uniform float uMouseAmt; uniform float uGrain;",
  "float hash(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }",
  "float noise(vec2 p){ vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);",
  "  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y); }",
  "float fbm(vec2 p){ float v = 0.0, a = 0.5; mat2 m = mat2(1.6, 1.2, -1.2, 1.6);",
  "  for (int i = 0; i < 5; i++) { v += a * noise(p); p = m * p; a *= 0.5; } return v; }",
  "float fbm3(vec2 p){ float v = 0.0, a = 0.5; mat2 m = mat2(1.6, 1.2, -1.2, 1.6);",
  "  for (int i = 0; i < 3; i++) { v += a * noise(p); p = m * p; a *= 0.5; } return v / 0.875; }",
  "vec3 finish(vec3 lin){ float g = hash(gl_FragCoord.xy + fract(uTime) * 97.0) - 0.5;",
  "  vec3 c = pow(max(lin, 0.0), vec3(1.0 / 2.2)); return c + g * uGrain; }",
].join("\n");

const VERT = "attribute vec2 aPos; void main(){ gl_Position = vec4(aPos, 0.0, 1.0); }";

export function hexToLin(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})/i.exec((hex || "").trim());
  if (!m) return [0.5, 0.5, 0.5];
  const n = parseInt(m[1], 16), out: number[] = [];
  [(n >> 16) & 255, (n >> 8) & 255, n & 255].forEach((v) => {
    const c = v / 255;
    out.push(c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  });
  return out as [number, number, number];
}

export function tokenLin(el: Element, name: string): [number, number, number] {
  return hexToLin(getComputedStyle(el).getPropertyValue("--" + name));
}

export type Loc = (name: string) => WebGLUniformLocation | null;

export interface GLOptions {
  dpr?: number;
  lag?: number;
  speed?: number;
  grain?: number;
  t0?: number;
  still?: boolean;
  interactive?: boolean;
  setup?: (gl: WebGLRenderingContext, loc: Loc, wrap: HTMLElement) => void;
  frame?: (gl: WebGLRenderingContext, loc: Loc, t: number) => void;
}

export interface GLHandle {
  gl: WebGLRenderingContext;
  loc: Loc;
  redraw: () => void;
  cleanup: () => void;
}

/** Mounts a full-surface fragment shader on a canvas inside `wrap`.
    Handles size, pixel ratio, pointer (with lag), pausing off screen, tab visibility, reduced motion and theme changes.
    setup(gl, loc, wrap) runs once per (re)colour; frame(gl, loc, t) runs every frame. Returns null without WebGL. */
export function mountGL(wrap: HTMLElement, canvas: HTMLCanvasElement, frag: string, opts: GLOptions): GLHandle | null {
  let gl: WebGLRenderingContext | null = null;
  try { gl = canvas.getContext("webgl", { antialias: false, alpha: false, premultipliedAlpha: false, powerPreference: "low-power" }) as WebGLRenderingContext | null; } catch { gl = null; }
  if (!gl) return null;
  const g = gl;
  function compile(type: number, src: string): WebGLShader | null {
    const s = g.createShader(type)!; g.shaderSource(s, src); g.compileShader(s);
    if (!g.getShaderParameter(s, g.COMPILE_STATUS)) { console.warn("WalkieTalkey shader:", g.getShaderInfoLog(s)); return null; }
    return s;
  }
  const vs = compile(g.VERTEX_SHADER, VERT), fs = compile(g.FRAGMENT_SHADER, GLSL_COMMON + "\n" + frag);
  if (!vs || !fs) return null;
  const prog = g.createProgram()!; g.attachShader(prog, vs); g.attachShader(prog, fs); g.linkProgram(prog);
  if (!g.getProgramParameter(prog, g.LINK_STATUS)) return null;
  g.useProgram(prog);
  const buf = g.createBuffer(); g.bindBuffer(g.ARRAY_BUFFER, buf);
  g.bufferData(g.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), g.STATIC_DRAW);
  const aPos = g.getAttribLocation(prog, "aPos"); g.enableVertexAttribArray(aPos); g.vertexAttribPointer(aPos, 2, g.FLOAT, false, 0, 0);
  const cache: Record<string, WebGLUniformLocation | null> = {};
  const loc: Loc = (name) => { if (!(name in cache)) cache[name] = g.getUniformLocation(prog, name); return cache[name]; };

  const dprCap = opts.dpr || 1.5;
  let W = 1, H = 1, raf = 0, running = false, visible = true;
  const start = performance.now();
  const mouse = { x: 0.5, y: 0.5, tx: 0.5, ty: 0.5, amt: 0, tamt: 0 };
  const lag = opts.lag == null ? 0.06 : opts.lag;
  function size() {
    const r = wrap.getBoundingClientRect(), d = Math.min(window.devicePixelRatio || 1, dprCap);
    W = Math.max(1, Math.round(r.width * d)); H = Math.max(1, Math.round(r.height * d));
    if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
    g.viewport(0, 0, W, H);
  }
  function draw(now: number) {
    const t = (now - start) / 1000 * (opts.speed || 1);
    mouse.x += (mouse.tx - mouse.x) * lag; mouse.y += (mouse.ty - mouse.y) * lag; mouse.amt += (mouse.tamt - mouse.amt) * lag;
    g.uniform2f(loc("uRes"), W, H);
    g.uniform1f(loc("uTime"), t + (opts.t0 || 0));
    g.uniform2f(loc("uMouse"), mouse.x, mouse.y);
    g.uniform1f(loc("uMouseAmt"), mouse.amt);
    g.uniform1f(loc("uGrain"), opts.grain == null ? 0.05 : opts.grain);
    if (opts.frame) opts.frame(g, loc, t);
    g.drawArrays(g.TRIANGLES, 0, 6);
  }
  function loop(now: number) { draw(now); raf = requestAnimationFrame(loop); }
  function play() { if (running || opts.still || !visible || document.hidden) return; running = true; raf = requestAnimationFrame(loop); }
  function pause() { running = false; cancelAnimationFrame(raf); }
  function recolor() { if (opts.setup) opts.setup(g, loc, wrap); draw(performance.now()); }

  function onMove(e: PointerEvent) {
    const r = wrap.getBoundingClientRect();
    mouse.tx = (e.clientX - r.left) / r.width; mouse.ty = 1 - (e.clientY - r.top) / r.height; mouse.tamt = 1;
  }
  function onLeave() { mouse.tamt = 0; }
  if (opts.interactive !== false) { wrap.addEventListener("pointermove", onMove); wrap.addEventListener("pointerleave", onLeave); }

  size(); recolor(); play();
  const ro = new ResizeObserver(() => { size(); draw(performance.now()); }); ro.observe(wrap);
  const io = new IntersectionObserver((es) => { visible = es[0].isIntersecting; if (visible) play(); else pause(); }); io.observe(wrap);
  const mo = new MutationObserver(recolor);
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "class"] });
  function onVis() { if (document.hidden) pause(); else play(); }
  document.addEventListener("visibilitychange", onVis);
  return {
    gl: g, loc, redraw: () => { draw(performance.now()); },
    cleanup: () => {
      pause(); ro.disconnect(); io.disconnect(); mo.disconnect();
      document.removeEventListener("visibilitychange", onVis);
      wrap.removeEventListener("pointermove", onMove); wrap.removeEventListener("pointerleave", onLeave);
      const ext = g.getExtension("WEBGL_lose_context"); if (ext) ext.loseContext();
    },
  };
}

export function fallbackBg(el: HTMLElement, names: readonly string[]): void {
  el.style.background = "linear-gradient(120deg, " + names.map((n) => "var(--" + n + ")").join(", ") + ")";
}
