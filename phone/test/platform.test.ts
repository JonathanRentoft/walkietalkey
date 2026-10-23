import { describe, expect, it } from "vitest";
import {
  detectPlatform,
  isIosSafariTab,
  platformTag,
  type Env,
} from "../src/lib/platform";

const IPHONE_SAFARI =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1";
const IPHONE_CHROME =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0.7390.41 Mobile/15E148 Safari/604.1";
const IPAD_DESKTOP_CLASS =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15";
const ANDROID_CHROME =
  "Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36";
const MAC_CHROME =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

function env(over: Partial<Env>): Env {
  return {
    userAgent: IPHONE_SAFARI,
    maxTouchPoints: 5,
    navigatorStandalone: false,
    displayModeStandalone: false,
    protocol: "https:",
    shellBridge: false,
    ...over,
  };
}

describe("Safari tab detection (PHONE-04)", () => {
  it("an iPhone Safari tab must install the app first", () => {
    const p = detectPlatform(env({}));
    expect(p.os).toBe("ios");
    expect(p.device).toBe("iPhone");
    expect(isIosSafariTab(p)).toBe(true);
  });

  it("other iOS browsers' tabs count as tabs too", () => {
    expect(
      isIosSafariTab(detectPlatform(env({ userAgent: IPHONE_CHROME }))),
    ).toBe(true);
  });

  it("the home-screen app is not a tab (navigator.standalone or display-mode)", () => {
    expect(
      isIosSafariTab(detectPlatform(env({ navigatorStandalone: true }))),
    ).toBe(false);
    expect(
      isIosSafariTab(detectPlatform(env({ displayModeStandalone: true }))),
    ).toBe(false);
  });

  it("iPadOS with a desktop-class user agent is iOS", () => {
    const p = detectPlatform(
      env({ userAgent: IPAD_DESKTOP_CLASS, maxTouchPoints: 5 }),
    );
    expect(p.os).toBe("ios");
    expect(p.device).toBe("iPad");
    expect(isIosSafariTab(p)).toBe(true);
  });

  it("a Mac is not iOS", () => {
    const p = detectPlatform(
      env({ userAgent: IPAD_DESKTOP_CLASS, maxTouchPoints: 0 }),
    );
    expect(p.os).toBe("other");
    expect(isIosSafariTab(p)).toBe(false);
  });

  it("the iOS shell is never a tab: custom URL scheme, haptics bridge or user agent marker", () => {
    for (const e of [
      env({ protocol: "walkietalkey:" }),
      env({ shellBridge: true }),
      env({ userAgent: IPHONE_SAFARI + " WalkieTalkeyIOS/1.0" }),
    ]) {
      const p = detectPlatform(e);
      expect(p.shell).toBe(true);
      expect(p.os).toBe("ios");
      expect(isIosSafariTab(p)).toBe(false);
    }
  });

  it("Android Chrome works in a tab", () => {
    const p = detectPlatform(env({ userAgent: ANDROID_CHROME }));
    expect(p.os).toBe("android");
    expect(p.device).toBe("Android");
    expect(isIosSafariTab(p)).toBe(false);
  });

  it("prefills the phone name and platform tag (PHONE-12)", () => {
    expect(detectPlatform(env({})).device).toBe("iPhone");
    expect(detectPlatform(env({ userAgent: ANDROID_CHROME })).device).toBe(
      "Android",
    );
    expect(platformTag(detectPlatform(env({})))).toBe("ios");
    expect(
      platformTag(detectPlatform(env({ userAgent: ANDROID_CHROME }))),
    ).toBe("android");
    expect(
      platformTag(
        detectPlatform(env({ userAgent: MAC_CHROME, maxTouchPoints: 0 })),
      ),
    ).toBe("web");
  });
});
