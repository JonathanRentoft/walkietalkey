import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DottedGlow, FlipWords, GradientFrame, GradientMotion, Logo, LogoLoader, PrismText, RelayDemo, SceneCleanup, SceneFn, SceneLocal,
  SceneNotify, ScenePhone, Transcript,
} from "../src";
import { setReducedMotion } from "./setup";

/* spec 6.17 and SITE-06: every animation stops or becomes a calm fade with prefers-reduced-motion */
describe("reduced motion", () => {
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it("RelayDemo shows the finished state and never moves", () => {
    vi.useFakeTimers();
    setReducedMotion(true);
    const { container } = render(<RelayDemo />);
    const relay = container.querySelector(".wt-relay")!;
    expect(relay).toHaveClass("wt-relay--still", "wt-relay--paste");
    act(() => { vi.advanceTimersByTime(20000); });
    expect(relay).toHaveClass("wt-relay--paste");
    expect(container.querySelector(".wt-win-pasted")).toHaveTextContent("Hej Mette.");
    expect(container.querySelector(".wt-notice")).toHaveClass("wt-notice--in");
  });

  it("RelayDemo loops through its steps with motion", () => {
    vi.useFakeTimers();
    const { container } = render(<RelayDemo />);
    const relay = container.querySelector(".wt-relay")!;
    expect(relay).toHaveClass("wt-relay--home");
    expect(relay).not.toHaveClass("wt-relay--still");
    act(() => { vi.advanceTimersByTime(1100); });
    expect(relay).toHaveClass("wt-relay--tap");
  });

  it("switches live when the setting changes", () => {
    const { container } = render(<PrismText>Tal. Slip. Indsæt.</PrismText>);
    expect(container.firstElementChild).not.toHaveClass("wt-prism--still");
    act(() => { setReducedMotion(true); });
    expect(container.firstElementChild).toHaveClass("wt-prism--still");
  });

  it("loops driven by requestAnimationFrame do not start", () => {
    setReducedMotion(true);
    const raf = vi.spyOn(window, "requestAnimationFrame");
    render(
      <>
        <LogoLoader variant="kviksolv" />
        <LogoLoader variant="fyld" />
        <GradientFrame><button>x</button></GradientFrame>
        <GradientMotion />
        <DottedGlow />
        <PrismText>Tal</PrismText>
      </>,
    );
    expect(raf).not.toHaveBeenCalled();
  });

  it("the logo gradient does not turn", () => {
    setReducedMotion(true);
    const { container } = render(<Logo variant="mark" tone="gradient" />);
    expect(container.querySelector("animateTransform")).toBeNull();
  });

  it("text effects show the whole text at once", () => {
    vi.useFakeTimers();
    setReducedMotion(true);
    const { container } = render(
      <>
        <Transcript>Kan du lige pushe fixet til main</Transcript>
        <FlipWords words={["mails", "noter"]} />
      </>,
    );
    const words = container.querySelectorAll(".wt-tw");
    expect(words).toHaveLength(7);
    words.forEach((w) => expect(w).toHaveClass("wt-tw--in"));
    act(() => { vi.advanceTimersByTime(10000); });
    expect(container.querySelector(".wt-flip-word")).toHaveTextContent("mails");
  });

  it("scenes stand on their final frame", () => {
    vi.useFakeTimers();
    setReducedMotion(true);
    const { container } = render(
      <>
        <SceneFn />
        <ScenePhone />
        <SceneNotify />
        <SceneCleanup />
        <SceneLocal />
      </>,
    );
    act(() => { vi.advanceTimersByTime(20000); });
    expect(container.querySelector(".wt-sc-fn .wt-win-pasted")).toHaveTextContent("Husk at sende tilbuddet");
    expect(container.querySelector(".wt-sc-phone .wt-app")).toHaveClass("wt-app--ready");
    expect(container.querySelectorAll(".wt-sc-note")).toHaveLength(3);
    expect(container.querySelector(".wt-sc-clean-text")).toHaveClass("wt-sc-clean-text--done");
    expect(container.querySelectorAll(".wt-sc-row--in")).toHaveLength(4);
    expect(screen.getAllByText("Klar på MacBook").length).toBeGreaterThan(0);
  });
});
