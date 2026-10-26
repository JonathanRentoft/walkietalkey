import { describe, expect, it } from "vitest";
import { settingValue } from "../src/screens/Training";

describe("a config setting as the owner reads it", () => {
  it("says the default for a setting left empty, as the workbench reads it", () => {
    expect(settingValue(null)).toBe("standard");
    expect(settingValue(undefined)).toBe("standard");
  });

  it("writes numbers, yes and no, and lists in Danish", () => {
    expect(settingValue(0.15)).toBe("0,15");
    expect(settingValue(true)).toBe("ja");
    expect(settingValue(["self_attn", "ffn"])).toBe("self_attn, ffn");
  });
});
