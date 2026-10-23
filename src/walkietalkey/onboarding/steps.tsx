// The eight onboarding steps (DESK-10..17).
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { LogoIntro, LogoLoader, Notice, ShinyButton } from "@walkietalkey/ui";
import { commands } from "@/bindings";
import { useSettingsStore } from "@/stores/settingsStore";
import { isCopilotBinding, keyParts, type WtPlatform } from "../lib/helpers";
import { useTauriEvent } from "../lib/hooks";
import {
  hasPermission,
  notificationPermission,
  openSettingsPage,
  pasteKey,
  requestNotificationPermission,
  requestPermission,
  restartApp,
  windowsMicrophoneAllowed,
} from "../lib/system";
import { useWtStore } from "../lib/wtStore";
import type { PillEndEvent } from "../lib/types";
import { Button, Status } from "../ui/controls";
import { DICTATION_BINDING, KeyPicker, useKeyLabel } from "../ui/keys";
import { PairingCode } from "../ui/pairing";
import { useModelSetup } from "./modelSetup";

function StepTitle(props: { children: ReactNode }) {
  return (
    <h1 className="wt-onb-title" tabIndex={-1}>
      {props.children}
    </h1>
  );
}

function Block(props: { title?: string; children: ReactNode }) {
  return (
    <div className="wt-onb-block">
      {props.title ? <h2 className="wt-onb-block-title">{props.title}</h2> : null}
      {props.children}
    </div>
  );
}

/** Polls a permission while the step is shown, because macOS grants arrive
 *  from System Settings without telling the app. */
function usePermission(check: () => Promise<boolean>, active = true) {
  const [granted, setGranted] = useState<boolean | null>(null);
  const checkRef = useRef(check);
  checkRef.current = check;
  useEffect(() => {
    if (!active) return;
    let stop = false;
    const tick = async () => {
      const g = await checkRef.current();
      if (!stop) setGranted(g);
    };
    void tick();
    const id = setInterval(tick, 1500);
    return () => {
      stop = true;
      clearInterval(id);
    };
  }, [active]);
  return [granted, setGranted] as const;
}

/* ------------------------------------------------------ 1. Velkommen */

export function WelcomeStep(props: { onStart: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="wt-onb-welcome">
      <LogoIntro size={64} title="WalkieTalkey" />
      <h1 className="wt-onb-hero" tabIndex={-1}>
        {t("wt.onboarding.welcome.title")}
      </h1>
      <ShinyButton size="lg" onClick={props.onStart}>
        {t("wt.onboarding.welcome.start")}
      </ShinyButton>
    </div>
  );
}

/* ------------------------------------------------- 2. Hent talemodel */

export function ModelStep(props: { onNext: () => void }) {
  const { t } = useTranslation();
  const s = useModelSetup();
  const offer = s.verdict?.offer_fast_model && !s.offerAnswered;
  return (
    <>
      <StepTitle>{t("wt.onboarding.model.title")}</StepTitle>
      <p className="wt-onb-lead">{t("wt.onboarding.model.lead")}</p>
      <div className="wt-onb-model">
        {s.phase === "downloading" ? (
          <>
            <LogoLoader
              variant="fyld"
              size={72}
              progress={s.progress}
              label={t("wt.model.downloading")}
            />
            <Status>
              {t("wt.model.downloading")} {Math.round(s.progress * 100)} %
            </Status>
            <p className="wt-note">{t("wt.onboarding.model.continueNote")}</p>
          </>
        ) : null}
        {s.phase === "preparing" || s.phase === "idle" ? (
          <>
            <LogoLoader variant="smelt" size={56} label={t("wt.model.preparing")} />
            <Status tone="muted">{t("wt.model.preparing")}</Status>
          </>
        ) : null}
        {s.phase === "ready" ? (
          <Status tone="ok">{t("wt.model.ready")}</Status>
        ) : null}
        {s.phase === "failed" ? (
          <>
            <Status tone="warn">{t("wt.model.downloadFailed")}</Status>
            <p className="wt-note">{t("wt.onboarding.model.importNote")}</p>
            <div className="wt-onb-actions">
              <Button onClick={() => void s.retry()}>{t("wt.common.retry")}</Button>
            </div>
          </>
        ) : null}
        {s.importError ? <Status tone="warn">{t("wt.model.importFailed")}</Status> : null}
      </div>

      {offer && s.verdict?.reason ? (
        <Block title={t("wt.onboarding.model.fastTitle")}>
          <p>{s.verdict.reason}</p>
          <div className="wt-onb-actions">
            <Button variant="primary" onClick={() => void s.useFastModel()}>
              {t("wt.onboarding.model.useFast")}
            </Button>
            <Button onClick={s.keepEdda}>{t("wt.onboarding.model.keepEdda")}</Button>
          </div>
        </Block>
      ) : null}

      <div className="wt-onb-actions wt-onb-actions--end">
        {s.phase !== "ready" ? (
          <Button variant="quiet" onClick={() => void s.importFile()}>
            {t("wt.model.importFile")}
          </Button>
        ) : null}
        <Button variant="primary" onClick={props.onNext}>
          {t("wt.onboarding.model.continue")}
        </Button>
      </div>
    </>
  );
}

