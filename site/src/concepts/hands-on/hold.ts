/* Concept C (hands-on): press and hold, the way the app does it, for the hero's key and the phone tile's button.
   A hold starts on pointer down (or Space/Enter on the focused button) and ends on release. Released within 300 ms it
   was a tap, and nothing is dictated (DESK-26, the hold-only setting); Esc while holding cancels (DESK-25), and so
   does leaving the window, so a hold never gets stuck. */

/** A hold shorter than this is a tap and dictates nothing (DESK-26). */
export const MIN_HOLD = 300;

export interface HoldEvents {
  start(): void;
  /** released after MIN_HOLD or more */
  done(): void;
  /** released too soon */
  tap(): void;
  cancel(): void;
}

export interface Hold {
  readonly active: boolean;
  /** what started the current hold */
  readonly by: "pointer" | "key" | null;
  down(by: "pointer" | "key"): void;
  up(): void;
  cancel(): void;
}

const isKey = (e: KeyboardEvent) => e.key === " " || e.key === "Enter";

export function holdable(button: HTMLElement, on: HoldEvents): Hold {
  let t0 = 0;
  let by: Hold["by"] = null;
  const set = (down: boolean) => button.toggleAttribute("data-down", down);
  const api: Hold = {
    get active() {
      return by !== null;
    },
    get by() {
      return by;
    },
    down(how) {
      if (by) return;
      by = how;
      t0 = performance.now();
      set(true);
      on.start();
    },
    up() {
      if (!by) return;
      by = null;
      set(false);
      if (performance.now() - t0 < MIN_HOLD) on.tap();
      else on.done();
    },
    cancel() {
      if (!by) return;
      by = null;
      set(false);
      on.cancel();
    },
  };

  button.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    try {
      button.setPointerCapture(e.pointerId);
    } catch {
      /* a synthetic pointer has nothing to capture */
    }
    api.down("pointer");
  });
  button.addEventListener("pointerup", () => api.by === "pointer" && api.up());
  button.addEventListener("pointercancel", () => api.by === "pointer" && api.cancel());
  button.addEventListener("contextmenu", (e) => e.preventDefault());
  /* the hold is the action, never a click */
  button.addEventListener("click", (e) => e.preventDefault());
  button.addEventListener("keydown", (e) => {
    if (!isKey(e)) return;
    e.preventDefault();
    e.stopPropagation();
    if (!e.repeat) api.down("key");
  });
  button.addEventListener("keyup", (e) => {
    if (!isKey(e)) return;
    e.preventDefault();
    e.stopPropagation();
    if (api.by === "key") api.up();
  });
  button.addEventListener("blur", () => api.by === "key" && api.cancel());
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && api.active) {
      e.preventDefault();
      api.cancel();
    }
  });
  window.addEventListener("blur", () => api.cancel());
  document.addEventListener("visibilitychange", () => document.hidden && api.cancel());
  return api;
}

/** Polite announcements for screen readers: the same text twice is still read. */
export function say(el: HTMLElement | null, text: string) {
  if (!el) return;
  el.textContent = el.textContent === text ? text + " " : text;
}

/** "{name}" placeholders. */
export const fill = (t: string, v: Record<string, string>) =>
  t.replace(/\{(\w+)\}/g, (_, k: string) => v[k] ?? "");

export const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Restarts a CSS animation on an element by taking its class off and putting it back. */
export function replay(el: Element | null, cls: string) {
  if (!el) return;
  el.classList.remove(cls);
  void (el as HTMLElement).offsetWidth;
  el.classList.add(cls);
}
