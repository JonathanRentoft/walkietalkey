// "macOS har glemt WalkieTalkeys adgang" (run 2): until the Mac app has a
// Developer ID, an update can silently drop the Accessibility grant (System
// Settings still shows it on, but the key is dead). The backend says so with
// `wt-accessibility-lost` at startup; the window may open after that, so a
// grant this window has seen before and that is gone now counts too. One
// sentence and one button; it disappears by itself once the key listener
// runs again (`wt-key-listener`) or the grant is back.
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { create } from "zustand";
import { commands } from "@/bindings";
import type { WtPlatform } from "../lib/helpers";
import { useTauriEvent } from "../lib/hooks";
import {
  hasPermission,
  openAccessibilityPane,
  openSettingsPage,
} from "../lib/system";
import { Button } from "./controls";

const SEEN_KEY = "wt.accessibilitySeen";

/** Remembers that Accessibility was granted on this computer. */
export function rememberAccessGranted() {
  try {
    localStorage.setItem(SEEN_KEY, "1");
  } catch {
    /* storage may be unavailable; the backend's event still works */
  }
}

function accessWasGranted(): boolean {
  try {
    return localStorage.getItem(SEEN_KEY) === "1";
  } catch {
    return false;
  }
}

/** Set by `wt-accessibility-lost`, which can arrive before any screen. */
export const useAccessLost = create<{
  lost: boolean;
  setLost: (lost: boolean) => void;
}>()((set) => ({
  lost: false,
  setLost: (lost) => set({ lost }),
}));

/** Listens for the backend's word, for the whole window's lifetime. */
export function useAccessLostEvents() {
  const setLost = useAccessLost((s) => s.setLost);
  useTauriEvent<boolean>("wt-accessibility-lost", (lost) =>
    setLost(lost !== false),
  );
  useTauriEvent<{ running: boolean }>("wt-key-listener", (e) => {
    if (e?.running) setLost(false);
  });
}

export function AccessNotice(props: { platform: WtPlatform }) {
  const { t } = useTranslation();
  const mac = props.platform === "macos";
  const lost = useAccessLost((s) => s.lost);
  const setLost = useAccessLost((s) => s.setLost);
  const [granted, setGranted] = useState<boolean | null>(null);
  const [asked, setAsked] = useState(false);

  // Check now, and keep checking while the notice shows.
  useEffect(() => {
    if (!mac) return;
    let stop = false;
    const check = async () => {
      const ok = await hasPermission("accessibility");
      if (stop) return;
      setGranted(ok);
      if (ok) {
        rememberAccessGranted();
        setLost(false);
      } else if (accessWasGranted()) {
        setLost(true);
      }
    };
    void check();
    const id = setInterval(check, 2000);
    return () => {
      stop = true;
      clearInterval(id);
    };
  }, [mac, setLost]);

  if (!mac || !lost || granted) return null;

  const repair = async () => {
    setAsked(true);
    try {
      await commands.wtAccessibilityRepair();
      await openSettingsPage("accessibility");
    } catch {
      // A backend without the repair: the pane alone.
      await openAccessibilityPane();
    }
  };

  return (
    <div className="wt-banner wt-banner--access" role="alert">
      <div className="wt-banner-text">
        <p>{t("wt.access.lost")}</p>
        {asked ? (
          <p className="wt-banner-sub">{t("wt.onboarding.waitingHint")}</p>
        ) : null}
      </div>
      <Button variant="primary" onClick={() => void repair()}>
        {t("wt.access.repair")}
      </Button>
    </div>
  );
}
