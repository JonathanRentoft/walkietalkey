// The silent microphone in the window (DESK-59): "{input} giver ingen lyd.
// Prøv {navn}." with one button, "Brug {navn}", or plainly that no input
// gave sound, with "Tjek igen". It goes by itself once the selected input
// delivers sound, another input is chosen, or the button switches. Shown at
// the top of the window, and at the microphone setting under Avanceret.
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { commands } from "@/bindings";
import { micNotice } from "../lib/helpers";
import { useMicCheck } from "../lib/micCheck";
import { Button } from "./controls";

export function MicNotice(props: {
  variant: "banner" | "row";
  /** Shown while there is no notice (yet). */
  fallback?: ReactNode;
}) {
  const { t } = useTranslation();
  const check = useMicCheck();
  const [busy, setBusy] = useState(false);
  const notice = micNotice(check);
  if (!notice) return props.fallback ?? null;

  const switchTo = async (name: string) => {
    setBusy(true);
    try {
      const r = await commands.wtMicUse(name);
      if (r.status === "error") console.warn("Could not switch:", r.error);
    } catch (e) {
      console.warn("Could not switch:", e);
    } finally {
      setBusy(false);
    }
  };

  const text = t(notice.key, { name: notice.name, other: notice.other });
  const other = notice.other;
  const action = other ? (
    <Button
      variant="primary"
      disabled={busy}
      onClick={() => void switchTo(other)}
    >
      {t("wt.mic.use", { name: other })}
    </Button>
  ) : notice.key === "wt.mic.none" ? (
    <Button onClick={() => void commands.wtMicRecheck().catch(() => {})}>
      {t("wt.mic.recheck")}
    </Button>
  ) : null;

  if (props.variant === "row") {
    return (
      <div className="wt-row" data-testid="mic-notice">
        <div className="wt-row-text">
          <p className="wt-row-desc wt-row-desc--warn" role="status">
            {text}
          </p>
        </div>
        {action ? <div className="wt-row-control">{action}</div> : null}
      </div>
    );
  }
  return (
    <div
      className="wt-banner wt-banner--access"
      role="status"
      data-testid="mic-notice"
    >
      <div className="wt-banner-text">
        <p>{text}</p>
      </div>
      {action}
    </div>
  );
}
