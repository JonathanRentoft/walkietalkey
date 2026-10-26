/* Run 8: the front pages let only one living background run at a time (SITE-06, as updated in run 8), so a page can
   pause a surface from outside, and the hero's BarField can stand still until the visitor moves. These are optional
   props; without them every component behaves as before. */
import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BarField, FluidMesh, LightWaves, ShowcaseCard } from "../src";
import { mountGL } from "../src/lib/gl";
import { setReducedMotion } from "./setup";

/* a WebGL stand-in that counts programs and draws */
function fakeGL() {
  const state = { programs: 0, draws: 0 };
  const gl = new Proxy({} as Record<string, unknown>, {
    get(_, k: string) {
      if (k === "isContextLost") return () => false;
      if (k === "getExtension") return () => null;
      if (k === "getShaderParameter" || k === "getProgramParameter")
        return () => true;
      if (k === "createProgram")
        return () => {
          state.programs += 1;
          return {};
        };
      if (k === "drawArrays")
        return () => {
          state.draws += 1;
        };
      if (k === "getUniformLocation") return () => ({});
      if (k === "getAttribLocation") return () => 0;
      if (/^[A-Z_]+$/.test(k)) return 1;
      return () => ({});
    },
  });
  return { gl, state };
}

/* requestAnimationFrame on fake timers, one frame every 16 ms */
function fakeFrames() {
  vi.useFakeTimers();
  let pending = 0;
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
    pending += 1;
    return setTimeout(() => {
      pending -= 1;
      cb(performance.now());
    }, 16) as unknown as number;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
    clearTimeout(id as unknown as ReturnType<typeof setTimeout>);
    pending = Math.max(0, pending - 1);
  });
  return { pending: () => pending };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("mountGL paused (run 8)", () => {
  it("draws one still frame while paused, and runs again when it is resumed", () => {
    const frames = fakeFrames();
    const { gl, state } = fakeGL();
    const canvas = document.createElement("canvas");
    canvas.getContext = (() => gl) as unknown as typeof canvas.getContext;
    const wrap = document.createElement("div");
    wrap.appendChild(canvas);
    const g = mountGL(wrap, canvas, "void main(){}", { paused: true })!;
    /* the first picture (colour, then size) and nothing after */
    const first = state.draws;
    expect(first).toBeGreaterThanOrEqual(1);
    expect(first).toBeLessThanOrEqual(2);
    vi.advanceTimersByTime(500);
    expect(state.draws).toBe(first);
    expect(frames.pending()).toBe(0);
    g.setPaused(false);
    vi.advanceTimersByTime(160);
    expect(state.draws).toBeGreaterThan(5);
    g.setPaused(true);
    const held = state.draws;
    vi.advanceTimersByTime(500);
    expect(state.draws).toBe(held);
    /* coming back to the tab does not wake a paused surface */
    document.dispatchEvent(new Event("visibilitychange"));
    vi.advanceTimersByTime(200);
    expect(state.draws).toBe(held);
    g.cleanup();
  });

  it("runs as before without the option", () => {
    fakeFrames();
    const { gl, state } = fakeGL();
    const canvas = document.createElement("canvas");
    canvas.getContext = (() => gl) as unknown as typeof canvas.getContext;
    const wrap = document.createElement("div");
    wrap.appendChild(canvas);
    const g = mountGL(wrap, canvas, "void main(){}", {})!;
    vi.advanceTimersByTime(160);
    expect(state.draws).toBeGreaterThan(5);
    g.cleanup();
  });
});

