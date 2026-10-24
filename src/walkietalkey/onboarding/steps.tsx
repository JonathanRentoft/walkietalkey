// The onboarding steps (spec 6.2, DESK-10..17, run 2 "plug and play"):
// Velkommen, Mikrofon, Tilgængelighed (Mac), Prøv det, Telefon, Klar. Each
// permission step has one button; the app notices the grant by itself and
// moves on, with no restart and nothing to find in System Settings.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  AppIcon,
  Keycap,
  LogoIntro,
  LogoLoader,
  ShinyButton,
} from "@walkietalkey/ui";
import { commands } from "@/bindings";
import { useSettingsStore } from "@/stores/settingsStore";
import type { WtPlatform } from "../lib/helpers";
import { useTauriEvent } from "../lib/hooks";
import {
  hasPermission,
  openAccessibilityPane,
  openSettingsPage,
  requestPermission,
  windowsMicrophoneAllowed,
} from "../lib/system";
import type { PillEndEvent } from "../lib/types";
import { rememberAccessGranted } from "../ui/accessNotice";
import { Button, Status } from "../ui/controls";
import { GlobeFix } from "../ui/globeFix";
import { DICTATION_BINDING, KeyCaps, useKeyName } from "../ui/keys";
import { PairingCode } from "../ui/pairing";
import { useModelSetup } from "./modelSetup";

/** Key names are written as on the keyboard and not translated. */
const ESC = "Esc";
/** The product name is never translated. */
const APP_NAME = "WalkieTalkey";

/** How often a permission step looks for the grant. */
export const PERMISSION_POLL_MS = 1000;
/** How long "granted" shows before the step moves on by itself. */
export const ADVANCE_DELAY_MS = 900;

function StepTitle(props: { children: ReactNode }) {
  return (
    <h1 className="wt-onb-title" tabIndex={-1}>
      {props.children}
    </h1>
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
    const id = setInterval(tick, PERMISSION_POLL_MS);
    return () => {
      stop = true;
      clearInterval(id);
    };
  }, [active]);
  return [granted, setGranted] as const;
}

/** Moves on once a permission turns granted while the step is shown. A
 *  step that was already granted when it opened (the user went back) stays. */
function useAdvanceOnGrant(granted: boolean | null, onGranted: () => void) {
  const first = useRef<boolean | null>(null);
  const next = useRef(onGranted);
  next.current = onGranted;
  useEffect(() => {
    if (granted === null) return;
    if (first.current === null) {
      first.current = granted;
      return;
    }
    if (!granted || first.current) return;
    const id = setTimeout(() => next.current(), ADVANCE_DELAY_MS);
    return () => clearTimeout(id);
  }, [granted]);
}

function useBinding(platform: WtPlatform): string {
  return (
    useSettingsStore(
      (s) => s.settings?.bindings?.[DICTATION_BINDING]?.current_binding,
    ) ?? (platform === "macos" ? "fn" : "ctrl_right")
  );
}

/* ------------------------------------------------------ 1. Velkommen */

export function WelcomeStep(props: { onStart: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="wt-onb-welcome">
      <LogoIntro size={72} title="WalkieTalkey" />
      <h1 className="wt-onb-hero" tabIndex={-1}>
        {t("wt.onboarding.welcome.title")}
      </h1>
      <ShinyButton size="lg" onClick={props.onStart}>
        {t("wt.onboarding.welcome.start")}
      </ShinyButton>
    </div>
  );
}

/* ------------------------------------------------------- 2. Mikrofon */

