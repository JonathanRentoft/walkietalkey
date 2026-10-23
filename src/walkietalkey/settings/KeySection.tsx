// Indstillinger › Tast (spec 6.14, DESK-20..22): the key, hold or tap, and
// a live test.
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { ShortcutActivation } from "@/bindings";
import { useSettingsStore } from "@/stores/settingsStore";
import type { WtPlatform } from "../lib/helpers";
import { useTauriEvent } from "../lib/hooks";
import { ChoiceGroup, Group, Page, SettingRow, Status } from "../ui/controls";
import { DICTATION_BINDING, KeyCaps, KeyPicker } from "../ui/keys";

type Mode = "push_to_talk" | "toggle";

export function KeySection(props: { platform: WtPlatform }) {
  const { t } = useTranslation();
  const handy = useSettingsStore((s) => s.settings);
  const updateHandy = useSettingsStore((s) => s.updateSetting);
  const [down, setDown] = useState(false);
  const [worked, setWorked] = useState(false);
  useTauriEvent<boolean>("wt-key-state", (d) => {
    setDown(!!d);
    if (d) setWorked(true);
  });
  const mode: Mode | null =
    handy?.shortcut_activation === "toggle"
      ? "toggle"
      : handy?.shortcut_activation === "push_to_talk" ||
          !handy?.shortcut_activation
        ? "push_to_talk"
        : null;
  const binding = handy?.bindings?.[DICTATION_BINDING]?.current_binding ?? "";

  return (
    <Page title={t("wt.nav.key")}>
      <Group>
        <SettingRow
          title={t("wt.key.key")}
          description={
            props.platform === "macos"
              ? t("wt.key.keyDescMac")
              : t("wt.key.keyDescWindows")
          }
          stacked
        >
          <KeyPicker platform={props.platform} />
        </SettingRow>
        <SettingRow title={t("wt.key.mode")} stacked>
          {({ labelId }) => (
            <ChoiceGroup<Mode>
              labelledBy={labelId}
              value={mode}
              vertical
              onChange={(v) =>
                void updateHandy("shortcut_activation", v as ShortcutActivation)
              }
              options={[
                {
                  value: "push_to_talk",
                  label: t("wt.key.hold"),
                  description: t("wt.key.holdDesc"),
                },
                {
                  value: "toggle",
                  label: t("wt.key.tap"),
                  description: t("wt.key.tapDesc"),
                },
              ]}
            />
          )}
        </SettingRow>
        <SettingRow
          title={t("wt.key.test")}
          description={t("wt.key.testDesc")}
          stacked
        >
          <div className="wt-inline">
            <KeyCaps
              binding={binding}
              platform={props.platform}
              pressed={down}
            />
            {worked ? (
              <Status tone="ok">{t("wt.onboarding.key.works")}</Status>
            ) : null}
          </div>
        </SettingRow>
      </Group>
    </Page>
  );
}