describe.each([
  ["FluidMesh", FluidMesh],
  ["LightWaves", LightWaves],
] as const)("%s paused (run 8)", (_, Surface) => {
  let fake: ReturnType<typeof fakeGL>;
  beforeEach(() => {
    fake = fakeGL();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(((
      kind: string,
    ) =>
      kind === "webgl"
        ? fake.gl
        : null) as unknown as typeof HTMLCanvasElement.prototype.getContext);
  });

  it("pauses and resumes from a prop, without building a new context", () => {
    fakeFrames();
    const { rerender } = render(<Surface paused />);
    vi.advanceTimersByTime(300);
    const still = fake.state.draws;
    expect(still).toBeLessThanOrEqual(2);
    rerender(<Surface paused={false} />);
    vi.advanceTimersByTime(160);
    expect(fake.state.draws).toBeGreaterThan(still + 5);
    rerender(<Surface paused />);
    const held = fake.state.draws;
    vi.advanceTimersByTime(300);
    expect(fake.state.draws).toBe(held);
    expect(fake.state.programs).toBe(1);
  });

  it("runs without the prop, as before", () => {
    fakeFrames();
    render(<Surface />);
    vi.advanceTimersByTime(160);
    expect(fake.state.draws).toBeGreaterThan(5);
  });
});

describe("BarField interactive (run 8)", () => {
  const scales = (root: HTMLElement) =>
    [...root.querySelectorAll<HTMLElement>(".wt-bf")].map((b) => {
      const m = /scaleY\(([\d.]+)\)/.exec(b.style.transform);
      return m ? Number(m[1]) : null;
    });
  /** puts the field at 0..800 x 0..400 on the screen */
  function place(root: HTMLElement) {
    const field = root.querySelector<HTMLElement>(".wt-barfield")!;
    field.getBoundingClientRect = () =>
      ({
        left: 0,
        top: 0,
        right: 800,
        bottom: 400,
        width: 800,
        height: 400,
        x: 0,
        y: 0,
      }) as DOMRect;
    return field;
  }
  const move = (x: number, y = 200) =>
    act(() => {
      window.dispatchEvent(
        new MouseEvent("pointermove", { clientX: x, clientY: y }),
      );
    });

  it("leaves the default BarField as it was: CSS motion, no listeners", () => {
    const add = vi.spyOn(window, "addEventListener");
    const { container } = render(<BarField bars={40} mode="wave" />);
    const field = container.querySelector(".wt-barfield")!;
    expect(field).not.toHaveClass("wt-barfield--interactive");
    expect(add.mock.calls.map((c) => c[0])).not.toContain("pointermove");
  });

  it("stands still until the pointer moves, raises the bars near it, and settles back to still", () => {
    const frames = fakeFrames();
    const { container } = render(
      <BarField bars={40} mode="wave" interactive />,
    );
    const field = place(container);
    expect(field).toHaveClass("wt-barfield--interactive");
    expect(container.querySelectorAll(".wt-bf")).toHaveLength(40);
    vi.advanceTimersByTime(1000);
    expect(scales(container).every((s) => s === null)).toBe(true);
    expect(frames.pending()).toBe(0);

    move(200);
    vi.advanceTimersByTime(250);
    const s = scales(container) as number[];
    /* bar 9 sits under x = 200 (of 800); the far right stays low */
    expect(s[9]).toBeGreaterThan(s[35] + 0.15);
    expect(s[9]).toBeGreaterThan(0.75);

    /* no more input: it settles, the inline style goes and no frame is pending */
    vi.advanceTimersByTime(4000);
    expect(scales(container).every((v) => v === null)).toBe(true);
    expect(frames.pending()).toBe(0);
  });

  it("runs a wave through the bars when the page scrolls, then settles", () => {
    const frames = fakeFrames();
    const { container } = render(
      <BarField bars={40} mode="wave" interactive />,
    );
    place(container);
    act(() => {
      Object.defineProperty(window, "scrollY", {
        value: 300,
        configurable: true,
      });
      window.dispatchEvent(new Event("scroll"));
    });
    vi.advanceTimersByTime(200);
    const s = scales(container).filter((v): v is number => v !== null);
    expect(s.length).toBe(40);
    expect(Math.max(...s) - Math.min(...s)).toBeGreaterThan(0.05);
    vi.advanceTimersByTime(5000);
    expect(scales(container).every((v) => v === null)).toBe(true);
    expect(frames.pending()).toBe(0);
    Object.defineProperty(window, "scrollY", { value: 0, configurable: true });
  });

  it("ignores the pointer while paused, and with reduced motion", () => {
    fakeFrames();
    const { container, rerender } = render(
      <BarField bars={40} mode="wave" interactive paused />,
    );
    place(container);
    move(200);
    vi.advanceTimersByTime(250);
    expect(scales(container).every((v) => v === null)).toBe(true);
    rerender(<BarField bars={40} mode="wave" interactive />);
    move(200);
    vi.advanceTimersByTime(250);
    expect(scales(container).some((v) => v !== null)).toBe(true);
  });

  it("comes to rest within 160 ms once it is paused while the bars are up", () => {
    const frames = fakeFrames();
    const { container, rerender } = render(
      <BarField bars={40} mode="wave" interactive />,
    );
    place(container);
    move(200);
    vi.advanceTimersByTime(200);
    expect(scales(container).some((v) => v !== null && v > 0.6)).toBe(true);
    rerender(<BarField bars={40} mode="wave" interactive paused />);
    vi.advanceTimersByTime(200);
    expect(scales(container).every((v) => v === null)).toBe(true);
    expect(frames.pending()).toBe(0);
  });

  it("does nothing with reduced motion", () => {
    fakeFrames();
    setReducedMotion(true);
    const { container } = render(
      <BarField bars={40} mode="wave" interactive />,
    );
    place(container);
    move(200);
    vi.advanceTimersByTime(250);
    expect(scales(container).every((v) => v === null)).toBe(true);
  });

  it("pauses its CSS motion when paused without being interactive", () => {
    const { container } = render(<BarField bars={12} paused />);
    expect(container.querySelector(".wt-barfield")).toHaveClass(
      "wt-barfield--paused",
    );
  });
});

