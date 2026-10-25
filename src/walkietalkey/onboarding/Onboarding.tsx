// First run (spec 6.2, run 2 "plug and play"): one window, one step at a
// time. The speech model downloads in the background from the first launch
// and shows as one calm line under the steps; it never blocks a step.
//
// Run 6, `replay` ("Vis introduktionen igen" in Generelt): every screen a new
// user meets, in order, without touching anything. The permission steps show
// their first-run face but ask for nothing and open nothing, no step is saved,
// and the end changes no setting (login item, phone offer).
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { GradientBackground } from "@walkietalkey/ui";
import { useSettingsStore } from "@/stores/settingsStore";
import {
  forwardStep,
  nextStep,
  ONBOARDING_DONE,
  onboardingSteps,
  phoneOfferPending,
  previousStep,
  type OnboardingStepId,
  type WtPlatform,
} from "../lib/helpers";
import { useTauriEvent } from "../lib/hooks";
import { hasPermission, windowsMicrophoneAllowed } from "../lib/system";
import { useColorScheme } from "../lib/theme";
import { useWtStore, useWtSettings } from "../lib/wtStore";
import { Button } from "../ui/controls";
import { ModelStatusLine } from "../ui/modelStatus";
import { useModelSetup } from "./modelSetup";
import {
  AccessibilityStep,
  DoneStep,
  MicrophoneStep,
  PhoneStep,
  TryStep,
  WelcomeStep,
} from "./steps";

export function Onboarding(props: {
  platform: WtPlatform;
  initialStep: OnboardingStepId;
  onDone: () => void;
  /** Run 6: the screens again, from the settings; nothing is changed. */
  replay?: boolean;
}) {
  const replay = !!props.replay;
  const { t } = useTranslation();
  const wt = useWtSettings();
  const updateWt = useWtStore((s) => s.update);
  const mac = props.platform === "macos";
  // Run 5: Telefon comes only after a dictation in Prøv det that worked (a
  // restart at Telefon had one).
  const [dictated, setDictated] = useState(props.initialStep === "phone");
  const phonePairing = wt?.allow_phone_pairing ?? true;
  const steps = useMemo(
    () =>
      onboardingSteps(props.platform, {
        phonePairing,
        dictated: dictated || replay,
      }),
    [props.platform, phonePairing, dictated, replay],
  );
  const [step, setStep] = useState<OnboardingStepId>(props.initialStep);
  const [phoneShown, setPhoneShown] = useState(false);
  const [phonePaired, setPhonePaired] = useState(false);
  const heading = useRef<HTMLDivElement>(null);
  const scheme = useColorScheme();

  // The backend starts the download at the first launch; this follows it
  // (and starts it only if nothing did).
  useEffect(() => {
    if (!replay) void useModelSetup.getState().watch({ onboarding: true });
  }, [replay]);
  useTauriEvent("wt-phone-joined", () => setPhonePaired(true));

  const go = async (to: OnboardingStepId | null) => {
    if (!to) return;
    setStep(to);
    // Remembered so a restart resumes here (DESK-13).
    if (!replay) await updateWt({ onboarding_resume_step: to });
  };

  /** The next step, past permissions that are already granted. */
  const forward = async () => {
    if (replay) return go(nextStep(steps, step));
    const [microphone, accessibility] = await Promise.all([
      mac ? hasPermission("microphone") : windowsMicrophoneAllowed(),
      mac ? hasPermission("accessibility") : Promise.resolve(true),
    ]);
    await go(forwardStep(steps, step, { microphone, accessibility }));
  };

  // Move focus to the new step for keyboard and screen reader users, or to
  // the field a step asks for (Prøv det: the text is pasted where focus is).
  useEffect(() => {
    const box = heading.current;
    (
      box?.querySelector<HTMLElement>("[data-autofocus]") ??
      box?.querySelector<HTMLElement>("h1")
    )?.focus();
  }, [step]);

  const finish = async () => {
    if (replay) return props.onDone();
    // DESK-97: start at login, on by default after onboarding.
    await useSettingsStore.getState().updateSetting("autostart_enabled", true);
    // Finished, whether or not the model is in place yet: the download goes
    // on in the background and the pill says when it is not ready. Without
    // Telefon (no dictation worked yet), pairing is offered once later, after
    // the first dictation that works (run 5).
    await updateWt({
      onboarding_resume_step: ONBOARDING_DONE,
      phone_offer_pending: phoneOfferPending({
        phonePairing,
        phoneStepShown: steps.includes("phone"),
      }),
    });
    props.onDone();
  };

  const back = previousStep(steps, step);
  const index = steps.indexOf(step);

  let content;
  switch (step) {
    case "welcome":
      content = <WelcomeStep onStart={() => void forward()} />;
      break;
    case "microphone":
      content = (
        <MicrophoneStep
          platform={props.platform}
          onGranted={() => void forward()}
          replay={replay}
        />
      );
      break;
    case "accessibility":
      content = (
        <AccessibilityStep onGranted={() => void forward()} replay={replay} />
      );
      break;
    case "try":
      content = (
        <TryStep
          platform={props.platform}
          onDictated={() => setDictated(true)}
          replay={replay}
        />
      );
      break;
    case "phone":
      content = <PhoneStep onShown={() => setPhoneShown(true)} />;
      break;
    case "done":
      content = <DoneStep platform={props.platform} />;
      break;
  }

  let action;
  if (step === "done") {
    action = (
      <Button variant="primary" onClick={() => void finish()}>
        {t("wt.onboarding.finish")}
      </Button>
    );
  } else if (step === "phone" && !phoneShown && !phonePaired) {
    action = (
      <Button onClick={() => void forward()}>{t("wt.common.skip")}</Button>
    );
  } else {
    const permission = step === "microphone" || step === "accessibility";
    action = (
      <Button
        variant={permission ? "secondary" : "primary"}
        onClick={() => void forward()}
      >
        {t("wt.common.next")}
      </Button>
    );
  }

  const welcome = step === "welcome";
  return (
    <GradientBackground
      palette={scheme === "dark" ? "nat" : "morgengry"}
      className="wt-onb-bg"
      noise={0.6}
    >
      <main
        className={welcome ? "wt-onb wt-onb--welcome" : "wt-onb"}
        aria-label={t("wt.onboarding.label")}
      >
        {!welcome ? (
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
        <div
          className={
            welcome ? "wt-onb-card wt-onb-card--welcome" : "wt-onb-card"
          }
          ref={heading}
          key={step}
          data-step={step}
        >
          {content}
        </div>
        {!welcome ? (
          <footer className="wt-onb-footer">
            <div>
              {back && back !== "welcome" ? (
                <Button variant="quiet" onClick={() => void go(back)}>
                  {t("wt.common.back")}
                </Button>
              ) : null}
            </div>
            <ModelStatusLine className="wt-onb-model" />
            <div>{action}</div>
          </footer>
        ) : null}
        {/* Last in the window, so the first child still centres the steps. */}
        {replay ? (
          <Button
            variant="quiet"
            className="wt-onb-close"
            onClick={props.onDone}
          >
            {t("wt.onboarding.close")}
          </Button>
        ) : null}
      </main>
    </GradientBackground>
  );
}
