// The operating system around the app: platform, permissions, System
// Settings pages, restarting. Every call fails soft, so a missing plugin or
// permission never breaks a screen.
import { platform as osPlatform } from "@tauri-apps/plugin-os";
import { openUrl } from "@tauri-apps/plugin-opener";
import { relaunch } from "@tauri-apps/plugin-process";
import {
  checkAccessibilityPermission,
  checkInputMonitoringPermission,
  checkMicrophonePermission,
  requestAccessibilityPermission,
  requestInputMonitoringPermission,
  requestMicrophonePermission,
} from "tauri-plugin-macos-permissions-api";
import { commands } from "@/bindings";
import type { WtPlatform } from "./helpers";

export function currentPlatform(): WtPlatform {
  try {
    const p = osPlatform();
    return p === "macos" || p === "windows" ? p : "other";
  } catch {
    return "other";
  }
}

/** The key that pastes: "⌘V" on a Mac, "Ctrl+V" elsewhere (DESK-51). */
export function pasteKey(platform: WtPlatform): string {
  return platform === "macos" ? "⌘V" : "Ctrl+V";
}

/** System Settings pages (macOS 13 and newer understand these URLs). */
export const SETTINGS_PAGES = {
  inputMonitoring:
    "x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent",
  accessibility:
    "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
  microphone:
    "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
  keyboard: "x-apple.systempreferences:com.apple.Keyboard-Settings.extension",
  notifications: "x-apple.systempreferences:com.apple.Notifications-Settings.extension",
} as const;

export async function openSettingsPage(page: keyof typeof SETTINGS_PAGES) {
  try {
    await openUrl(SETTINGS_PAGES[page]);
  } catch (e) {
    console.warn(`Could not open System Settings (${page}):`, e);
  }
}

export async function openLink(url: string) {
  try {
    await openUrl(url);
  } catch (e) {
    console.warn("Could not open link:", e);
  }
}

export type MacPermission = "microphone" | "accessibility" | "inputMonitoring";

const CHECKS: Record<MacPermission, () => Promise<boolean>> = {
  microphone: checkMicrophonePermission,
  accessibility: checkAccessibilityPermission,
  inputMonitoring: checkInputMonitoringPermission,
};
const REQUESTS: Record<MacPermission, () => Promise<unknown>> = {
  microphone: requestMicrophonePermission,
  accessibility: requestAccessibilityPermission,
  inputMonitoring: requestInputMonitoringPermission,
};

export async function hasPermission(p: MacPermission): Promise<boolean> {
  try {
    return await CHECKS[p]();
  } catch {
    return false;
  }
}

export async function requestPermission(p: MacPermission): Promise<boolean> {
  try {
    await REQUESTS[p]();
  } catch (e) {
    console.warn(`Permission request failed (${p}):`, e);
  }
  return hasPermission(p);
}

/** Windows: whether the privacy settings let desktop apps use the microphone. */
export async function windowsMicrophoneAllowed(): Promise<boolean> {
  try {
    const status = await commands.getWindowsMicrophonePermissionStatus();
    return !status.supported || status.overall_access !== "denied";
  } catch {
    return true;
  }
}

export type NotificationPermission =
  | "granted"
  | "denied"
  | "not_determined"
  | "unavailable";

/** DESK-15. "unavailable" outside a bundled app, where notifications show
 *  inside the app window instead. */
export async function notificationPermission(): Promise<NotificationPermission> {
  try {
    const state = await commands.wtNotificationPermission();
    return state === "granted" || state === "denied" || state === "not_determined"
      ? state
      : "unavailable";
  } catch {
    return "unavailable";
  }
}

export async function requestNotificationPermission(): Promise<boolean> {
  try {
    return await commands.wtRequestNotificationPermission();
  } catch {
    return false;
  }
}

export async function restartApp() {
  try {
    await relaunch();
  } catch (e) {
    console.error("Could not restart:", e);
  }
}
