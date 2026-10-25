// Indstillinger › Generelt (spec 6.14): start at login, sounds, the pill's
// place or Vis aldrig, the text in notifications, and the UI language.
import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { Notice } from "@walkietalkey/ui";
import { SUPPORTED_LANGUAGES } from "@/i18n";
import { useSettingsStore } from "@/stores/settingsStore";
import type { WtPlatform } from "../lib/helpers";
import {
  notificationPermission,
  openSettingsPage,
  pasteKey,
  requestNotificationPermission,
  type NotificationPermission,
} from "../lib/system";
import { useUi } from "../lib/uiStore";
import { useWtSettings, useWtStore } from "../lib/wtStore";
import {
  Button,
  ChoiceGroup,
  Group,
  Page,
  Select,
  SettingRow,
  Switch,
} from "../ui/controls";

type PillPlace = "bottom" | "top" | "never";

/** Notifications carry phone dictations (DESK-56). Onboarding no longer has
 *  a step for them (run 2): they are asked for when a phone is paired, and
 *  can be turned on here. Shown only while they are off. */
function NotificationsRow(props: { platform: WtPlatform }) {
  const { t } = useTranslation();
  const [state, setState] = useState<NotificationPermission | null>(null);
  useEffect(() => {
    void notificationPermission().then(setState);
  }, []);
  if (state !== "not_determined" && state !== "denied") return null;
  const turnOn = async () => {
    if (state === "denied") {
      if (props.platform === "macos") await openSettingsPage("notifications");
      return;
    }
    const ok = await requestNotificationPermission();
    setState(ok ? "granted" : "denied");
  };
  return (
    <div className="wt-row">
      <div className="wt-row-text">
        <p className="wt-row-desc wt-row-desc--warn">
          {t("wt.general.notificationsOff")}
        </p>
      </div>
      <div className="wt-row-control">
        {state === "denied" && props.platform !== "macos" ? null : (
          <Button onClick={() => void turnOn()}>
            {state === "denied"
              ? t("wt.general.notificationsOpen")
              : t("wt.general.notificationsAllow")}
          </Button>
        )}
      </div>
    </div>
  );
}

export function GeneralSection(props: { platform: WtPlatform }) {
  const { t, i18n } = useTranslation();
  const handy = useSettingsStore((s) => s.settings);
  const updateHandy = useSettingsStore((s) => s.updateSetting);
  const wt = useWtSettings();
  const updateWt = useWtStore((s) => s.update);
  const languageId = useId();

  const place: PillPlace = wt?.pill_hidden
    ? "never"
    : handy?.overlay_position === "top"
      ? "top"
      : "bottom";

  const setPlace = async (next: PillPlace) => {
    if (next === "never") {
      await updateWt({ pill_hidden: true });
      // Handy then never shows its overlay window at all.
      await updateHandy("overlay_style", "none");
      return;
    }
    await updateWt({ pill_hidden: false });
    if (handy?.overlay_style === "none" || !handy?.overlay_style) {
      await updateHandy("overlay_style", "minimal");
    }
    await updateHandy("overlay_position", next);
  };

  const showText = wt?.show_text_in_notifications ?? true;
  const key = pasteKey(props.platform);

  return (
    <Page title={t("wt.nav.general")}>
      <Group>
        <SettingRow
          title={t("wt.general.autostart")}
          description={t("wt.general.autostartDesc")}
        >
          {({ labelId, descId }) => (
            <Switch
              labelledBy={labelId}
              describedBy={descId}
              checked={!!handy?.autostart_enabled}
              onChange={(v) => void updateHandy("autostart_enabled", v)}
            />
          )}
        </SettingRow>
        <SettingRow
          title={t("wt.general.sounds")}
          description={t("wt.general.soundsDesc")}
        >
          {({ labelId, descId }) => (
            <Switch
              labelledBy={labelId}
              describedBy={descId}
              checked={!!handy?.audio_feedback}
              onChange={(v) => void updateHandy("audio_feedback", v)}
            />
          )}
        </SettingRow>
      </Group>

      <Group title={t("wt.general.pillGroup")}>
        <SettingRow
          title={t("wt.general.pillPlace")}
          description={t("wt.general.pillPlaceDesc")}
          stacked
        >
          {({ labelId }) => (
            <ChoiceGroup<PillPlace>
              labelledBy={labelId}
              value={place}
              onChange={(v) => void setPlace(v)}
              options={[
                { value: "bottom", label: t("wt.general.pillBottom") },
                { value: "top", label: t("wt.general.pillTop") },
                { value: "never", label: t("wt.general.pillNever") },
              ]}
            />
          )}
        </SettingRow>
        <SettingRow
          title={t("wt.general.pillForPhone")}
          description={t("wt.general.pillForPhoneDesc")}
        >
          {({ labelId, descId, locked }) => (
            <Switch
              labelledBy={labelId}
              describedBy={descId}
              disabled={locked || place === "never"}
              checked={!!wt?.pill_for_phone}
              onChange={(v) => void updateWt({ pill_for_phone: v })}
            />
          )}
        </SettingRow>
      </Group>

      <Group title={t("wt.general.notificationsGroup")}>
        <NotificationsRow platform={props.platform} />
        <SettingRow
          title={t("wt.general.showText")}
          description={t("wt.general.showTextDesc")}
          lockField="show_text_in_notifications"
        >
          {({ labelId, descId, locked }) => (
            <Switch
              labelledBy={labelId}
              describedBy={descId}
              disabled={locked}
              checked={showText}
              onChange={(v) => void updateWt({ show_text_in_notifications: v })}
            />
          )}
        </SettingRow>
        <div className="wt-row wt-row--stacked">
          <span className="wt-row-desc">{t("wt.general.preview")}</span>
          <div
            className="wt-notice-preview"
            data-testid="notice-preview"
            aria-hidden
          >
            <Notice
              show
              platform={props.platform === "windows" ? "windows" : "mac"}
              title={t("wt.notify.textReady")}
              preview={
                showText
                  ? t("wt.general.previewExample")
                  : t("wt.notify.pressToPaste", { key })
              }
              when={t("wt.notify.now")}
              pasteKey={key}
            />
          </div>
        </div>
      </Group>

      <Group>
        <SettingRow
          title={t("wt.general.language")}
          description={t("wt.general.languageDesc")}
          htmlFor={languageId}
        >
          <Select
            id={languageId}
            value={handy?.app_language ?? i18n.language}
            onChange={(e) => {
              const code = e.target.value;
              void updateHandy("app_language", code);
              void i18n.changeLanguage(code);
            }}
          >
            {SUPPORTED_LANGUAGES.map((l) => (
              <option key={l.code} value={l.code}>
                {l.nativeName}
              </option>
            ))}
          </Select>
        </SettingRow>
      </Group>

      {/* Run 6: the first-run screens again, without touching permissions. */}
      <Group>
        <SettingRow
          title={t("wt.general.intro")}
          description={t("wt.general.introDesc")}
        >
          <Button onClick={() => useUi.getState().setReplayIntro(true)}>
            {t("wt.general.introButton")}
          </Button>
        </SettingRow>
      </Group>
    </Page>
  );
}
