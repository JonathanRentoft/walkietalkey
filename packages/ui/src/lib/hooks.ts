/* Hooks shared by the components. All of them are safe to render on a server: nothing here touches
   window or document at import time or during render, only inside effects and subscriptions. */
import { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type DependencyList, type RefObject } from "react";

/** useLayoutEffect in the browser, useEffect on the server (where neither runs, but only the former warns). */
export const useIsoLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;

const REDUCED = "(prefers-reduced-motion: reduce)";
let mq: MediaQueryList | null | undefined;
function getMQ(): MediaQueryList | null {
  if (mq === undefined) mq = typeof window !== "undefined" && window.matchMedia ? window.matchMedia(REDUCED) : null;
  return mq;
}
function subscribeReduced(cb: () => void): () => void {
  const m = getMQ();
  if (!m) return () => {};
  if (m.addEventListener) m.addEventListener("change", cb); else m.addListener(cb);
  return () => { if (m.removeEventListener) m.removeEventListener("change", cb); else m.removeListener(cb); };
}

/** prefers-reduced-motion. On the server, and while hydrating, it is false; the browser value follows at once. */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribeReduced, () => { const m = getMQ(); return m ? m.matches : false; }, () => false);
}

/** A stable id that is the same on the server and in the browser, usable inside url(#...). */
export function useUid(prefix: string): string {
  return prefix + useId().replace(/[^a-zA-Z0-9_-]/g, "");
}

/** Blur that scales with the surface: a small tile gets less blur, so its colours stay apart. */
export function useAutoBlur<T extends HTMLElement>(explicit: number | undefined): RefObject<T> {
  const ref = useRef<T>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || explicit != null || typeof ResizeObserver === "undefined") return undefined;
    const ro = new ResizeObserver((es) => {
      const r = es[0].contentRect, m = Math.min(r.width, r.height);
      el.style.setProperty("--wt-blur", Math.round(Math.max(20, Math.min(72, m * 0.3))) + "px");
    });
    ro.observe(el);
    return () => { ro.disconnect(); };
  }, [explicit]);
  return ref;
}

/** Runs frame(t) on every animation frame while the element is on screen and the tab is visible.
    t is seconds of play time, so pausing and resuming carries on where it stopped. With `still`, frame(-1) once. */
export function useFrames(ref: RefObject<Element>, still: boolean, frame: (t: number) => void, deps: DependencyList): void {
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    if (still) { frame(-1); return undefined; }
    let raf = 0, running = false, visible = true, acc = 0, last = 0;
    function loop(now: number) { acc += Math.min(64, now - last); last = now; frame(acc / 1000); raf = requestAnimationFrame(loop); }
    function play() { if (running || !visible || document.hidden) return; running = true; last = performance.now(); raf = requestAnimationFrame(loop); }
    function pause() { running = false; cancelAnimationFrame(raf); }
    frame(0); play();
    const io = typeof IntersectionObserver !== "undefined" ? new IntersectionObserver((es) => { visible = es[0].isIntersecting; if (visible) play(); else pause(); }) : null;
    if (io) io.observe(el);
    function onVis() { if (document.hidden) pause(); else play(); }
    document.addEventListener("visibilitychange", onVis);
    return () => { pause(); if (io) io.disconnect(); document.removeEventListener("visibilitychange", onVis); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

/** Scales a fixed-size design stage to the width of its box. 0 until measured. */
export function useFit(ref: RefObject<Element>, designW: number): number {
  const [s, setS] = useState(0);
  useIsoLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const w0 = el.getBoundingClientRect().width;
    if (w0 > 0) setS(w0 / designW);
    if (typeof ResizeObserver === "undefined") return undefined;
    const ro = new ResizeObserver((es) => { const w = es[0].contentRect.width; if (w > 0) setS(w / designW); });
    ro.observe(el);
    return () => { ro.disconnect(); };
  }, [designW]);
  return s;
}

export type Steps = readonly (readonly [string, number])[];

