import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { errorText, S } from "../src/strings";

/** Every string in S, with each function called on sample arguments. */
function collect(node: unknown, path: string, out: [string, string][]) {
  if (typeof node === "string") out.push([path, node]);
  else if (typeof node === "function") {
    const args = Array.from({ length: node.length }, (_, i) => `x${i}`);
    out.push([path, String((node as (...a: string[]) => unknown)(...args))]);
  } else if (node && typeof node === "object")
    for (const [k, v] of Object.entries(node)) collect(v, `${path}.${k}`, out);
}

describe("strings", () => {
  const all: [string, string][] = [];
  collect(S, "S", all);

  it("has the strings", () => {
    expect(all.length).toBeGreaterThan(200);
  });

  it("never has an em dash (or an en dash)", () => {
    const bad = all.filter(([, s]) => /[—–]/.test(s));
    expect(bad).toEqual([]);
  });

  it("has no em dash in the source either", () => {
    const src = readFileSync(join(process.cwd(), "src/strings.ts"), "utf8");
    expect(src).not.toMatch(/—/);
  });

  it("carries no marker for run 9's drafts, which the owner approved in run 11", () => {
    const src = readFileSync(join(process.cwd(), "src/strings.ts"), "utf8");
    expect(src).not.toMatch(/drafted in run 9/);
    expect(src.split("\n")[0]).not.toMatch(/TODO\(copy\)/);
  });

  it("has no empty string and no trailing space", () => {
    expect(all.filter(([, s]) => !s.trim() || s !== s.trim())).toEqual([]);
  });

  it("has Danish text for every error code API.md lists", () => {
    const codes = [
      "forbidden",
      "json",
      "too-long",
      "not-found",
      "unknown",
      "no-share",
      "bad-setup",
      "no-pick",
      "busy",
      "paused",
      "mac-not-ready",
      "config",
      "no-configs",
      "not-running",
      "tracking-off",
      "no-folder",
      "not-comparable",
      "report-failed",
      "version",
      "use-failed",
      "text",
      "exists",
      "no-vscode",
    ];
    expect(codes.filter((c) => !S.errors[c])).toEqual([]);
    expect(errorText("busy", "training")).toBe(
      "Der kører allerede en træning.",
    );
    expect(errorText("busy", "recording")).toBe(
      "Vent, til optagelsen er færdig.",
    );
    expect(errorText("no-pick", "recording")).toBe(S.errors["no-pick"]);
  });

  it("names every error code of the contract and falls back", () => {
    for (const code of [
      "unknown",
      "no-share",
      "bad-setup",
      "busy",
      "exists",
      "network",
    ])
      expect(errorText(code)).not.toBe(S.errors.generic);
    expect(errorText("something-new")).toBe(S.errors.generic);
    expect(errorText(null)).toBe(S.errors.generic);
  });
});
