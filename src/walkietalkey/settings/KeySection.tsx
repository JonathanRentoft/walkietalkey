// Indstillinger › Tast (spec 6.14, DESK-20..22, run 2 Phase 1): the key, how
// it works (tap or hold; the mode itself lives under Avanceret), a live test,
// and "Ret det for mig" when macOS still gives the Globe key its own action.
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useSettingsStore } from "@/stores/settingsStore";
import { keyModeKey, type WtPlatform } from "../lib/helpers";
import { useTauriEvent } from "../lib/hooks";
import { Group, Page, SettingRow, Status } from "../ui/controls";
import { GlobeFix } from "../ui/globeFix";
import { DICTATION_BINDING, KeyCaps, KeyPicker, useKeyName } from "../ui/keys";

export function KeySection(props: { platform: WtPlatform }) {
  const { t } = useTranslation();
  const handy = useSettingsStore((s) => s.settings);
  const key = useKeyName(props.platform);
  const [down, setDown] = useState(false);
  const [worked, setWorked] = useState(false);
  useTauriEvent<boolean>("wt-key-state", (d) => {
    setDown(!!d);
    if (d) setWorked(true);
  });
  const binding = handy?.bindings?.[DICTATION_BINDING]?.current_binding ?? "";

  return (
    <Page
      title={t("wt.nav.key")}
      description={t(keyModeKey(handy?.shortcut_activation), { key })}
    >
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
        <GlobeFix
          platform={props.platform}
          variant="row"
          title={t("wt.globe.title")}
        />
      </Group>
      <Group>
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
              size={52}
            />
            {worked ? <Status tone="ok">{t("wt.key.works")}</Status> : null}
          </div>
        </SettingRow>
      </Group>
    </Page>
  );
}
