import { render } from "@testing-library/react";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import * as UI from "../src";
import { KIT_COMPONENTS } from "./kit";


const REQUIRED: Record<string, Record<string, unknown>> = {
  FluidImage: { src: "/assets/Baggrunde/morgengry.jpg", alt: "Morgengry" },
  PrismText: { children: "Tal. Slip. Indsæt." },
  Transcript: { children: "Kan du lige pushe fixet til main" },
};

describe("package exports", () => {
  it("exports every component of the design system bundle", () => {
    for (const name of KIT_COMPONENTS) expect(typeof (UI as Record<string, unknown>)[name], name).toBe("function");
  });

  it("exports the presets the bundle exposes", () => {
    expect(Object.keys(UI.palettes)).toEqual(["morgengry", "flint", "rav", "skumring"]);
    expect(UI.meshPresets.nat).toEqual(["night", "mokka-dyb", "platin-dyb", "perle-dyb", "sand"]);
    expect(UI.wavePresets.skumring).toHaveLength(4);
    expect(UI.geometry.mark.h).toBe(100);
  });

  it.each(KIT_COMPONENTS)("%s renders", (name) => {
    const C = (UI as unknown as Record<string, (p: Record<string, unknown>) => JSX.Element>)[name];
    const { container } = render(createElement(C, REQUIRED[name] ?? {}));
    expect(container.firstElementChild).not.toBeNull();
  });

  it("keeps the design system's class names", () => {
    const { container } = render(
      <>
        <UI.LiquidBackground><p>x</p></UI.LiquidBackground>
        <UI.ShinyButton>Hent gratis</UI.ShinyButton>
        <UI.RelayDemo />
        <UI.ShowcaseCard scene="fn" title="Hold fn, tal, slip" />
      </>,
    );
    for (const cls of ["wt-liquid", "wt-blobs", "wt-blob-5", "wt-band", "wt-grain", "wt-content", "wt-shiny", "wt-shiny--ink", "wt-shiny--md",
      "wt-shiny-ring", "wt-shiny-sheen", "wt-shiny-label", "wt-shiny-icon", "wt-relay", "wt-relay-stage", "wt-laptop", "wt-phone", "wt-app", "wt-notice",
      "wt-pill", "wt-keycap", "wt-show", "wt-show-stage", "wt-show-title", "wt-sc-fn"]) {
      expect(container.querySelector("." + cls), cls).not.toBeNull();
    }
  });

  it("renders surfaces as the requested element", () => {
    const { container } = render(<UI.LiquidBackground as="header" className="hero" />);
    expect(container.firstElementChild!.tagName).toBe("HEADER");
    expect(container.firstElementChild).toHaveClass("wt-liquid", "hero");
  });
});
