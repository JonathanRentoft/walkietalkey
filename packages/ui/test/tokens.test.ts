import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { generate, type TokensJson } from "../scripts/tokens-lib";
import * as tokens from "../src/tokens";

const root = resolve(__dirname, "..") + "/";
const json = JSON.parse(
  readFileSync(root + "tokens/tokens.json", "utf8"),
) as TokensJson;
const css = readFileSync(root + "src/styles/tokens.css", "utf8");

/** Returns the declarations of the first rule whose selector list starts with `selector`. */
function block(source: string, selector: string): string {
  const at = source.indexOf(selector);
  expect(at, `rule ${selector}`).toBeGreaterThanOrEqual(0);
  const open = source.indexOf("{", at);
  return source.slice(open + 1, source.indexOf("}", open));
}

describe("tokens.css", () => {
  const light = block(css, ":root,");
  const dark = block(css, '[data-theme="dark"] {');

  it("is exactly what the generator makes from tokens.json (run bun run gen:tokens)", () => {
    expect(css).toBe(generate(json).css);
    expect(readFileSync(root + "src/tokens.ts", "utf8")).toBe(
      generate(json).ts,
    );
  });

  it("covers the light theme on :root and on [data-theme=light]", () => {
    expect(css).toMatch(/:root,\s*\[data-theme="light"\] \{/);
    expect(light).toContain("--surface-100: #faf8f4;");
    expect(light).toContain("--ink: #1b1a19;");
    expect(light).toContain("--signal-rec: #c2392f;");
  });

  it("redefines every themed colour for [data-theme=dark]", () => {
    for (const t of json.color.tokens) {
      if (typeof t.value === "object") {
        expect(light).toContain(`--${t.name}: ${t.value.light};`);
        expect(dark).toContain(`--${t.name}: ${t.value.dark};`);
      } else if (t.value.startsWith("{")) {
        const ref = t.value.slice(1, -1);
        expect(light).toContain(`--${t.name}: var(--${ref});`);
        expect(dark).toContain(`--${t.name}: var(--${ref});`);
      } else {
        expect(light).toContain(`--${t.name}: ${t.value};`);
        expect(dark).not.toContain(`--${t.name}:`);
      }
    }
  });

  it("has spacing, radius, blur, motion, opacity and type tokens", () => {
    expect(light).toContain("--space-4: 16px;");
    expect(light).toContain("--radius-pill: 999px;");
    expect(light).toContain("--blur-liquid: 72px;");
    expect(light).toContain("--duration-drift: 28000ms;");
    expect(light).toContain("--ease-pop: cubic-bezier(0.34, 1.56, 0.64, 1);");
    expect(light).toContain("--grain-opacity: 0.14;");
    expect(light).toContain('--font-sans: "Albert Sans", ui-sans-serif');
    expect(light).toContain(
      "--type-display-xl: 600 72px/0.98 var(--font-sans);",
    );
    expect(light).toContain("--type-display-xl-tracking: -0.035em;");
  });

  it("themes the shadows and the focus ring", () => {
    expect(light).toContain(
      "--focus-ring: 0 0 0 2px #faf8f4, 0 0 0 4px #1b1a19;",
    );
    expect(dark).toContain(
      "--focus-ring: 0 0 0 2px #131211, 0 0 0 4px #f4f1ec;",
    );
    expect(dark).toContain("--shadow-float:");
  });
});

describe("tokens.ts", () => {
  it("exposes the same values with types", () => {
    expect(tokens.color["surface-100"]).toEqual({
      light: "#faf8f4",
      dark: "#131211",
    });
    expect(tokens.color.night).toBe("#171615");
    expect(tokens.space["space-24"]).toBe("96px");
    expect(tokens.cssVar("ink")).toBe("var(--ink)");
    const name: tokens.ColorToken = "rav-dyb";
    expect(tokens.color[name]).toBe("#ab7a4f");
  });
});
