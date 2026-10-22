// @vitest-environment node
/* Astro renders the components on the server: nothing may touch window or document at import time or during render. */
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import * as UI from "../src";
import { KIT_COMPONENTS } from "./kit";

describe("server rendering", () => {
  it("runs without a DOM", () => {
    expect(typeof window).toBe("undefined");
    expect(typeof document).toBe("undefined");
  });

  it.each(KIT_COMPONENTS)("%s renders to a string", (name) => {
    const C = (UI as unknown as Record<string, (p: Record<string, unknown>) => JSX.Element>)[name];
    const props: Record<string, unknown> = name === "FluidImage" ? { src: "/x.jpg", alt: "x" } : name === "PrismText" || name === "Transcript" ? { children: "Tal. Slip. Indsæt." } : {};
    const html = renderToString(createElement(C, props));
    expect(html.length).toBeGreaterThan(10);
  });

  it("renders the still state of motion components (no reduced-motion guess on the server)", () => {
    expect(renderToString(createElement(UI.RelayDemo))).toContain("wt-relay--home");
    expect(renderToString(createElement(UI.LogoLoader, { variant: "fyld", progress: 0.3 }))).toContain('aria-valuenow="30"');
  });
});
