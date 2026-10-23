// First run (spec 6.2): one window, one step at a time. Every permission
// prompt is preceded by a Danish explanation.
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { GradientBackground, LogoLoader } from "@walkietalkey/ui";
import { useSettingsStore } from "@/stores/settingsStore";
import { useModelStore } from "@/stores/modelStore";
import {
  nextStep,
  onboardingSteps,
  previousStep,
  type OnboardingStepId,
  type WtPlatform,
} from "../lib/helpers";
import { useWtStore, useWtSettings } from "../lib/wtStore";
import { Button } from "../ui/controls";
import { useModelSetup } from "./modelSetup";
import {
  KeyStep,
  MicrophoneStep,
  ModelStep,
  NotificationsStep,
  PasteStep,
  PhoneStep,
  TryStep,
  WelcomeStep,
} from "./steps";

export function Onboarding(props: {
  platform: WtPlatform;
  initialStep: OnboardingStepId;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const wt = useWtSettings();
  const updateWt = useWtStore((s) => s.update);
  const steps = useMemo(
    () =>
      onboardingSteps(props.platform, {
        phonePairing: wt?.allow_phone_pairing ?? true,
      }),
    [props.platform, wt?.allow_phone_pairing],
  );
  const [step, setStep] = useState<OnboardingStepId>(props.initialStep);
  const heading = useRef<HTMLDivElement>(null);
  const setupStarted = useModelSetup((s) => s.phase !== "idle");
  const startSetup = useModelSetup((s) => s.start);

  // Once past the welcome, the model download runs whatever step is shown.
  useEffect(() => {
    if (step !== "welcome" && !setupStarted) void startSetup();
  }, [step, setupStarted, startSetup]);

  const go = async (to: OnboardingStepId | null) => {
    if (!to) return;
    setStep(to);
    // Remembered so a restart resumes here (DESK-13).
    await updateWt({ onboarding_resume_step: to });
  };

  // Move focus to the new step for keyboard and screen reader users.
  useEffect(() => {
    heading.current?.querySelector<HTMLElement>("h1")?.focus();
  }, [step]);

  const finish = async () => {
    // DESK-97: start at login, on by default after onboarding.
    await useSettingsStore.getState().updateSetting("autostart_enabled", true);
    const selected = useModelStore.getState().currentModel;
    const ready = useModelSetup.getState().phase === "ready";
    // Without a model yet, a restart comes back to the download.
    await updateWt({
      onboarding_resume_step: ready || selected ? null : "model",
    });
    props.onDone();
  };

  const next = () => void go(nextStep(steps, step));
  const back = previousStep(steps, step);
  const index = steps.indexOf(step);

  let content;
  switch (step) {
    case "welcome":
      content = <WelcomeStep onStart={next} />;
      break;
    case "model":
      content = <ModelStep onNext={next} />;
      break;
    case "microphone":
      content = <MicrophoneStep platform={props.platform} />;
      break;
    case "key":
      content = <KeyStep platform={props.platform} />;
      break;
    case "paste":
      content = <PasteStep platform={props.platform} onSkip={next} />;
      break;
    case "notifications":
      content = <NotificationsStep platform={props.platform} onSkip={next} />;
      break;
    case "phone":
      content = <PhoneStep onSkip={next} />;
      break;
    case "try":
      content = <TryStep platform={props.platform} />;
      break;
  }

  const showFooter = step !== "welcome";
  return (
    <GradientBackground palette="morgengry" className="wt-onb-bg" noise={0.6}>
      <main className="wt-onb" aria-label={t("wt.onboarding.label")}>
        {step !== "welcome" ? (
          <ol
            className="wt-onb-progress"
            aria-label={t("wt.onboarding.progress", {
              step: index + 1,
              total: steps.length,
            })}
          >
            {steps.map((s, i) => (
              <li
                key={s}
                className={
                  i <= index ? "wt-onb-dot wt-onb-dot--on" : "wt-onb-dot"
                }
                aria-current={s === step ? "step" : undefined}
              />
            ))}
          </ol>
        ) : null}
        <div className="wt-onb-card" ref={heading} key={step}>
          {content}
        </div>
        {showFooter ? (
          <footer className="wt-onb-footer">
            <div>
              {back ? (
                <Button variant="quiet" onClick={() => void go(back)}>
                  {t("wt.common.back")}
                </Button>
              ) : null}
            </div>
            <DownloadStatus hidden={step === "model"} />
            <div>
              {step === "try" ? (
                <Button variant="primary" onClick={() => void finish()}>
                  {t("wt.onboarding.finish")}
                </Button>
              ) : step === "model" ? null : (
                <Button variant="primary" onClick={next}>
                  {t("wt.common.next")}
                </Button>
              )}
            </div>
          </footer>
        ) : null}
      </main>
    </GradientBackground>
  );
}

/** The model download, shown small on the steps after step 2. */
function DownloadStatus(props: { hidden: boolean }) {
  const { t } = useTranslation();
  const phase = useModelSetup((s) => s.phase);
  const progress = useModelSetup((s) => s.progress);
  if (props.hidden || phase === "idle") return <div />;
  return (
    <div className="wt-onb-download" role="status" aria-live="polite">
      {phase === "downloading" ? (
        <>
          <LogoLoader
            variant="fyld"
            size={18}
            progress={progress}
            label={t("wt.model.downloading")}
          />
          <span>
            {t("wt.model.downloading")} {Math.round(progress * 100)} %
          </span>
        </>
      ) : phase === "ready" ? (
        <span>{t("wt.model.ready")}</span>
      ) : phase === "failed" ? (
        <span>{t("wt.model.downloadFailed")}</span>
      ) : (
        <span>{t("wt.model.preparing")}</span>
      )}
    </div>
  );
}
