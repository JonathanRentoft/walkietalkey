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
