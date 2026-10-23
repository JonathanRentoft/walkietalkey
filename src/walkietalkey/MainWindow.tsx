// The main window after onboarding: a sidebar with the history and every
// settings section of spec 6.14 (replaces Handy's Sidebar and settings).
import { useLayoutEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { commands } from "@/bindings";
import SecureInputWarning from "@/components/SecureInputWarning";
import WalkieTalkeyLockup from "./brand/WalkieTalkeyLockup";
import type { WtPlatform } from "./lib/helpers";
import { SECTIONS, useUi, type SectionId } from "./lib/uiStore";
import { Button } from "./ui/controls";
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
          <WalkieTalkeyLockup height={16} />
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
                {t(`wt.nav.${id}`)}
              </button>
              {id === "history" ? <div className="wt-nav-sep" role="presentation" /> : null}
            </li>
          ))}
        </ul>
      </nav>
      <main className="wt-main" ref={scroller}>
        <div className="wt-main-inner">
          <PausedBanner />
          <SecureInputWarning />
          <SectionView key={section} id={section} platform={props.platform} />
        </div>
      </main>
    </div>
  );
}
