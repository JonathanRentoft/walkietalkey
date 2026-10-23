// Indstillinger › Generelt (spec 6.14): start at login, sounds, the pill's
// place or Vis aldrig, the text in notifications, and the UI language.
import { useId } from "react";
import { useTranslation } from "react-i18next";
import { Notice } from "@walkietalkey/ui";
import { SUPPORTED_LANGUAGES } from "@/i18n";
import { useSettingsStore } from "@/stores/settingsStore";
import type { WtPlatform } from "../lib/helpers";
import { pasteKey } from "../lib/system";
import { useWtSettings, useWtStore } from "../lib/wtStore";
import {
  ChoiceGroup,
  Group,
  Page,
  Select,
  SettingRow,
  Switch,
} from "../ui/controls";

type PillPlace = "bottom" | "top" | "never";

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
                  ? t("wt.onboarding.notifications.example")
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
    </Page>
  );
}