/** Steps through [name, ms] pairs while on screen. Pauses off screen and in a hidden tab.
    With `still` it shows the last step (or `stillAt`) and never moves. */
export function useTimeline(ref: RefObject<Element>, steps: Steps, still: boolean, loop?: boolean, stillAt?: number): number {
  const last = stillAt == null ? steps.length - 1 : stillAt;
  const [s, setS] = useState(still ? last : 0);
  useEffect(() => {
    if (still) { setS(last); return undefined; }
    const el = ref.current;
    let i = 0, timer: ReturnType<typeof setTimeout> | 0 = 0, visible = true, remaining = steps[0][1], started = 0, stopped = false;
    function schedule() { started = performance.now(); timer = setTimeout(next, remaining); }
    function next() {
      timer = 0;
      if (i === steps.length - 1 && loop === false) { stopped = true; return; }
      i = (i + 1) % steps.length; setS(i); remaining = steps[i][1];
      if (visible && !document.hidden) schedule();
    }
    function pause() { if (!timer) return; clearTimeout(timer); timer = 0; remaining = Math.max(0, remaining - (performance.now() - started)); }
    function resume() { if (timer || stopped) return; schedule(); }
    setS(0); schedule();
    const io = el && typeof IntersectionObserver !== "undefined" ? new IntersectionObserver((es) => { visible = es[0].isIntersecting; if (visible && !document.hidden) resume(); else pause(); }) : null;
    if (io) io.observe(el!);
    function onVis() { if (document.hidden) pause(); else if (visible) resume(); }
    document.addEventListener("visibilitychange", onVis);
    return () => { if (timer) clearTimeout(timer); if (io) io.disconnect(); document.removeEventListener("visibilitychange", onVis); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [still]);
  return s;
}

/** Counts whole seconds while `on`. */
export function useSeconds(on: boolean, still: boolean, start?: number): number {
  const [s, setS] = useState(start || 0);
  useEffect(() => {
    if (!on || still) return undefined;
    setS(0);
    const id = setInterval(() => { setS((v) => v + 1); }, 1000);
    return () => { clearInterval(id); };
  }, [on, still]);
  return s;
}

/** Follows the pointer with a spring; drifts on its own when the pointer is away. Writes --wt-x / --wt-y in px. */
export function useSpotlight(ref: RefObject<HTMLElement>, reduced: boolean, opts?: { host?: "window" }): void {
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const r = el.getBoundingClientRect();
    let x = r.width / 2, y = r.height / 2, vx = 0, vy = 0, tx = x, ty = y, over = false, raf = 0;
    const t0 = performance.now();
    function set() { el!.style.setProperty("--wt-x", x.toFixed(1) + "px"); el!.style.setProperty("--wt-y", y.toFixed(1) + "px"); }
    if (reduced) { set(); return undefined; }
    function onMove(e: Event) { const b = el!.getBoundingClientRect(), p = e as PointerEvent; tx = p.clientX - b.left; ty = p.clientY - b.top; over = true; }
    function onLeave() { over = false; }
    const host: Window | HTMLElement = opts && opts.host === "window" ? window : el;
    host.addEventListener("pointermove", onMove); el.addEventListener("pointerleave", onLeave);
    function step(now: number) {
      const b = el!.getBoundingClientRect();
      if (!over) {
        const s = (now - t0) / 1000 * 0.35;
        tx = b.width * (0.5 + 0.38 * Math.sin(s * 1.3)); ty = b.height * (0.5 + 0.3 * Math.sin(s * 2.1 + 1.2));
      }
      const k = over ? 0.14 : 0.04, damp = over ? 0.72 : 0.86;
      vx = (vx + (tx - x) * k) * damp; vy = (vy + (ty - y) * k) * damp;
      x += vx; y += vy; set();
      raf = requestAnimationFrame(step);
    }
    raf = requestAnimationFrame(step);
    return () => { cancelAnimationFrame(raf); host.removeEventListener("pointermove", onMove); el.removeEventListener("pointerleave", onLeave); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reduced]);
}
