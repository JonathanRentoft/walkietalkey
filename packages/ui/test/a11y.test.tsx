import { render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { FluidImage, Logo, Notice, PhoneApp, RelayDemo, ShinyButton, Transcript } from "../src";

const styles = resolve(__dirname, "../src/styles") + "/";
const css = readFileSync(styles + "components.css", "utf8") + readFileSync(styles + "extensions.css", "utf8");

/** true when the CSS gives `selector:focus-visible` the design system's focus ring */
function hasFocusRing(selector: string): boolean {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(esc + ":focus-visible[^{]*\\{[^}]*box-shadow:[^;}]*var\\(--focus-ring\\)").test(css);
}

/* spec 6.17: keyboard reachable, visible focus ring, a label on every control */
describe("accessibility", () => {
  it("ShinyButton is a button named by its text, with the focus ring", () => {
    render(<ShinyButton onClick={() => {}}>Hent gratis</ShinyButton>);
    const btn = screen.getByRole("button", { name: "Hent gratis" });
    expect(btn).toHaveAttribute("type", "button");
    btn.focus();
    expect(btn).toHaveFocus();
    expect(btn.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    expect(hasFocusRing(".wt-shiny")).toBe(true);
  });

  it("ShinyButton can be a link with the same look", () => {
    render(<ShinyButton href="/hent" size="lg">Hent gratis</ShinyButton>);
    const link = screen.getByRole("link", { name: "Hent gratis" });
    expect(link).toHaveAttribute("href", "/hent");
    expect(link).toHaveClass("wt-shiny", "wt-shiny--ink", "wt-shiny--lg");
    expect(link).not.toHaveAttribute("type");
  });

  it("PhoneApp controls are named and get the focus ring", () => {
    render(<PhoneApp state="failed" device="MacBook" buttonProps={{}} onRetry={() => {}} onDeviceClick={() => {}} />);
    expect(screen.getByRole("button", { name: "Nåede ikke frem til MacBook." })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Prøv igen" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "MacBook" })).toBeInTheDocument();
    expect(hasFocusRing(".wt-app-btn")).toBe(true);
    expect(hasFocusRing(".wt-app-action")).toBe(true);
    expect(hasFocusRing(".wt-app-dev")).toBe(true);
  });

  it("the logo has a name unless it is decorative", () => {
    const { container } = render(<><Logo /><Logo variant="mark" decorative /></>);
    expect(screen.getByRole("img", { name: "WalkieTalkey" })).toBeInTheDocument();
    expect(container.querySelectorAll('svg[aria-hidden="true"]')).toHaveLength(1);
  });

  it("the hero describes itself, with the paste key of its platform", () => {
    const { rerender } = render(<RelayDemo />);
    expect(screen.getByRole("img", { name: /sættes ind med ⌘V/ })).toBeInTheDocument();
    rerender(<RelayDemo platform="windows" />);
    expect(screen.getByRole("img", { name: /sættes ind med Ctrl\+V/ })).toBeInTheDocument();
  });

  it("notifications are announced (6.17)", () => {
    render(<Notice show preview="Hej Mette" />);
    expect(screen.getByRole("status")).toHaveTextContent("Tekst klar til at indsætte");
  });

  it("Transcript gives screen readers the whole sentence at once", () => {
    const { container } = render(<Transcript>Kan du lige pushe fixet</Transcript>);
    expect(container.querySelector(".wt-transcript")).toHaveTextContent("Kan du lige pushe fixet");
    container.querySelectorAll(".wt-tw").forEach((w) => expect(w).toHaveAttribute("aria-hidden", "true"));
  });

  it("FluidImage is an image named by alt", () => {
    render(<FluidImage src="/x.jpg" alt="Sølv og champagne" />);
    expect(screen.getByRole("img", { name: "Sølv og champagne" })).toBeInTheDocument();
  });
});