/* ------------------------------------------------------- 3. Mikrofon */

export function MicrophoneStep(props: { platform: WtPlatform }) {
  const { t } = useTranslation();
  const mac = props.platform === "macos";
  const [granted, setGranted] = usePermission(
    () => (mac ? hasPermission("microphone") : windowsMicrophoneAllowed()),
  );
  const [asked, setAsked] = useState(false);
  const ask = async () => {
    setAsked(true);
    setGranted(await requestPermission("microphone"));
    void useSettingsStore.getState().refreshAudioDevices();
  };
  return (
    <>
      <StepTitle>{t("wt.onboarding.microphone.title")}</StepTitle>
      <p className="wt-onb-lead">{t("wt.onboarding.microphone.lead")}</p>
      <p>{t("wt.onboarding.microphone.why")}</p>
      {granted ? (
        <Status tone="ok">{t("wt.onboarding.microphone.granted")}</Status>
      ) : mac ? (
        <>
          <p className="wt-note">{t("wt.onboarding.microphone.promptNote")}</p>
          <div className="wt-onb-actions">
            <Button variant="primary" onClick={() => void ask()}>
              {t("wt.onboarding.microphone.allow")}
            </Button>
          </div>
          {asked && granted === false ? (
            <>
              <Status tone="warn">{t("wt.onboarding.microphone.deniedMac")}</Status>
              <Button onClick={() => void openSettingsPage("microphone")}>
                {t("wt.onboarding.microphone.openSettings")}
              </Button>
            </>
          ) : null}
        </>
      ) : granted === false ? (
        <>
          <Status tone="warn">{t("wt.onboarding.microphone.deniedWindows")}</Status>
          <Button onClick={() => void commands.openMicrophonePrivacySettings().catch(() => {})}>
            {t("wt.onboarding.microphone.openSettings")}
          </Button>
        </>
      ) : null}
    </>
  );
}

/* ---------------------------------------------------------- 4. Tasten */

/** The key's name in a sentence: "fn", "Ctrl", "Copilot-tasten", ... */
export function useKeyName(platform: WtPlatform): string {
  const { t } = useTranslation();
  const binding =
    useSettingsStore((s) => s.settings?.bindings?.[DICTATION_BINDING]?.current_binding) ??
    (platform === "macos" ? "fn" : "ctrl_right");
  const label = useKeyLabel(platform);
  if (isCopilotBinding(binding)) return t("wt.keys.copilot");
  const parts = keyParts(binding);
  if (parts.length === 1 && /^ctrl(_left|_right)?$/.test(parts[0])) return "Ctrl";
  return parts.map(label).join(" + ");
}

