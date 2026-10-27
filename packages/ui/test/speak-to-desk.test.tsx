/* Run 10: SpeakToDesk, the front page's devices scene without a card around it. You hold the phone's button and talk;
   the sound goes to the computer you sit at (the one in use, PHONE-40 and DESK-63), which shows the pill (DESK-58) and
   "Tekst klar til at indsætte" (DESK-56), and the text is pasted there (DESK-52). The other computer never gets it
   (spec 12.1, PRIV). The page pauses it off screen (SITE-06); with reduced motion it is one still frame. */
import { act, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as UI from "../src";
import { SpeakToDesk } from "../src";
import { setReducedMotion } from "./setup";

const TEXT = "Hej Mette. Jeg er ti minutter forsinket";

const css = readFileSync(
  resolve(__dirname, "../src/styles/extensions.css"),
  "utf8",
);

/** The declarations of the first rule whose selector is exactly `selector`. */
function rule(selector: string): string {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp("(^|\\n)" + esc + "\\s*\\{([^}]*)\\}").exec(css);
  expect(m, "rule " + selector).not.toBeNull();
  return m![2];
}

function parts(container: HTMLElement) {
  const root = container.querySelector<HTMLElement>(".wt-spk")!;
  return {
    root,
    step: () => root.getAttribute("data-step"),
    phone: root.querySelector<HTMLElement>(".wt-spk-phone")!,
    app: root.querySelector<HTMLElement>(".wt-spk-phone .wt-app")!,
    finger: root.querySelector<HTMLElement>(".wt-spk-phone .wt-finger")!,
    flow: root.querySelector<HTMLElement>(".wt-spk-flow")!,
    on: root.querySelector<HTMLElement>(".wt-spk-dev--on")!,
    off: root.querySelector<HTMLElement>(".wt-spk-dev--off")!,
  };
}

/** The computer that is not in use stays empty: no text, no notification, no pill, no sound arriving. */
function expectIdleEmpty(off: HTMLElement) {
  expect(off.querySelector(".wt-win-pasted")).toBeNull();
  expect(off.querySelector(".wt-notice")).toBeNull();
  expect(off.querySelector(".wt-pill")).toBeNull();
  expect(off.querySelector(".wt-desk-keys")).toBeNull();
  expect(off).not.toHaveTextContent("Hej Mette");
  expect(off).not.toHaveTextContent("Tekst klar til at indsætte");
  expect(off.querySelector(".wt-spk-dim")).not.toBeNull();
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("SpeakToDesk (run 10)", () => {
  it("is exported from the package", () => {
    expect(typeof UI.SpeakToDesk).toBe("function");
  });

  it("sits on the page without a card or frame around it", () => {
    const { container } = render(<SpeakToDesk paused />);
    const { root } = parts(container);
    expect(root).not.toBeNull();
    /* none of the boxes the other scenes live in */
    expect(
      container.querySelector(
        ".wt-show, .wt-show-stage, .wt-show-surface, .wt-sc-card, .wt-scene, .wt-mwin",
      ),
    ).toBeNull();
    /* and the scene itself draws no box: no border, background, shadow or rounded clip on its outer elements */
    for (const sel of [".wt-spk", ".wt-spk-box"]) {
      const decl = rule(sel);
      expect(decl, sel).not.toMatch(/(^|[\s;])border(-[a-z]+)?\s*:/);
      expect(decl, sel).not.toMatch(/background/);
      expect(decl, sel).not.toMatch(/box-shadow/);
      expect(decl, sel).not.toMatch(/border-radius/);
      expect(decl, sel).not.toMatch(/overflow\s*:\s*hidden/);
    }
  });

  it("shows the MacBook, the ThinkPad and the phone app, with the computer in use marked", () => {
    const { container } = render(<SpeakToDesk paused />);
    const { on, off, app } = parts(container);
    expect(on.querySelector(".wt-laptop")).not.toBeNull();
    expect(off.querySelector(".wt-laptop")).not.toBeNull();
    expect(on).toHaveClass("wt-spk-dev--mac");
    expect(off).toHaveClass("wt-spk-dev--thinkpad");
    expect(on.querySelector(".wt-spk-name")).toHaveTextContent("MacBook");
    expect(off.querySelector(".wt-spk-name")).toHaveTextContent("ThinkPad");
    expect(on.querySelector(".wt-spk-state")).toHaveTextContent(/^I brug$/);
    expect(off.querySelector(".wt-spk-state")).toHaveTextContent(
      /^Ikke i brug$/,
    );
    expect(app).not.toBeNull();
    expect(app.querySelector(".wt-app-dev")).toHaveTextContent("MacBook");
  });

  it("is one image with a Danish description, its parts hidden from screen readers", () => {
    const { container } = render(<SpeakToDesk paused />);
    const img = screen.getByRole("img", {
      name: /telefonen.*den computer, du sidder ved.*MacBook.*ThinkPad/,
    });
    expect(img).toHaveClass("wt-spk");
    expect(img.getAttribute("aria-label")).not.toContain("—");
    expect(container.querySelector(".wt-spk-stage")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
    /* nothing inside is announced on its own */
    expect(screen.queryAllByRole("status")).toHaveLength(0);
    expect(screen.getAllByRole("img")).toHaveLength(1);
  });

  it("takes a label from the page", () => {
    render(<SpeakToDesk paused label="Teksten lander, hvor du sidder" />);
    expect(
      screen.getByRole("img", { name: "Teksten lander, hvor du sidder" }),
    ).toBeInTheDocument();
  });

  it("tells the story in order: button held, sound travelling, words on the computer in use, never on the other", () => {
    vi.useFakeTimers();
    const { container } = render(<SpeakToDesk />);
    const p = parts(container);
    const seen: string[] = [];
    let recChecked = false,
      readyChecked = false,
      pasteChecked = false;
    for (let t = 0; t < 26000; t += 50) {
      const step = p.step()!;
      if (seen[seen.length - 1] !== step) seen.push(step);
      expectIdleEmpty(p.off);
      if (step.startsWith("rec")) {
        expect(p.app).toHaveClass("wt-app--rec");
        expect(p.finger).toHaveClass("wt-finger--button", "wt-finger--down");
        expect(p.flow).toHaveClass("wt-spk-flow--on");
        expect(p.root.querySelector(".wt-spk-voice")).toHaveClass(
          "wt-spk-voice--on",
        );
        expect(p.on.querySelector(".wt-desk-pill")).toHaveClass(
          "wt-desk-pill--in",
        );
        expect(p.on.querySelector(".wt-win-pasted")).toBeNull();
        recChecked = true;
      }
      if (step === "ready") {
        expect(p.on.querySelector(".wt-notice")).toHaveClass("wt-notice--in");
        expect(p.on.querySelector(".wt-notice")).toHaveTextContent(
          "Tekst klar til at indsætte",
        );
        expect(p.on.querySelector(".wt-win-pasted")).toBeNull();
        expect(p.app).toHaveClass("wt-app--ready");
        readyChecked = true;
      }
      if (step === "paste") {
        expect(p.on.querySelector(".wt-win-pasted")).toHaveTextContent(TEXT);
        pasteChecked = true;
      }
      act(() => {
        vi.advanceTimersByTime(50);
      });
    }
    expect(recChecked && readyChecked && pasteChecked).toBe(true);
    const order = [
      "idle",
      "press",
      "rec0",
      "send",
      "ready",
      "keys",
      "paste",
      "reset",
    ];
    /* one whole loop, in order, after it started from the still frame */
    const from = seen.indexOf("idle");
    expect(from).toBeGreaterThan(0);
    const loop = seen.slice(from);
    let k = -1;
    for (const name of order) {
      const at = loop.indexOf(name);
      expect(at, name).toBeGreaterThan(k);
      k = at;
    }
  });

  it("counts the seconds on the phone while the button is held", () => {
    vi.useFakeTimers();
    const { container } = render(<SpeakToDesk />);
    const p = parts(container);
    let guard = 0;
    while (p.step() !== "rec1" && guard++ < 400)
      act(() => {
        vi.advanceTimersByTime(50);
      });
    expect(p.app.querySelector(".wt-app-time")).toHaveTextContent("0:01");
  });

  it("runs no timers and holds its CSS motion while paused, and goes on where it stopped", () => {
    vi.useFakeTimers();
    const { container, rerender } = render(<SpeakToDesk paused />);
    const p = parts(container);
    expect(p.step()).toBe("still");
    expect(p.root).toHaveClass("wt-spk--paused");
    expect(vi.getTimerCount()).toBe(0);
    act(() => {
      vi.advanceTimersByTime(20000);
    });
    expect(p.step()).toBe("still");

    rerender(<SpeakToDesk paused={false} />);
    expect(p.root).not.toHaveClass("wt-spk--paused");
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    act(() => {
      vi.advanceTimersByTime(4000);
    });
    const held = p.step();
    expect(held).not.toBe("still");

    rerender(<SpeakToDesk paused />);
    expect(vi.getTimerCount()).toBe(0);
    act(() => {
      vi.advanceTimersByTime(20000);
    });
    expect(p.step()).toBe(held);
    expect(p.root).toHaveClass("wt-spk--paused");

    rerender(<SpeakToDesk paused={false} />);
    act(() => {
      vi.advanceTimersByTime(4000);
    });
    expect(p.step()).not.toBe(held);
  });

  it("with reduced motion shows one still frame with the whole story and schedules nothing", () => {
    vi.useFakeTimers();
    setReducedMotion(true);
    const raf = vi.spyOn(window, "requestAnimationFrame");
    const { container } = render(<SpeakToDesk />);
    const p = parts(container);
    expect(p.step()).toBe("still");
    expect(p.root).toHaveClass("wt-spk--reduced");
    expect(vi.getTimerCount()).toBe(0);
    expect(raf).not.toHaveBeenCalled();
    /* the button is held, the sound is on its way, the words are on the computer in use */
    expect(p.app).toHaveClass("wt-app--rec");
    expect(p.finger).toHaveClass("wt-finger--button", "wt-finger--down");
    expect(p.flow).toHaveClass("wt-spk-flow--still");
    expect(p.on.querySelector(".wt-win-pasted")).toHaveTextContent(TEXT);
    expect(p.on.querySelector(".wt-notice")).toHaveClass("wt-notice--in");
    expectIdleEmpty(p.off);
    act(() => {
      vi.advanceTimersByTime(30000);
    });
    expect(p.step()).toBe("still");
    expect(raf).not.toHaveBeenCalled();
  });

  it("stops at once when reduced motion is switched on", () => {
    vi.useFakeTimers();
    const { container } = render(<SpeakToDesk />);
    const p = parts(container);
    act(() => {
      vi.advanceTimersByTime(4000);
    });
    expect(p.step()).not.toBe("still");
    act(() => {
      setReducedMotion(true);
    });
    expect(p.step()).toBe("still");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("lands the sound on the MacBook's WalkieTalkey icon, which pulses while it streams in (DESK-58)", () => {
    vi.useFakeTimers();
    const { container } = render(<SpeakToDesk />);
    const p = parts(container);
    let guard = 0;
    while (p.step() !== "rec0" && guard++ < 400)
      act(() => {
        vi.advanceTimersByTime(50);
      });
    expect(p.on.querySelector(".wt-mbar-wt")).toHaveClass("wt-mbar-wt--live");
    expect(p.off.querySelector(".wt-mbar-wt--live")).toBeNull();
    expect(p.root.querySelector(".wt-spk-arcs")).toHaveClass("wt-spk-arcs--on");
  });

  it("stops every loop for reduced motion in its CSS", () => {
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: reduce\)\s*\{[^@]*\.wt-spk \*/,
    );
    expect(css).toMatch(/\.wt-spk--reduced \*/);
    expect(css).toMatch(
      /\.wt-spk--paused \*[^{]*\{[^}]*animation-play-state:\s*paused/,
    );
  });
});
