/* jsdom lacks a few browser APIs the components use. These stand-ins are small and controllable from tests. */
import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

afterEach(() => {
  if (typeof window === "undefined") return;
  cleanup();
  setReducedMotion(false);
});

/* prefers-reduced-motion, switchable at runtime with setReducedMotion() */
type Listener = (e: { matches: boolean }) => void;
const listeners = new Set<Listener>();
let reduced = false;
export function setReducedMotion(on: boolean) {
  if (reduced === on) return;
  reduced = on;
  listeners.forEach((l) => l({ matches: on }));
}
const hasDom = typeof window !== "undefined";
if (hasDom)
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      get matches() {
        return query.includes("prefers-reduced-motion: reduce")
          ? reduced
          : false;
      },
      media: query,
      onchange: null,
      addEventListener: (_: string, l: Listener) => listeners.add(l),
      removeEventListener: (_: string, l: Listener) => listeners.delete(l),
      addListener: (l: Listener) => listeners.add(l),
      removeListener: (l: Listener) => listeners.delete(l),
      dispatchEvent: () => false,
    }),
  });

class RO {
  constructor(private cb: ResizeObserverCallback) {}
  observe(el: Element) {
    this.cb(
      [
        {
          target: el,
          contentRect: { width: 800, height: 500 },
        } as unknown as ResizeObserverEntry,
      ],
      this as unknown as ResizeObserver,
    );
  }
  unobserve() {}
  disconnect() {}
}
class IO {
  constructor(private cb: IntersectionObserverCallback) {}
  observe(el: Element) {
    this.cb(
      [
        {
          target: el,
          isIntersecting: true,
        } as unknown as IntersectionObserverEntry,
      ],
      this as unknown as IntersectionObserver,
    );
  }
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}
if (hasDom)
  Object.assign(globalThis, { ResizeObserver: RO, IntersectionObserver: IO });

/* canvas: a do-nothing 2D context; no WebGL, so the GL surfaces take their CSS fallback */
const ctx2d = new Proxy({}, { get: () => () => undefined, set: () => true });
if (hasDom)
  HTMLCanvasElement.prototype.getContext = vi.fn(function (kind: string) {
    return kind === "2d" ? ctx2d : null;
  }) as unknown as typeof HTMLCanvasElement.prototype.getContext;

if (hasDom && !window.requestAnimationFrame) {
  window.requestAnimationFrame = (cb) =>
    setTimeout(() => cb(performance.now()), 16) as unknown as number;
  window.cancelAnimationFrame = (id) => clearTimeout(id);
}
