import { describe, expect, it } from "vitest";
import {
  INSTALL_STEPS,
  installFlow,
  safariMajor,
  type InstallStep,
} from "../src/lib/install";

/* Run 6: the exact Safari steps for the visitor's iOS version (PHONE-04). Since iOS 26, Safari freezes the OS in its
   user agent at 18.x and reports its own version, which matches iOS, in Version/NN (WebKit bugs 298260, 298473). */
const ua = (os: string, version: string) =>
  `Mozilla/5.0 (iPhone; CPU iPhone OS ${os} like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/${version} Mobile/15E148 Safari/604.1`;
const IOS26 = ua("18_6", "26.0");
const IOS26_2 = ua("18_7", "26.2");
const IOS27 = ua("18_7", "27.0");
const IOS18 = ua("18_6", "18.6");
const IOS17 = ua("17_5", "17.5");
const CHROME_IOS =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0.7390.41 Mobile/15E148 Safari/604.1";
const IPAD_DESKTOP_CLASS =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15";

describe("Safari's version (run 6)", () => {
  it("reads Safari's own version, not the frozen OS version", () => {
    expect(safariMajor(IOS26)).toBe(26);
    expect(safariMajor(IOS26_2)).toBe(26);
    expect(safariMajor(IOS27)).toBe(27);
    expect(safariMajor(IOS18)).toBe(18);
    expect(safariMajor(IPAD_DESKTOP_CLASS)).toBe(26);
  });
  it("has no Safari version in another browser", () => {
    expect(safariMajor(CHROME_IOS)).toBeNull();
  });
});

describe("which steps (run 6)", () => {
  it("iOS 26 and newer: the compact tab bar hides Share behind •••", () => {
    expect(installFlow(IOS26)).toEqual({ flow: "compact", safari: true });
    expect(installFlow(IOS27)).toEqual({ flow: "compact", safari: true });
    expect(installFlow(IPAD_DESKTOP_CLASS).flow).toBe("compact");
  });
  it("older iOS: Share is in the toolbar", () => {
    expect(installFlow(IOS18)).toEqual({ flow: "classic", safari: true });
    expect(installFlow(IOS17)).toEqual({ flow: "classic", safari: true });
  });
  it("another browser is sent to Safari, with the steps for its iOS", () => {
    expect(installFlow(CHROME_IOS)).toEqual({ flow: "compact", safari: false });
  });
});

describe("the steps (run 6)", () => {
  const ids = (steps: InstallStep[]) => steps.map((s) => s.id);
  it("iOS 26: ••• › Del › Vis mere › Føj til hjemmeskærm › Tilføj", () => {
    expect(ids(INSTALL_STEPS.compact)).toEqual([
      "more",
      "share",
      "viewMore",
      "addToHome",
      "add",
    ]);
  });
  it("older iOS: Del › Føj til hjemmeskærm › Tilføj", () => {
    expect(ids(INSTALL_STEPS.classic)).toEqual(["share", "addToHome", "add"]);
  });
  it("names each button as Danish and English iOS do", () => {
    const share = INSTALL_STEPS.classic.find((s) => s.id === "share")!;
    expect(share.da).toBe("Del");
    expect(share.en).toBe("Share");
    const add = INSTALL_STEPS.classic.find((s) => s.id === "addToHome")!;
    expect(add.da).toBe("Føj til hjemmeskærm");
    expect(add.en).toBe("Add to Home Screen");
    const more = INSTALL_STEPS.compact.find((s) => s.id === "viewMore")!;
    expect(more.en).toBe("View More");
    for (const s of [...INSTALL_STEPS.compact, ...INSTALL_STEPS.classic]) {
      expect(s.text.length, s.id).toBeGreaterThan(5);
      expect(s.text, s.id).not.toMatch(/[—!]/);
    }
  });
});
