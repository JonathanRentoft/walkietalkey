// WalkieTalkey's main window: onboarding on first run (spec 6.2), then the
// settings and history (6.12, 6.14). Replaces Handy's App as the entry point
// (src/main.tsx); Handy's App.tsx stays untouched for upstream merges.
import { useEffect, useState } from "react";
import { Toaster } from "sonner";
import "@walkietalkey/ui/styles.css";
import "./styles.css";
import { commands } from "@/bindings";
import { useSettingsStore } from "@/stores/settingsStore";
import {
  onboardingFinished,
  resumeStep,
  onboardingSteps,
  type OnboardingStepId,
} from "./lib/helpers";
import { currentPlatform } from "./lib/system";
import { useWtStore } from "./lib/wtStore";
import { Onboarding } from "./onboarding/Onboarding";
import { useModelSetup } from "./onboarding/modelSetup";
import { MainWindow } from "./MainWindow";
import { GlobalDialogs } from "./GlobalDialogs";
import { useHandyToasts } from "./lib/handyToasts";
import { followSystemTheme } from "./lib/theme";
import { useAccessLostEvents } from "./ui/accessNotice";

followSystemTheme();

type Mode =
  | { kind: "loading" }
  | { kind: "onboarding"; step: OnboardingStepId }
  | { kind: "main" };

export default function WalkieTalkeyApp() {
  const platform = currentPlatform();
  const [mode, setMode] = useState<Mode>({ kind: "loading" });
  useHandyToasts();
  useAccessLostEvents();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      void useSettingsStore.getState().initialize();
      const [appResult, view] = await Promise.all([
        commands.getAppSettings().catch(() => null),
        useWtStore.getState().load(),
      ]);
      if (cancelled) return;
      const completed =
        appResult?.status === "ok" &&
        appResult.data.onboarding_completed === true;
      const steps = onboardingSteps(platform, {
        phonePairing: view?.settings.allow_phone_pairing ?? true,
      });
      const saved = view?.settings.onboarding_resume_step;
      const resume = resumeStep(saved, steps);
      if (resume) setMode({ kind: "onboarding", step: resume });
      else if (!completed && !onboardingFinished(saved))
        setMode({ kind: "onboarding", step: "welcome" });
      else setMode({ kind: "main" });
    })();
    return () => {
      cancelled = true;
    };
  }, [platform]);

  // Handy starts its keyboard and paste helpers once onboarding is done.
  // (Onboarding itself never starts the key listener early: the backend
  // starts it once Accessibility is granted, run 2 Phase 1.)
  useEffect(() => {
    if (mode.kind !== "main") return;
    // A download that outlived onboarding still shows its progress.
    void useModelSetup.getState().watch();
    void Promise.all([
      commands.initializeEnigo(),
      commands.initializeShortcuts(),
    ]).catch((e) => console.warn("Failed to initialise:", e));
    const store = useSettingsStore.getState();
    void store.refreshAudioDevices();
    void store.refreshOutputDevices();
  }, [mode.kind]);

  return (
    <>
      <Toaster
        position="bottom-right"
        toastOptions={{ unstyled: true, classNames: { toast: "wt-toast" } }}
      />
      {mode.kind === "onboarding" ? (
        <Onboarding
          platform={platform}
          initialStep={mode.step}
          onDone={() => setMode({ kind: "main" })}
        />
      ) : mode.kind === "main" ? (
        <MainWindow platform={platform} />
      ) : null}
      {mode.kind !== "loading" ? <GlobalDialogs platform={platform} /> : null}
    </>
  );
}
