// The main window after onboarding: a 240 px sidebar with the history and
// every settings section of spec 6.14 (replaces Handy's Sidebar and
// settings), and a calm status card at its foot: the key, the pause, or the
// speech model while it downloads. That card is the window's one living
// surface (design system README).
import { useLayoutEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { commands } from "@/bindings";
import SecureInputWarning from "@/components/SecureInputWarning";
import { GradientBackground, Logo } from "@walkietalkey/ui";
import { useSettingsStore } from "@/stores/settingsStore";
import type { WtPlatform } from "./lib/helpers";
import { useColorScheme } from "./lib/theme";
import { SECTIONS, useUi, type SectionId } from "./lib/uiStore";
import { useModelSetup } from "./onboarding/modelSetup";
import { AccessNotice } from "./ui/accessNotice";
import { MicNotice } from "./ui/micNotice";
import { PhoneBanner } from "./ui/phoneOffer";
import { Button } from "./ui/controls";
import { SectionIcon } from "./ui/icons";
import { DICTATION_BINDING, KeyCaps, useKeyName } from "./ui/keys";
import { ModelStatusLine } from "./ui/modelStatus";
import { HistoryScreen } from "./settings/HistoryScreen";
import { GeneralSection } from "./settings/GeneralSection";
import { KeySection } from "./settings/KeySection";
import { TextSection } from "./settings/TextSection";
import { VocabularySection } from "./settings/VocabularySection";
import { CleanupSection } from "./settings/CleanupSection";
import { PhoneSection } from "./settings/PhoneSection";
import { ModelSection } from "./settings/ModelSection";
import { UpdatesSection } from "./settings/UpdatesSection";
import { AdvancedSection } from "./settings/AdvancedSection";
import { AboutSection } from "./settings/AboutSection";

function SectionView(props: { id: SectionId; platform: WtPlatform }) {
  const p = props.platform;
  switch (props.id) {
    case "history":
      return <HistoryScreen platform={p} />;
    case "general":
      return <GeneralSection platform={p} />;
    case "key":
      return <KeySection platform={p} />;
    case "text":
      return <TextSection platform={p} />;
    case "vocabulary":
      return <VocabularySection />;
    case "cleanup":
      return <CleanupSection platform={p} />;
    case "phone":
      return <PhoneSection />;
    case "model":
      return <ModelSection />;
    case "updates":
      return <UpdatesSection />;
    case "advanced":
      return <AdvancedSection />;
    case "about":
      return <AboutSection />;
  }
}

/** "Sæt på pause" from the tray (DESK-96) shown in the window. */
function PausedBanner() {
  const { t } = useTranslation();
  const paused = useUi((s) => s.paused);
  const setPaused = useUi((s) => s.setPaused);
  if (!paused) return null;
  const resume = async () => {
    try {
      await commands.wtSetPaused(false);
      setPaused(false);
    } catch (e) {
      console.warn("Could not resume:", e);
    }
  };
  return (
    <div className="wt-banner" role="status">
      <p>{t("wt.paused.text")}</p>
      <Button onClick={() => void resume()}>{t("wt.paused.resume")}</Button>
    </div>
  );
}

/** The foot of the sidebar: how to dictate, the pause, or the model. */
function StatusCard(props: { platform: WtPlatform }) {
  const { t } = useTranslation();
  const scheme = useColorScheme();
  const paused = useUi((s) => s.paused);
  const phase = useModelSetup((s) => s.phase);
  const key = useKeyName(props.platform);
  const binding =
    useSettingsStore(
      (s) => s.settings?.bindings?.[DICTATION_BINDING]?.current_binding,
    ) ?? (props.platform === "macos" ? "fn" : "ctrl_right");
  const modelBusy =
    phase === "downloading" || phase === "preparing" || phase === "failed";

  let body;
  if (paused) {
    body = (
      <>
        <p className="wt-status-title">{t("wt.status.paused")}</p>
        <p className="wt-status-sub">{t("wt.status.pausedSub")}</p>
      </>
    );
  } else if (modelBusy) {
    body = <ModelStatusLine className="wt-status-model" />;
  } else {
    body = (
      <div className="wt-status-key">
        <span aria-hidden>
          <KeyCaps binding={binding} platform={props.platform} size={36} />
        </span>
        <div>
          <p className="wt-status-title">{t("wt.status.ready", { key })}</p>
          <p className="wt-status-sub">{t("wt.status.readySub")}</p>
        </div>
      </div>
    );
  }
  return (
    <section className="wt-side-status" aria-label={t("wt.status.label")}>
      <GradientBackground
        palette={scheme === "dark" ? "nat" : "morgengry"}
        noise={0.5}
        className="wt-status-card"
      >
        {body}
      </GradientBackground>
    </section>
  );
}

export function MainWindow(props: { platform: WtPlatform }) {
  const { t } = useTranslation();
  const section = useUi((s) => s.section);
  const setSection = useUi((s) => s.setSection);
  const scroller = useRef<HTMLElement>(null);

  useLayoutEffect(() => {
    scroller.current?.scrollTo({ top: 0 });
  }, [section]);

  return (
    <div className="wt-app">
      <nav className="wt-nav" aria-label={t("wt.nav.label")}>
        <div className="wt-nav-brand">
          <Logo variant="lockup" size={22} />
        </div>
        <ul>
          {SECTIONS.map((id) => (
            <li key={id}>
              <button
                type="button"
                className="wt-nav-item"
                aria-current={section === id ? "page" : undefined}
                onClick={() => setSection(id)}
              >
                <SectionIcon id={id} />
                <span>{t(`wt.nav.${id}`)}</span>
              </button>
              {id === "history" ? (
                <div className="wt-nav-sep" role="presentation" />
              ) : null}
            </li>
          ))}
        </ul>
        <StatusCard platform={props.platform} />
      </nav>
      <main className="wt-main" ref={scroller}>
        <div className="wt-main-inner">
          <AccessNotice platform={props.platform} />
          {/* Avanceret shows it at the microphone setting itself. */}
          {section !== "advanced" ? <MicNotice variant="banner" /> : null}
          <PausedBanner />
          <PhoneBanner />
          <SecureInputWarning />
          <SectionView key={section} id={section} platform={props.platform} />
        </div>
      </main>
    </div>
  );
}
