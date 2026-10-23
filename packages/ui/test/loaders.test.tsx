import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LogoIntro, LogoLoader, type LogoLoaderProps } from "../src";
import { setReducedMotion } from "./setup";

const VARIANTS: NonNullable<LogoLoaderProps["variant"]>[] = [
  "smelt",
  "kviksolv",
  "drabe",
  "fyld",
  "ekko",
  "glans",
];

describe("LogoLoader", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each(VARIANTS)("renders %s as a named status", (variant) => {
    const { container } = render(<LogoLoader variant={variant} />);
    const el = screen.getByRole("status", { name: "Indlæser" });
    expect(el).toHaveClass("wt-loader", "wt-loader--" + variant);
    expect(container.querySelector("svg")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
    expect(container.querySelectorAll("path").length).toBeGreaterThan(0);
  });

  it("sizes its box per variant (drabe is 1.78 times as tall as the mark)", () => {
    render(<LogoLoader variant="drabe" size={100} />);
    const svg = document.querySelector("svg")!;
    expect(svg.getAttribute("height")).toBe("178");
    expect(svg.getAttribute("viewBox")).toBe("-8 -6 143.34 178");
  });

  it("fyld with progress is a progressbar with a value (DESK-11)", () => {
    render(
      <LogoLoader
        variant="fyld"
        progress={0.5}
        label="Henter dansk talemodel"
      />,
    );
    const bar = screen.getByRole("progressbar", {
      name: "Henter dansk talemodel",
    });
    expect(bar).toHaveAttribute("aria-valuenow", "50");
    expect(bar).toHaveAttribute("aria-valuemin", "0");
    expect(bar).toHaveAttribute("aria-valuemax", "100");
  });

  it("defaults the progress label to Henter", () => {
    render(<LogoLoader variant="fyld" progress={1.4} />);
    expect(screen.getByRole("progressbar", { name: "Henter" })).toHaveAttribute(
      "aria-valuenow",
      "100",
    );
  });

  it("uses the liquid-metal gradient for tone gradient", () => {
    const { container } = render(
      <LogoLoader variant="smelt" tone="gradient" />,
    );
    const grad = container.querySelector("linearGradient")!;
    expect(grad).not.toBeNull();
    expect(
      container.querySelector('path[fill^="url(#' + grad.id + ')"]'),
    ).not.toBeNull();
  });

  it("animates with requestAnimationFrame, and not at all with reduced motion", () => {
    const raf = vi.spyOn(window, "requestAnimationFrame");
    const { unmount } = render(<LogoLoader variant="smelt" />);
    expect(raf).toHaveBeenCalled();
    unmount();
    raf.mockClear();
    setReducedMotion(true);
    const { container } = render(<LogoLoader variant="smelt" />);
    expect(raf).not.toHaveBeenCalled();
    expect(container.querySelector(".wt-loader-breathe")).not.toBeNull();
    raf.mockRestore();
  });
});

describe("LogoIntro", () => {
  it("is the named lockup", () => {
    render(<LogoIntro size={30} />);
    const img = screen.getByRole("img", { name: "WalkieTalkey" });
    expect(img).toHaveClass("wt-logo", "wt-intro");
    expect(img.getAttribute("height")).toBe("30");
  });

  it("can be the mark alone, or decorative", () => {
    const { container } = render(<LogoIntro wordmark={false} decorative />);
    const svg = container.querySelector("svg")!;
    expect(svg).toHaveAttribute("aria-hidden", "true");
    expect(svg.getAttribute("height")).toBe("96");
    expect(container.querySelector("clipPath")).toBeNull();
  });

  it("calls onDone once after it has played", () => {
    vi.useFakeTimers({
      toFake: [
        "requestAnimationFrame",
        "cancelAnimationFrame",
        "performance",
        "setTimeout",
      ],
    });
    const done = vi.fn();
    render(<LogoIntro onDone={done} />);
    act(() => {
      vi.advanceTimersByTime(4000);
    });
    expect(done).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it("stands finished at once with reduced motion, and still reports onDone", () => {
    setReducedMotion(true);
    const done = vi.fn();
    const { container } = render(<LogoIntro onDone={done} />);
    const paths = container.querySelectorAll("path");
    const exact = Array.from(paths).find((p) => p.style.opacity === "1");
    expect(exact).toBeDefined();
    expect(done).toHaveBeenCalledOnce();
  });
});
