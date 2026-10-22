import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PhoneApp, type PhoneAppState } from "../src";

function label(el: HTMLElement): string {
  return el.querySelector(".wt-app-label > span:last-child")!.textContent!;
}
function sub(el: HTMLElement): string {
  return el.querySelector(".wt-app-sub")!.textContent!;
}

/* spec 7.3, PHONE-20 to PHONE-26, with the Appendix A strings */
const CASES: [string, PhoneAppState, string, string][] = [
  ["PHONE-20", "idle", "Hold for at tale", ""],
  ["PHONE-21", "rec", "Slip for at sende", ""],
  ["PHONE-26", "cancel", "Slip for at annullere", ""],
  ["PHONE-22", "send", "Sender til {c}", ""],
  ["PHONE-23", "ready", "Klar på {c}", "Tryk ⌘V for at indsætte"],
  ["PHONE-24", "offline", "{c} er ikke online. Optagelsen venter i 10 minutter.", ""],
  ["PHONE-24", "failed", "Nåede ikke frem til {c}.", "Prøv igen"],
  ["PHONE-25", "error", "Noget gik galt. Prøv igen.", "Detaljer"],
  ["PHONE-25", "paused", "{c} er sat på pause.", ""],
];

describe("PhoneApp", () => {
  describe.each([["MacBook", undefined], ["Jonathans ThinkPad", "Jonathans ThinkPad"]])("with computer %s", (name, device) => {
    it.each(CASES)("%s %s", (_id, state, text, subText) => {
      const { container } = render(<PhoneApp state={state} device={device} />);
      const app = container.querySelector(".wt-app") as HTMLElement;
      expect(app).toHaveClass("wt-app--" + state);
      expect(label(app)).toBe(text.replace("{c}", name));
      expect(sub(app)).toBe(subText);
      expect(app.querySelector(".wt-app-dev")).toHaveTextContent(name);
      expect(app.querySelector(".wt-app-foot")).toHaveTextContent("Krypteret fra telefon til computer");
    });
  });

  it("PHONE-23 says Ctrl+V when the QR said o: win", () => {
    const { container } = render(<PhoneApp state="ready" device="ThinkPad" os="win" />);
    expect(sub(container)).toBe("Tryk Ctrl+V for at indsætte");
    expect(label(container)).toBe("Klar på ThinkPad");
  });

  it("PHONE-21 shows the red dot, the time and the meter while recording", () => {
    const { container } = render(<PhoneApp state="rec" seconds={75} />);
    expect(container.querySelector(".wt-app-rec")).toHaveAttribute("aria-hidden", "false");
    expect(container.querySelector(".wt-app-time")).toHaveTextContent("1:15");
    expect(container.querySelector(".wt-app-meter .wt-bars--off")).toBeNull();
  });

  it("is a still picture by default, and a real hold button when given buttonProps", () => {
    const { container, rerender } = render(<PhoneApp state="idle" />);
    expect(container.querySelector(".wt-app-btn")).toHaveAttribute("role", "img");
    expect(container.querySelector(".wt-app-btn")).toHaveAttribute("aria-label", "Hold for at tale");
    const down = vi.fn();
    rerender(<PhoneApp state="idle" buttonProps={{ onPointerDown: down }} />);
    const btn = screen.getByRole("button", { name: "Hold for at tale" });
    expect(btn).toHaveClass("wt-app-btn");
    fireEvent.pointerDown(btn);
    expect(down).toHaveBeenCalledOnce();
  });

  it("PHONE-24 offers Prøv igen and PHONE-25 offers Detaljer", () => {
    const retry = vi.fn(), details = vi.fn();
    const { rerender } = render(<PhoneApp state="failed" onRetry={retry} />);
    fireEvent.click(screen.getByRole("button", { name: "Prøv igen" }));
    expect(retry).toHaveBeenCalledOnce();
    rerender(<PhoneApp state="error" onDetails={details} />);
    fireEvent.click(screen.getByRole("button", { name: "Detaljer" }));
    expect(details).toHaveBeenCalledOnce();
  });

  it("PHONE-41 lets the user tap the computer chip", () => {
    const pick = vi.fn();
    render(<PhoneApp device="MacBook" onDeviceClick={pick} />);
    fireEvent.click(screen.getByRole("button", { name: /MacBook/ }));
    expect(pick).toHaveBeenCalledOnce();
  });

  it("takes every string as a prop", () => {
    const { container } = render(<PhoneApp state="ready" device="PC" labels={{ ready: "Ready on {computer}", pasteHint: "Press {key}", lock: "Encrypted" }} pasteKey="Ctrl+V" />);
    expect(label(container)).toBe("Ready on PC");
    expect(sub(container)).toBe("Press Ctrl+V");
    expect(container.querySelector(".wt-app-foot")).toHaveTextContent("Encrypted");
  });
});
