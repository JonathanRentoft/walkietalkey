// The DictationPill in Handy's overlay window (DESK-24, DESK-55, DESK-58,
// spec 6.17): the mark and a live waveform from `mic-level` while listening
// (Lytter), a lock and "Tryk igen for at stoppe" when the key was tapped
// (hands-free, `wt-pill-handsfree`), Renskriver, then the end state from
// wt-pill-end. The backend sends the same events for key and phone
// dictations, and hides the window 1.5 s after the end. The pill is a live
// region, so screen readers hear every state. A key dictation on an input
// that gives no sound says so while it records (`wt-mic-silent`) and ends
// with "Mikrofonen giver ingen lyd", then the probe's "Prøv {navn}"
// (`wt-mic-check`, DESK-59).
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { DictationPill, type DictationPillState } from "@walkietalkey/ui";
import "@walkietalkey/ui/styles.css";
import "./pill.css";
import { commands } from "@/bindings";
import { syncLanguageFromSettings } from "@/i18n";
import type { ModelStateEvent } from "@/lib/types/events";
import {
  micPillHint,
  pillStateFromEnd,
  smoothLevels,
  WAVE_FLOOR,
  waveLevels,
} from "../lib/helpers";
import { useTauriEvent } from "../lib/hooks";
import type {
  MicCheck,
  MicSilentEvent,
  PillCountdownEvent,
  PillEndEvent,
} from "../lib/types";

type OverlayState = "recording" | "streaming" | "transcribing" | "processing";

/** Bars in the waveform: wider when it has the pill to itself. */
const BARS = 15;
const BARS_HANDS_FREE = 11;
const silence = (n: number) => Array<number>(n).fill(WAVE_FLOOR);