export function MicrophoneStep(props: {
  platform: WtPlatform;
  onGranted: () => void;
}) {
  const { t } = useTranslation();
  const mac = props.platform === "macos";
  const [granted, setGranted] = usePermission(() =>
    mac ? hasPermission("microphone") : windowsMicrophoneAllowed(),
  );
  const [asked, setAsked] = useState(false);
  useAdvanceOnGrant(granted, props.onGranted);

  // One button: the first press shows macOS's own question; if macOS has
  // been answered before, it opens the exact pane instead.
  const allow = async () => {
    if (!mac) {
      await commands.openMicrophonePrivacySettings().catch(() => {});
      return;
    }
    if (!asked) {
      setAsked(true);
      setGranted(await requestPermission("microphone"));
      void useSettingsStore.getState().refreshAudioDevices();
    } else {
      await openSettingsPage("microphone");
    }
  };

  return (
    <>
      <StepTitle>{t("wt.onboarding.microphone.title")}</StepTitle>
      <p className="wt-onb-lead">{t("wt.onboarding.microphone.lead")}</p>
      <p className="wt-onb-text">{t("wt.onboarding.microphone.why")}</p>
      {granted ? (
        <Status tone="ok" className="wt-onb-granted">
          {t("wt.onboarding.microphone.granted")}
        </Status>
      ) : granted === false ? (
        <div className="wt-onb-actions">
          {!mac ? (
            <p className="wt-onb-text">
              {t("wt.onboarding.microphone.deniedWindows")}
            </p>
          ) : null}
          <Button variant="primary" onClick={() => void allow()}>
            {!mac
              ? t("wt.onboarding.microphone.openSettingsWindows")
              : asked
                ? t("wt.onboarding.microphone.openSettings")
                : t("wt.onboarding.microphone.allow")}
          </Button>
          {asked ? (
            <p className="wt-onb-hint">{t("wt.onboarding.waitingHint")}</p>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

/* ------------------------------------------------- 3. Tilgængelighed */

/** What the user will see in System Settings: the app with its switch. */
function SwitchPreview(props: { on: boolean }) {
  return (
    <div
      className={
        props.on ? "wt-onb-preview wt-onb-preview--on" : "wt-onb-preview"
      }
      aria-hidden
    >
      <AppIcon size={28} />
      <span className="wt-onb-preview-name">{APP_NAME}</span>
      <span className="wt-onb-preview-switch">
        <span />
      </span>
    </div>
  );
}

export function AccessibilityStep(props: { onGranted: () => void }) {
  const { t } = useTranslation();
  const [granted] = usePermission(() => hasPermission("accessibility"));
  const [opened, setOpened] = useState(false);
  useAdvanceOnGrant(granted, props.onGranted);
  useEffect(() => {
    if (!granted) return;
    // Pasting works as soon as it is granted.
    void commands.initializeEnigo().catch(() => {});
    // A later loss of the grant is noticed (ui/accessNotice.tsx).
    rememberAccessGranted();
  }, [granted]);

  const open = async () => {
    setOpened(true);
    await openAccessibilityPane();
  };

  return (
    <>
      <StepTitle>{t("wt.onboarding.accessibility.title")}</StepTitle>
      <p className="wt-onb-lead">{t("wt.onboarding.accessibility.lead")}</p>
      <p className="wt-onb-text">{t("wt.onboarding.accessibility.why")}</p>
      <SwitchPreview on={!!granted} />
      {granted ? (
        <Status tone="ok" className="wt-onb-granted">
          {t("wt.onboarding.accessibility.granted")}
        </Status>
      ) : granted === false ? (
        <div className="wt-onb-actions">
          <Button variant="primary" onClick={() => void open()}>
            {t("wt.onboarding.accessibility.open")}
          </Button>
          {opened ? (
            <p className="wt-onb-hint">{t("wt.onboarding.waitingHint")}</p>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

/* ---------------------------------------------------------- 4. Prøv det */

export function TryStep(props: { platform: WtPlatform }) {
  const { t } = useTranslation();
  const key = useKeyName(props.platform);
  const binding = useBinding(props.platform);
  const phase = useModelSetup((s) => s.phase);
  const progress = useModelSetup((s) => s.progress);
  const [end, setEnd] = useState<PillEndEvent | null>(null);
  const [down, setDown] = useState(false);
  const [listener, setListener] = useState<boolean | null>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    field.current?.focus();
    // The paste helper; the key listener is the backend's own (it starts
    // once Accessibility is granted and reports wt-key-listener).
    void commands.initializeEnigo().catch(() => {});
  }, []);
  useTauriEvent<PillEndEvent>("wt-pill-end", setEnd);
  useTauriEvent<boolean>("wt-key-state", (d) => {
    setDown(!!d);
    if (d) setEnd(null);
  });
  useTauriEvent<{ running: boolean }>("wt-key-listener", (e) =>
    setListener(!!e?.running),
  );
  const modelReady = phase === "ready";

  return (
    <>
      <StepTitle>{t("wt.onboarding.try.title")}</StepTitle>
      <p className="wt-onb-lead">{t("wt.onboarding.try.lead", { key })}</p>
      <p className="wt-onb-text">{t("wt.onboarding.try.tap", { key })}</p>
      <div className="wt-try">
        <div className="wt-try-key" aria-hidden>
          <KeyCaps
            binding={binding}
            platform={props.platform}
            pressed={down}
            size={64}
          />
        </div>
        <div className="wt-try-main">
          <label className="wt-row-title" htmlFor="wt-try-field">
            {t("wt.onboarding.try.fieldLabel")}
          </label>
          <textarea
            id="wt-try-field"
            ref={field}
            data-autofocus
            className="wt-input wt-try-field"
            rows={3}
          />
        </div>
      </div>
      <p className="wt-visually-hidden" aria-live="polite">
        {down ? t("wt.key.down") : ""}
      </p>
      {!modelReady && phase !== "idle" ? (
        <div className="wt-onb-wait" role="status">
          {phase === "downloading" ? (
            <LogoLoader
              variant="fyld"
              size={28}
              progress={progress}
              label={t("wt.model.downloading")}
            />
          ) : null}
          <span>
            {phase === "failed"
              ? t("wt.model.downloadFailed")
              : t("wt.onboarding.try.modelWaiting")}
          </span>
          {phase === "downloading" ? (
            <span className="wt-model-pct">{Math.round(progress * 100)} %</span>
          ) : null}
        </div>
      ) : null}
      {end?.state === "clipboard" ? (
        <Status>{t("wt.notify.pressToPaste", { key: end.shortcut })}</Status>
      ) : end?.state === "no_speech" ? (
        <Status tone="warn">{t("wt.pill.noSpeech")}</Status>
      ) : end ? (
        <Status tone="ok">{t("wt.onboarding.try.done")}</Status>
      ) : null}
      {listener === false && props.platform === "macos" ? (
        <div className="wt-onb-actions">
          <Status tone="warn">{t("wt.onboarding.try.keyNotRunning")}</Status>
          <Button onClick={() => void openAccessibilityPane()}>
            {t("wt.onboarding.accessibility.open")}
          </Button>
        </div>
      ) : null}
      <GlobeFix platform={props.platform} variant="block" />
    </>
  );
}

/* ---------------------------------------------------------- 5. Telefon */

export function PhoneStep(props: { onShown: () => void }) {
  const { t } = useTranslation();
  const [show, setShow] = useState(false);
  const reveal = () => {
    setShow(true);
    props.onShown();
  };
  return (
    <>
      <StepTitle>{t("wt.onboarding.phone.title")}</StepTitle>
      <p className="wt-onb-lead">{t("wt.onboarding.phone.lead")}</p>
      <p className="wt-onb-text">{t("wt.onboarding.phone.why")}</p>
      {show ? (
        <PairingCode />
      ) : (
        <div className="wt-onb-actions">
          <Button variant="primary" onClick={reveal}>
            {t("wt.onboarding.phone.show")}
          </Button>
          <p className="wt-onb-hint">{t("wt.pairing.noScreenShare")}</p>
        </div>
      )}
    </>
  );
}

/* ------------------------------------------------------------- 6. Klar */

export function DoneStep(props: { platform: WtPlatform }) {
  const { t } = useTranslation();
  const key = useKeyName(props.platform);
  const binding = useBinding(props.platform);
  const s = useModelSetup();
  const offer = s.verdict?.offer_fast_model && !s.offerAnswered;
  return (
    <>
      <StepTitle>{t("wt.onboarding.done.title")}</StepTitle>
      <p className="wt-onb-lead">{t("wt.onboarding.done.lead", { key })}</p>
      <ul className="wt-tips">
        <li>
          <span className="wt-tips-key" aria-hidden>
            <KeyCaps binding={binding} platform={props.platform} size={40} />
          </span>
          <span>{t("wt.onboarding.done.tipHold")}</span>
        </li>
        <li>
          <span className="wt-tips-key" aria-hidden>
            <KeyCaps binding={binding} platform={props.platform} size={40} />
          </span>
          <span>{t("wt.onboarding.done.tipTap")}</span>
        </li>
        <li>
          <span className="wt-tips-key" aria-hidden>
            <Keycap size={40} wide>
              {ESC}
            </Keycap>
          </span>
          <span>
            <span className="wt-visually-hidden">{`${ESC} `}</span>
            {t("wt.onboarding.done.tipEsc")}
          </span>
        </li>
      </ul>
      <p className="wt-onb-text">
        {props.platform === "windows"
          ? t("wt.onboarding.done.whereWindows")
          : t("wt.onboarding.done.whereMac")}
      </p>
      {offer && s.verdict?.reason ? (
        <div className="wt-onb-block">
          <h2 className="wt-onb-block-title">
            {t("wt.onboarding.done.fastTitle")}
          </h2>
          <p>{s.verdict.reason}</p>
          <div className="wt-onb-actions">
            <Button variant="primary" onClick={() => void s.useFastModel()}>
              {t("wt.onboarding.done.useFast")}
            </Button>
            <Button onClick={s.keepEdda}>
              {t("wt.onboarding.done.keepEdda")}
            </Button>
          </div>
        </div>
      ) : null}
    </>
  );
}
