// The DictationPill in Handy's overlay window (DESK-24, DESK-55, spec 6.17):
// Lytter with a level meter and the time, Renskriver, then the end state
// from wt-pill-end. The backend hides the window 1.5 s after the end. The
// pill is a live region, so screen readers hear every state.
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { DictationPill, type DictationPillState } from "@walkietalkey/ui";
import "@walkietalkey/ui/styles.css";
import "./pill.css";
import { commands } from "@/bindings";
import { syncLanguageFromSettings } from "@/i18n";
import type { ModelStateEvent } from "@/lib/types/events";
import { pillStateFromEnd } from "../lib/helpers";
import { useTauriEvent } from "../lib/hooks";
import type { PillCountdownEvent, PillEndEvent } from "../lib/types";

type OverlayState = "recording" | "streaming" | "transcribing" | "processing";

export function PillOverlay() {
  const { t } = useTranslation();
  const [visible, setVisible] = useState(false);
  const [state, setState] = useState<DictationPillState>("listening");
  const [pasteKey, setPasteKey] = useState("⌘V");
  const [seconds, setSeconds] = useState(0);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [capturing, setCapturing] = useState(false);
  const [level, setLevel] = useState(0);
  const [modelLoading, setModelLoading] = useState(false);
  const smoothed = useRef(0);
  const showToken = useRef(0);

  useTauriEvent<OverlayState>("show-overlay", (overlay) => {
    const token = ++showToken.current;
    const listening = overlay === "recording" || overlay === "streaming";
    if (listening) {
      setSeconds(0);
      setCountdown(null);
      setCapturing(false);
      smoothed.current = 0;
      setLevel(0);
    }
    setState(listening ? "listening" : "processing");
    void (async () => {
      // "Vis aldrig" (DESK-55).
      let hidden = false;
      try {
        hidden = (await commands.wtGetSettings()).settings.pill_hidden;
      } catch {
        hidden = false;
      }
      if (token !== showToken.current) return;
      setVisible(!hidden);
      void syncLanguageFromSettings();
    })();
  });
  useTauriEvent("hide-overlay", () => {
    showToken.current++;
    setVisible(false);
    setCapturing(false);
  });
  useTauriEvent("recording-ready", () => {
    setSeconds(0);
    setCapturing(true);
  });
  useTauriEvent<number[]>("mic-level", (levels) => {
    const values = Array.isArray(levels) ? levels.slice(0, 9) : [];
    const avg = values.length
      ? values.reduce((a, b) => a + (b || 0), 0) / values.length
      : 0;
    smoothed.current = smoothed.current * 0.6 + Math.min(1, avg) * 0.4;
    setLevel(smoothed.current);
  });
  useTauriEvent<PillCountdownEvent>("wt-pill-countdown", (e) =>
    setCountdown(e.seconds_left),
  );
  useTauriEvent<PillEndEvent>("wt-pill-end", (e) => {
    setCapturing(false);
    setCountdown(null);
    setPasteKey(e.shortcut || "⌘V");
    setState(pillStateFromEnd(e.state));
  });
  useTauriEvent<ModelStateEvent>("model-state-changed", (e) => {
    if (e.event_type === "loading_started") setModelLoading(true);
    else if (
      e.event_type === "loading_completed" ||
      e.event_type === "loading_failed"
    )
      setModelLoading(false);
  });

  // The time counts once the microphone delivers samples.
  useEffect(() => {
    if (!visible || state !== "listening" || !capturing) return;
    const id = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [visible, state, capturing]);

  if (!visible) return null;

  // Screen readers hear the countdown every 5 seconds, not every second.
  const spoken = countdown != null ? Math.ceil(countdown / 5) * 5 : null;
  const shown: DictationPillState =
    state === "processing" && modelLoading ? "notready" : state;
  const style = {
    "--wt-level": (0.35 + 0.65 * level).toFixed(2),
  } as CSSProperties;
  return (
    <div
      className="wt-pill-host"
      data-testid="pill"
      data-level={level.toFixed(2)}
      data-countdown={countdown != null || undefined}
      style={style}
    >
      <DictationPill
        state={shown}
        seconds={countdown ?? seconds}
        pasteKey={pasteKey}
        labels={{
          idleBefore: t("wt.pill.holdBefore"),
          idleAfter: t("wt.pill.holdAfter"),
          listening: t("wt.pill.listening"),
          processing: t("wt.pill.processing"),
          ready: t("wt.pill.ready"),
          pasted: t("wt.pill.pasted"),
          noSpeech: t("wt.pill.noSpeech"),
          raw: t("wt.pill.raw"),
          notReady: t("wt.pill.notReady"),
          error: t("wt.pill.error"),
        }}
      />
      {spoken != null ? (
        <span className="wt-visually-hidden" aria-live="polite">
          {t("wt.pill.countdown", { seconds: spoken })}
        </span>
      ) : null}
    </div>
  );
}
