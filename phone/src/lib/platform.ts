/** Where the app runs: iOS Safari tab, iOS home-screen app, the iOS shell, Android (PHONE-02..04). */

export interface Env {
  userAgent: string;
  maxTouchPoints: number;
  /** iOS Safari's navigator.standalone (true in a home-screen app). */
  navigatorStandalone?: boolean;
  /** matchMedia("(display-mode: standalone)") or fullscreen. */
  displayModeStandalone: boolean;
  /** location.protocol; the iOS shell serves the bundled files through a custom scheme. */
  protocol: string;
  /** window.webkit.messageHandlers.haptics exists (registered by the iOS shell). */
  shellBridge: boolean;
}

export interface Platform {
  os: "ios" | "android" | "other";
  /** Installed to the home screen (or the iOS shell). */
  standalone: boolean;
  /** The native iOS shell (PHONE-03). */
  shell: boolean;
  /** Prefill for the phone's name (PHONE-12). */
  device: "iPhone" | "iPad" | "Android" | "Telefon";
}

/** The shell may also add this to WKWebView's applicationNameForUserAgent. */
export const SHELL_UA_MARKER = "WalkieTalkeyIOS";

export function detectPlatform(env: Env): Platform {
  const ua = env.userAgent;
  const shell =
    (env.protocol !== "http:" && env.protocol !== "https:") ||
    env.shellBridge ||
    ua.includes(SHELL_UA_MARKER);
  const iphone = /iPhone|iPod/.test(ua);
  const ipad =
    /iPad/.test(ua) || (/Macintosh/.test(ua) && env.maxTouchPoints > 1);
  const android = /Android/i.test(ua);
  const os: Platform["os"] =
    shell || iphone || ipad ? "ios" : android ? "android" : "other";
  const standalone =
    shell || env.navigatorStandalone === true || env.displayModeStandalone;
  const device: Platform["device"] =
    os === "ios"
      ? ipad && !iphone
        ? "iPad"
        : "iPhone"
      : os === "android"
        ? "Android"
        : "Telefon";
  return { os, standalone, shell, device };
}

/** PHONE-04: iPhone users must use the installed app, not a browser tab. */
export function isIosSafariTab(p: Platform): boolean {
  return p.os === "ios" && !p.standalone && !p.shell;
}

/** device_info platform (PROTOCOL.md 8.2). */
export function platformTag(p: Platform): "ios" | "android" | "web" {
  return p.os === "other" ? "web" : p.os;
}

interface WebkitWindow {
  webkit?: {
    messageHandlers?: Record<
      string,
      { postMessage(message: unknown): void } | undefined
    >;
  };
}

export function shellHandler(
  name: string,
): { postMessage(message: unknown): void } | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as unknown as WebkitWindow).webkit?.messageHandlers?.[name];
}

export function readEnv(): Env {
  const nav = navigator as Navigator & { standalone?: boolean };
  const mm = (q: string) =>
    typeof matchMedia === "function" && matchMedia(q).matches;
  return {
    userAgent: nav.userAgent,
    maxTouchPoints: nav.maxTouchPoints || 0,
    navigatorStandalone: nav.standalone,
    displayModeStandalone:
      mm("(display-mode: standalone)") || mm("(display-mode: fullscreen)"),
    protocol: location.protocol,
    shellBridge: !!shellHandler("haptics"),
  };
}