function KeyCheck(props: { platform: WtPlatform }) {
  const { t } = useTranslation();
  const [worked, setWorked] = useState(false);
  const [down, setDown] = useState(false);
  useTauriEvent<boolean>("wt-key-state", (d) => {
    setDown(!!d);
    if (d) setWorked(true);
  });
  return (
    <Block title={t("wt.onboarding.key.tryTitle")}>
      <p>{t("wt.onboarding.key.tryText", { key: useKeyName(props.platform) })}</p>
      <KeyPicker platform={props.platform} showLive />
      <p className="wt-visually-hidden" aria-live="polite">
        {down ? t("wt.onboarding.key.down") : ""}
      </p>
      {worked ? <Status tone="ok">{t("wt.onboarding.key.works")}</Status> : null}
    </Block>
  );
}

export function KeyStep(props: { platform: WtPlatform }) {
  const { t } = useTranslation();
  const mac = props.platform === "macos";
  const [monitoring] = usePermission(() => hasPermission("inputMonitoring"), mac);
  const updateWt = useWtStore((s) => s.update);

  // The key listener starts here, so the live check works before the end of
  // onboarding (Handy starts it after its own onboarding).
  useEffect(() => {
    void commands.initializeShortcuts().catch(() => {});
  }, []);

  const openMonitoring = async () => {
    await requestPermission("inputMonitoring");
    await openSettingsPage("inputMonitoring");
  };

  const restart = async () => {
    await updateWt({ onboarding_resume_step: "key" });
    await restartApp();
  };

  if (!mac) {
    return (
      <>
        <StepTitle>{t("wt.onboarding.key.title")}</StepTitle>
        <p className="wt-onb-lead">{t("wt.onboarding.key.leadWindows")}</p>
        <p>{t("wt.onboarding.key.copilotNote")}</p>
        <KeyCheck platform={props.platform} />
      </>
    );
  }

  return (
    <>
      <StepTitle>{t("wt.onboarding.key.title")}</StepTitle>
      <p className="wt-onb-lead">{t("wt.onboarding.key.leadMac")}</p>
      <Block title={t("wt.onboarding.key.monitoringTitle")}>
        <p>{t("wt.onboarding.key.monitoringWhy")}</p>
        {monitoring ? (
          <Status tone="ok">{t("wt.onboarding.key.monitoringOn")}</Status>
        ) : (
          <div className="wt-onb-actions">
            <Button variant="primary" onClick={() => void openMonitoring()}>
              {t("wt.onboarding.key.openMonitoring")}
            </Button>
          </div>
        )}
      </Block>
      <Block title={t("wt.onboarding.key.globeTitle")}>
        <p>{t("wt.onboarding.key.globeWhy")}</p>
        <div className="wt-onb-actions">
          <Button onClick={() => void openSettingsPage("keyboard")}>
            {t("wt.onboarding.key.openKeyboard")}
          </Button>
        </div>
      </Block>
      <Block title={t("wt.onboarding.key.restartTitle")}>
        <p>{t("wt.onboarding.key.restartWhy")}</p>
        <div className="wt-onb-actions">
          <Button onClick={() => void restart()}>{t("wt.onboarding.key.restart")}</Button>
        </div>
      </Block>
      <KeyCheck platform={props.platform} />
    </>
  );
}

/* ----------------------------------------------- 5. Indsæt automatisk */

export function PasteStep(props: { platform: WtPlatform; onSkip: () => void }) {
  const { t } = useTranslation();
  const [granted, setGranted] = usePermission(() => hasPermission("accessibility"));
  const ask = async () => {
    const ok = await requestPermission("accessibility");
    setGranted(ok);
    if (ok) void commands.initializeEnigo().catch(() => {});
  };
  return (
    <>
      <StepTitle>{t("wt.onboarding.paste.title")}</StepTitle>
      <p className="wt-onb-lead">{t("wt.onboarding.paste.lead")}</p>
      <p>{t("wt.onboarding.paste.why", { key: pasteKey(props.platform) })}</p>
      {granted ? (
        <Status tone="ok">{t("wt.onboarding.paste.granted")}</Status>
      ) : (
        <div className="wt-onb-actions">
          <Button variant="primary" onClick={() => void ask()}>
            {t("wt.onboarding.paste.allow")}
          </Button>
          <Button onClick={props.onSkip}>{t("wt.common.skip")}</Button>
        </div>
      )}
    </>
  );
}