describe("ShowcaseCard release (run 8)", () => {
  const SENTENCE = "Kan du lige pushe fixet til main inden vores standup?";
  it("types the mixed sentence word by word by default, as before", () => {
    const { container } = render(<ShowcaseCard scene="sprog" />);
    expect(container.querySelector(".wt-transcript")).not.toBeNull();
    expect(container.querySelector(".wt-pill")).toBeNull();
  });

  it("with release, listens first and then lands the whole sentence at once, as the app does", () => {
    vi.useFakeTimers();
    const { container } = render(<ShowcaseCard scene="sprog" release />);
    const words = () => container.querySelectorAll(".wt-tw");
    const landed = () => container.querySelectorAll(".wt-tw--in");
    expect(container.querySelector(".wt-pill--listening")).not.toBeNull();
    expect(landed()).toHaveLength(0);
    act(() => {
      vi.advanceTimersByTime(2500);
    });
    expect(words().length).toBe(SENTENCE.split(" ").length);
    expect(landed()).toHaveLength(words().length);
    expect(container.querySelectorAll(".wt-tw--hl").length).toBeGreaterThan(2);
    expect(container.querySelector(".wt-pill--listening")).toBeNull();
    /* screen readers get the sentence once */
    expect(container.querySelector(".wt-sr")).toHaveTextContent(SENTENCE);
  });

  it("with release and reduced motion, shows the landed sentence and never moves", () => {
    vi.useFakeTimers();
    setReducedMotion(true);
    const { container } = render(<ShowcaseCard scene="sprog" release />);
    const n = container.querySelectorAll(".wt-tw").length;
    expect(n).toBeGreaterThan(5);
    expect(container.querySelectorAll(".wt-tw--in")).toHaveLength(n);
    act(() => {
      vi.advanceTimersByTime(20000);
    });
    expect(container.querySelectorAll(".wt-tw--in")).toHaveLength(n);
  });
});
