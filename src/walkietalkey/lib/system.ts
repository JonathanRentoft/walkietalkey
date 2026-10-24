// The operating system around the app: platform, permissions and System
// Settings pages. Every call fails soft, so a missing plugin or permission
// never breaks a screen.
import { platform as osPlatform } from "@tauri-apps/plugin-os";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  checkAccessibilityPermission,
  checkMicrophonePermission,
  requestAccessibilityPermission,
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

/** System Settings pages (macOS 13 and newer understand these URLs). Run 2
 *  asks for no Input Monitoring: Accessibility covers the key. */
export const SETTINGS_PAGES = {
  accessibility:
    "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
  microphone:
    "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
  keyboard: "x-apple.systempreferences:com.apple.Keyboard-Settings.extension",
  notifications:
    "x-apple.systempreferences:com.apple.Notifications-Settings.extension",
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

export type MacPermission = "microphone" | "accessibility";

const CHECKS: Record<MacPermission, () => Promise<boolean>> = {
  microphone: checkMicrophonePermission,
  accessibility: checkAccessibilityPermission,
};
const REQUESTS: Record<MacPermission, () => Promise<unknown>> = {
  microphone: requestMicrophonePermission,
  accessibility: requestAccessibilityPermission,
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

/** Tilgængelighed (run 2): one button. Asking first puts WalkieTalkey in
 *  the list, so the pane that opens has its switch ready; the app notices
 *  the grant by itself (usePermission). */
export async function openAccessibilityPane() {
  await requestPermission("accessibility");
  await openSettingsPage("accessibility");
}

/** Every Accessibility button (DESK-13): an ad-hoc build that was rebuilt or
 *  reinstalled can show WalkieTalkey switched on in System Settings while
 *  macOS does not trust it, and that switch then does nothing. The backend
 *  resets only WalkieTalkey's own entry and shows macOS's dialog (a no-op
 *  when the app is trusted), so the pane that opens has a switch that works. */
export async function repairAccessibilityAndOpenPane() {
  try {
    await commands.wtAccessibilityRepair();
    await openSettingsPage("accessibility");
  } catch {
    // A backend without the repair: the pane alone.
    await openAccessibilityPane();
  }
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
  "granted" | "denied" | "not_determined" | "unavailable";

/** DESK-15. "unavailable" outside a bundled app, where notifications show
 *  inside the app window instead. */
export async function notificationPermission(): Promise<NotificationPermission> {
  try {
    const state = await commands.wtNotificationPermission();
    return state === "granted" ||
      state === "denied" ||
      state === "not_determined"
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

/** Phone dictations arrive with a notification (DESK-15, DESK-56). Run 2 asks
 *  when the user pairs a phone, where the reason is plain, instead of in a
 *  step of its own. */
let notificationsAsked: Promise<void> | null = null;
export function askForNotifications(): Promise<void> {
  notificationsAsked ??= (async () => {
    if ((await notificationPermission()) === "not_determined")
      await requestNotificationPermission();
  })();
  return notificationsAsked;
}
