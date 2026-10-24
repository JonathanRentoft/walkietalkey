// "Ret det for mig" (run 2, Phase 1): while fn is the dictation key, macOS
// may still give the Globe key its own action when fn is tapped (switch
// input source, emoji, Apple's dictation). If so, one plain sentence and one
// button that sets it to "Do Nothing" for the user; it applies at once, so
// nothing is said about logging out. Shown in Prøv det and under Tast.
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { commands, type GlobeKeyStatus } from "@/bindings";
import { useSettingsStore } from "@/stores/settingsStore";
import { globeUsageKey, type WtPlatform } from "../lib/helpers";
import { Button, Status } from "./controls";
import { DICTATION_BINDING } from "./keys";

export function useGlobeKey(platform: WtPlatform) {
  const binding = useSettingsStore(
    (s) => s.settings?.bindings?.[DICTATION_BINDING]?.current_binding,
  );
  const [status, setStatus] = useState<GlobeKeyStatus | null>(null);
  useEffect(() => {
    if (platform !== "macos") return;
    let stale = false;
    commands
      .wtGlobeKeyStatus()
      .then((s) => {
        if (!stale) setStatus(s);
      })
      .catch(() => {
        if (!stale) setStatus(null);
      });
    return () => {
      stale = true;
    };
  }, [platform, binding]);
  return [status, setStatus] as const;
}

export function GlobeFix(props: {
  platform: WtPlatform;
  /** How the row is drawn: a block in onboarding, a settings row. */
  variant: "block" | "row";
  title?: string;
}) {
  const { t } = useTranslation();
  const [status, setStatus] = useGlobeKey(props.platform);
  const [fixed, setFixed] = useState(false);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);

  if (props.platform !== "macos") return null;
  if (fixed)
    return (
      <div className={`wt-globe wt-globe--${props.variant}`}>
        <Status tone="ok">{t("wt.globe.fixed")}</Status>
      </div>
    );
  if (!status?.needs_fix) return null;

  const fix = async () => {
    setBusy(true);
    setFailed(false);
    try {
      const next = await commands.wtGlobeKeyFix();
      setStatus(next);
      if (next.needs_fix) setFailed(true);
      else setFixed(true);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className={`wt-globe wt-globe--${props.variant}`}
      data-testid="globe-fix"
    >
      <div className="wt-globe-text">
        {props.title ? (
          <span className="wt-row-title">{props.title}</span>
        ) : null}
        <p>{t(globeUsageKey(status.usage))}</p>
        {failed ? <Status tone="warn">{t("wt.globe.failed")}</Status> : null}
      </div>
      <Button disabled={busy} onClick={() => void fix()}>
        {t("wt.globe.fix")}
      </Button>
    </div>
  );
}
