/** Haptics (PHONE-27) and the screen wake lock (PHONE-28). */
import { shellHandler } from "./platform";

/**
 * A short tick when recording starts and stops. In the iOS shell the native side does it
 * (`window.webkit.messageHandlers.haptics.postMessage("start" | "stop")`); on Android the
 * vibration API. iOS Safari offers neither, so nothing happens there.
 */
export function haptic(kind: "start" | "stop"): void {
  const shell = shellHandler("haptics");
  if (shell) {
    try {
      shell.postMessage(kind);
    } catch {
      /* the shell went away */
    }
    return;
  }
  if (
    typeof navigator !== "undefined" &&
    typeof navigator.vibrate === "function"
  ) {
    try {
      navigator.vibrate(kind === "start" ? 15 : 10);
    } catch {
      /* not allowed without a gesture */
    }
  }
}

interface Sentinel {
  release(): Promise<void>;
  addEventListener(type: "release", fn: () => void): void;
}

/** Keeps the screen on while recording, where the Screen Wake Lock API exists. */
export class ScreenWake {
  private sentinel: Sentinel | null = null;
  private wanted = false;
  private pending = false;

  acquire(): void {
    this.wanted = true;
    void this.request();
  }

  release(): void {
    this.wanted = false;
    const s = this.sentinel;
    this.sentinel = null;
    void s?.release().catch(() => undefined);
  }

  /** The system drops the lock when the page is hidden; take it again when it comes back. */
  visible(): void {
    if (this.wanted && !this.sentinel) void this.request();
  }

  get held(): boolean {
    return this.sentinel !== null;
  }

  private async request(): Promise<void> {
    const wl = (
      navigator as Navigator & {
        wakeLock?: { request(type: "screen"): Promise<Sentinel> };
      }
    ).wakeLock;
    if (!wl || this.pending || this.sentinel) return;
    this.pending = true;
    try {
      const s = await wl.request("screen");
      if (!this.wanted) {
        void s.release().catch(() => undefined);
        return;
      }
      this.sentinel = s;
      s.addEventListener("release", () => {
        if (this.sentinel === s) this.sentinel = null;
      });
    } catch {
      /* not allowed (battery saver, hidden page) */
    } finally {
      this.pending = false;
    }
  }
}
