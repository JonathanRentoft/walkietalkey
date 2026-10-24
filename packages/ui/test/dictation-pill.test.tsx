import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DictationPill } from "../src";

/* spec Appendix A, Pill */
const PILL = {
  idle: "Hold fn for at tale",
  listening: "Lytter",
  processing: "Renskriver",
  pasted: "Indsat",
  ready: "Tekst klar til at indsætte",
  nospeech: "Hørte ikke noget",
  raw: "Brugte teksten uden oprydning",
  notready: "Talemodellen er ikke klar endnu",
  error: "Kunne ikke hente talemodellen. Prøv igen.",
} as const;

/** the text a screen reader reads, word by word (the pill's parts are separate inline elements) */
function spoken(el: HTMLElement): string {
  const parts: string[] = [];
  el.querySelectorAll(".wt-pill-inner > *").forEach((n) => {
    if (n.getAttribute("aria-hidden") !== "true" && n.textContent)
      parts.push(n.textContent);
  });
  return parts.join(" ");
}

describe("DictationPill (DESK-55, Appendix A)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("is a polite live region", () => {
    render(<DictationPill state="idle" />);
    const pill = screen.getByRole("status");
    expect(pill).toHaveAttribute("aria-live", "polite");
    expect(pill).toHaveClass("wt-pill", "wt-pill--idle");
  });

  it.each(Object.entries(PILL))(
    "shows %s with its Appendix A label",
    (state, label) => {
      render(<DictationPill state={state as keyof typeof PILL} seconds={4} />);
      const pill = screen.getByRole("status");
      expect(pill).toHaveClass("wt-pill--" + state);
      expect(spoken(pill)).toContain(label);
    },
  );

  it("shows the recording time and level meter while listening", () => {
    render(<DictationPill state="listening" seconds={64} />);
    expect(screen.getByText("1:04")).toHaveClass("wt-pill-time");
    expect(document.querySelector(".wt-bars--meter")).not.toBeNull();
    expect(document.querySelector(".wt-rec")).not.toBeNull();
  });

  it("uses the paste key and the hotkey it is given (Windows)", () => {
    const { rerender } = render(
      <DictationPill state="ready" pasteKey="Ctrl+V" />,
    );
    expect(screen.getByText("Ctrl+V").tagName).toBe("KBD");
    rerender(<DictationPill state="idle" hotkey="Højre Ctrl" />);
    expect(screen.getByText("Højre Ctrl").tagName).toBe("KBD");
  });

  it("takes every label as a prop", () => {
    render(<DictationPill state="pasted" labels={{ pasted: "Pasted" }} />);
    expect(spoken(screen.getByRole("status"))).toBe("Pasted");
  });

  it("draws the live microphone level as a waveform (desktop, DESK-55)", () => {
    const { container, rerender } = render(
      <DictationPill state="listening" levels={[0.2, 1, 0.5]} seconds={3} />,
    );
    const wave = container.querySelector(".wt-wave");
    expect(wave).not.toBeNull();
    expect(wave).toHaveAttribute("aria-hidden", "true");
    const bars = container.querySelectorAll(".wt-wave i");
    expect(bars).toHaveLength(3);
    expect((bars[1] as HTMLElement).style.getPropertyValue("--v")).toBe("1");
    // The live waveform replaces the animated meter.
    expect(container.querySelector(".wt-bars--meter")).toBeNull();
    expect(spoken(screen.getByRole("status"))).toContain("Lytter");
    rerender(
      <DictationPill state="listening" levels={[0.1, 0.3, 0.9]} seconds={3} />,
    );
    expect(
      (
        container.querySelectorAll(".wt-wave i")[2] as HTMLElement
      ).style.getPropertyValue("--v"),
    ).toBe("0.9");
  });

  it("hands-free shows a lock and Tryk igen for at stoppe (Phase 1)", () => {
    const { container } = render(
      <DictationPill state="listening" handsFree levels={[0.5]} seconds={7} />,
    );
    const pill = screen.getByRole("status");
    expect(pill).toHaveClass("wt-pill--listening", "wt-pill--handsfree");
    expect(container.querySelector(".wt-pill-lock")).not.toBeNull();
    expect(spoken(pill)).toContain("Tryk igen for at stoppe");
    expect(screen.getByText("0:07")).toHaveClass("wt-pill-time");
  });

  it("the large size carries the mark for the desktop overlay", () => {
    const { container } = render(
      <DictationPill state="processing" size="lg" mark />,
    );
    const pill = screen.getByRole("status");
    expect(pill).toHaveClass("wt-pill--lg");
    expect(container.querySelector(".wt-pill-mark")).not.toBeNull();
    expect(spoken(pill)).toContain("Renskriver");
  });

  it("autoplay loops idle, listening, processing, ready", () => {
    vi.useFakeTimers();
    render(<DictationPill autoplay />);
    const pill = screen.getByRole("status");
    expect(pill).toHaveClass("wt-pill--idle");
    act(() => {
      vi.advanceTimersByTime(2400);
    });
    expect(pill).toHaveClass("wt-pill--listening");
    act(() => {
      vi.advanceTimersByTime(3800);
    });
    expect(pill).toHaveClass("wt-pill--processing");
    act(() => {
      vi.advanceTimersByTime(1700);
    });
    expect(pill).toHaveClass("wt-pill--ready");
    act(() => {
      vi.advanceTimersByTime(2800);
    });
    expect(pill).toHaveClass("wt-pill--idle");
  });
});