/* --------------------------------------------------- 6. Notifikationer */

export function NotificationsStep(props: { platform: WtPlatform; onSkip: () => void }) {
  const { t } = useTranslation();
  const [state, setState] = useState<string | null>(null);
  useEffect(() => {
    void notificationPermission().then(setState);
  }, []);
  const ask = async () => {
    const ok = await requestNotificationPermission();
    setState(ok ? "granted" : "denied");
  };
  return (
    <>
      <StepTitle>{t("wt.onboarding.notifications.title")}</StepTitle>
      <p className="wt-onb-lead">{t("wt.onboarding.notifications.lead")}</p>
      <div className="wt-notice-preview" aria-hidden>
        <Notice
          show
          platform={props.platform === "windows" ? "windows" : "mac"}
          title={t("wt.notify.textReady")}
          preview={t("wt.onboarding.notifications.example")}
          when={t("wt.notify.now")}
          pasteKey={pasteKey(props.platform)}
        />
      </div>
      {state === "granted" ? (
        <Status tone="ok">{t("wt.onboarding.notifications.granted")}</Status>
      ) : (
        <>
          <div className="wt-onb-actions">
            <Button variant="primary" onClick={() => void ask()}>
              {t("wt.onboarding.notifications.allow")}
            </Button>
            <Button onClick={props.onSkip}>{t("wt.common.skip")}</Button>
          </div>
          {state === "denied" ? (
            <>
              <Status tone="warn">{t("wt.onboarding.notifications.denied")}</Status>
              {props.platform === "macos" ? (
                <Button onClick={() => void openSettingsPage("notifications")}>
                  {t("wt.onboarding.notifications.openSettings")}
                </Button>
              ) : null}
            </>
          ) : null}
        </>
      )}
    </>
  );
}

/* ---------------------------------------------------------- 7. Telefon */

export function PhoneStep(props: { onSkip: () => void }) {
  const { t } = useTranslation();
  const [show, setShow] = useState(false);
  return (
    <>
      <StepTitle>{t("wt.onboarding.phone.title")}</StepTitle>
      <p className="wt-onb-lead">{t("wt.onboarding.phone.lead")}</p>
      <p>{t("wt.onboarding.phone.why")}</p>
      {show ? (
        <PairingCode />
      ) : (
        <>
          <p className="wt-note">{t("wt.pairing.noScreenShare")}</p>
          <div className="wt-onb-actions">
            <Button variant="primary" onClick={() => setShow(true)}>
              {t("wt.onboarding.phone.show")}
            </Button>
            <Button onClick={props.onSkip}>{t("wt.common.skip")}</Button>
          </div>
        </>
      )}
    </>
  );
}

/* ---------------------------------------------------------- 8. Prøv det */

export function TryStep(props: { platform: WtPlatform }) {
  const { t } = useTranslation();
  const key = useKeyName(props.platform);
  const [end, setEnd] = useState<PillEndEvent | null>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    field.current?.focus();
    void commands.initializeShortcuts().catch(() => {});
    void commands.initializeEnigo().catch(() => {});
  }, []);
  useTauriEvent<PillEndEvent>("wt-pill-end", setEnd);
  return (
    <>
      <StepTitle>{t("wt.onboarding.try.title")}</StepTitle>
      <p className="wt-onb-lead">{t("wt.onboarding.try.lead", { key })}</p>
      <label className="wt-row-title" htmlFor="wt-try-field">
        {t("wt.onboarding.try.fieldLabel")}
      </label>
      <textarea
        id="wt-try-field"
        ref={field}
        className="wt-input wt-try-field"
        rows={4}
      />
      {end?.state === "clipboard" ? (
        <Status>{t("wt.notify.pressToPaste", { key: end.shortcut })}</Status>
      ) : end?.state === "no_speech" ? (
        <Status tone="warn">{t("wt.pill.noSpeech")}</Status>
      ) : end ? (
        <Status tone="ok">{t("wt.onboarding.try.done")}</Status>
      ) : null}
    </>
  );
}
