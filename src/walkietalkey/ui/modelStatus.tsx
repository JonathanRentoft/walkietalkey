// The speech model's download as one calm line (run 2, Phase 3): the
// LogoLoader `fyld` with the percentage while it downloads, a quiet "ready"
// when it is in place, and "Prøv igen" when it failed. Never a blocking step.
import { useTranslation } from "react-i18next";
import { LogoLoader } from "@walkietalkey/ui";
import { useModelSetup } from "../onboarding/modelSetup";
import { Button } from "./controls";

export function ModelStatusLine(props: {
  /** Hide "Talemodellen er klar" (the line disappears once ready). */
  hideReady?: boolean;
  className?: string;
}) {
  const { t } = useTranslation();
  const phase = useModelSetup((s) => s.phase);
  const progress = useModelSetup((s) => s.progress);
  const retry = useModelSetup((s) => s.retry);
  if (phase === "idle" || (phase === "ready" && props.hideReady)) return null;
  const pct = Math.round(progress * 100);
  return (
    <div
      className={["wt-model-line", props.className].filter(Boolean).join(" ")}
      data-phase={phase}
      role="status"
      aria-live="polite"
    >
      {phase === "downloading" ? (
        <>
          <LogoLoader
            variant="fyld"
            size={22}
            progress={progress}
            label={t("wt.model.downloading")}
          />
          <span>{t("wt.model.downloading")}</span>
          <span className="wt-model-pct">{pct} %</span>
        </>
      ) : phase === "preparing" ? (
        <>
          <LogoLoader
            variant="smelt"
            size={22}
            label={t("wt.model.preparing")}
          />
          <span>{t("wt.model.preparing")}</span>
        </>
      ) : phase === "ready" ? (
        <>
          <span className="wt-model-ok" aria-hidden>
            <svg width={12} height={12} viewBox="0 0 12 12" focusable="false">
              <path
                d="M2.5 6.2 4.9 8.6 9.5 3.6"
                fill="none"
                stroke="currentColor"
                strokeWidth={1.8}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </span>
          <span>{t("wt.model.ready")}</span>
        </>
      ) : (
        <>
          <span>{t("wt.model.downloadFailed")}</span>
          <Button variant="quiet" onClick={() => void retry()}>
            {t("wt.common.retry")}
          </Button>
        </>
      )}
    </div>
  );
}
