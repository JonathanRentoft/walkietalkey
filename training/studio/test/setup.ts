/* Tests run in Copenhagen time, with jest-dom's matchers and a clean DOM after each test. */
process.env.TZ = "Europe/Copenhagen";
import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
});

if (!window.matchMedia)
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
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
          contentRect: { width: 720, height: 240 },
        } as unknown as ResizeObserverEntry,
      ],
      this as unknown as ResizeObserver,
    );
  }
  unobserve() {}
  disconnect() {}
}
if (!("ResizeObserver" in globalThis))
  Object.assign(globalThis, { ResizeObserver: RO });

Element.prototype.scrollIntoView ??= function () {};
Element.prototype.scrollTo ??= function () {};
HTMLMediaElement.prototype.play = function () {
  return Promise.resolve();
};
HTMLMediaElement.prototype.pause = function () {};