export function PillOverlay() {
  const { t } = useTranslation();
  const [visible, setVisible] = useState(false);
  const [state, setState] = useState<DictationPillState>("listening");
  const [pasteKey, setPasteKey] = useState("⌘V");
  const [seconds, setSeconds] = useState(0);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [capturing, setCapturing] = useState(false);
  const [handsFree, setHandsFree] = useState(false);
  const [wave, setWave] = useState<number[]>(() => silence(BARS));
  const [level, setLevel] = useState(0);
  const [modelLoading, setModelLoading] = useState(false);
  const [micSilent, setMicSilent] = useState(false);
  const [micCheck, setMicCheck] = useState<MicCheck | null>(null);
  const showToken = useRef(0);
  const hostRef = useRef<HTMLDivElement>(null);
  const bars = handsFree ? BARS_HANDS_FREE : BARS;

  // Run 4: the window lets clicks through except over the pill, so the
  // backend needs to know where the pill is (walkietalkey::pill_window).
  useEffect(() => {
    const pill = hostRef.current?.querySelector<HTMLElement>(".wt-pill");
    if (!visible || !pill) return;
    const report = () => {
      const r = pill.getBoundingClientRect();
      commands
        .wtPillRect({ x: r.x, y: r.y, width: r.width, height: r.height })
        .catch(() => {});
    };
    report();
    const observer = new ResizeObserver(report);
    observer.observe(pill);
    return () => observer.disconnect();
  }, [visible]);

  const resetWave = (n: number) => {
    setWave(silence(n));
    setLevel(0);
  };

  useTauriEvent<OverlayState>("show-overlay", (overlay) => {
    const token = ++showToken.current;
    const listening = overlay === "recording" || overlay === "streaming";
    if (listening && state !== "listening") {
      // A new dictation.
      setSeconds(0);
      setCountdown(null);
      setCapturing(false);
      setHandsFree(false);
      setMicSilent(false);
      setMicCheck(null);
      resetWave(BARS);
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
    setHandsFree(false);
    setMicSilent(false);
    // The next show starts a new dictation.
    setState("processing");
  });
  useTauriEvent("recording-ready", () => {
    setSeconds(0);
    setCapturing(true);
  });
  // Tapped instead of held: it records until the next tap (Phase 1).
  useTauriEvent<boolean>("wt-pill-handsfree", (on) => {
    const next = on !== false;
    setHandsFree(next);
    resetWave(next ? BARS_HANDS_FREE : BARS);
  });
  useTauriEvent<number[]>("mic-level", (levels) => {
    const values = Array.isArray(levels) ? levels : [];
    const avg = values.length
      ? values.reduce((a, b) => a + (b || 0), 0) / values.length
      : 0;
    setLevel(Math.min(1, avg));
    setWave((previous) =>
      smoothLevels(
        previous.length === bars ? previous : silence(bars),
        waveLevels(values, bars),
      ),
    );
  });
  useTauriEvent<PillCountdownEvent>("wt-pill-countdown", (e) =>
    setCountdown(e.seconds_left),
  );
  useTauriEvent<PillEndEvent>("wt-pill-end", (e) => {
    setCapturing(false);
    setCountdown(null);
    setHandsFree(false);
    setMicSilent(false);
    // Only the probe that follows this end counts (DESK-59).
    setMicCheck(null);
    setPasteKey(e.shortcut || "⌘V");
    setState(pillStateFromEnd(e.state));
  });
  // DESK-59: the input has given no sound for 1.5 s, or sound came.
  useTauriEvent<MicSilentEvent>("wt-mic-silent", (e) =>
    setMicSilent(!!e?.silent),
  );
  useTauriEvent<MicCheck>("wt-mic-check", (c) => setMicCheck(c));
  // The key was held but no model can transcribe yet (Appendix A).
  useTauriEvent("wt-pill-not-ready", () => setState("notready"));
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

  // Screen readers hear the countdown every 5 seconds, not every second.
  const spoken = countdown != null ? Math.ceil(countdown / 5) * 5 : null;
  const shown: DictationPillState =
    state === "processing" && modelLoading ? "notready" : state;
  const labels = {
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
    handsFree: t("wt.pill.handsFree"),
    micSilent: t("wt.pill.micSilent"),
  };
  const silentMic = shown === "listening" && micSilent;
  const hintKey = shown === "micsilent" ? micPillHint(micCheck) : null;
  const hint = hintKey ? t(hintKey.key, { name: hintKey.name }) : undefined;
  const announcement =
    spoken != null
      ? t("wt.pill.countdown", { seconds: spoken })
      : silentMic
        ? `${labels.listening}. ${labels.micSilent}`
        : shown === "listening" && handsFree
          ? `${labels.listening}. ${labels.handsFree}`
          : shown === "micsilent" && hint
            ? `${labels.micSilent}. ${hint}`
            : announcementFor(shown, labels, pasteKey);

  // The panel never takes focus, so VoiceOver gets a native announcement
  // as well as the live region (spec 6.17).
  useEffect(() => {
    if (!visible || !announcement) return;
    commands.wtAnnounce(announcement).catch(() => {});
  }, [visible, announcement]);

  if (!visible) return null;
  return (
    <div
      ref={hostRef}
      className="wt-pill-host"
      data-testid="pill"
      data-level={level.toFixed(2)}
      data-handsfree={(shown === "listening" && handsFree) || undefined}
      data-countdown={countdown != null || undefined}
      data-mic-silent={silentMic || undefined}
    >
      <DictationPill
        size="lg"
        mark
        state={shown}
        handsFree={handsFree}
        silentMic={silentMic}
        hint={hint}
        levels={wave}
        seconds={countdown ?? seconds}
        pasteKey={pasteKey}
        labels={labels}
      />
      {spoken != null ? (
        <span className="wt-visually-hidden" aria-live="polite">
          {t("wt.pill.countdown", { seconds: spoken })}
        </span>
      ) : null}
    </div>
  );
}

/** What a screen reader should hear for a pill state. */
function announcementFor(
  state: DictationPillState,
  labels: Record<string, string>,
  pasteKey: string,
): string {
  switch (state) {
    case "listening":
      return labels.listening;
    case "processing":
      return labels.processing;
    case "ready":
      return `${labels.ready} ${pasteKey}`;
    case "pasted":
      return labels.pasted;
    case "nospeech":
      return labels.noSpeech;
    case "raw":
      return labels.raw;
    case "notready":
      return labels.notReady;
    case "error":
      return labels.error;
    case "micsilent":
      return labels.micSilent;
    default:
      return "";
  }
}
