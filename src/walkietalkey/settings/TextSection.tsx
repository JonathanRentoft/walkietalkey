// Indstillinger › Tekst (spec 6.14, DESK-41, DESK-50..54).
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { commands, type OutputMode, type PunctuationMode } from "@/bindings";
import type { WtPlatform } from "../lib/helpers";
import { hasPermission, openAccessibilityPane, pasteKey } from "../lib/system";
import { useWtSettings, useWtStore } from "../lib/wtStore";
import {
  Button,
  ChoiceGroup,
  Group,
  Page,
  SettingRow,
  Status,
  Switch,
} from "../ui/controls";

export function TextSection(props: { platform: WtPlatform }) {
  const { t } = useTranslation();
  const wt = useWtSettings();
  const update = useWtStore((s) => s.update);
  const mac = props.platform === "macos";
  const [accessibility, setAccessibility] = useState<boolean | null>(null);

  useEffect(() => {
    if (mac) void hasPermission("accessibility").then(setAccessibility);
  }, [mac]);

  // After "Giv adgang" the grant arrives from System Settings; notice it.
  useEffect(() => {
    if (!mac || accessibility !== false) return;
    const id = setInterval(() => {
      void hasPermission("accessibility").then((ok) => {
        if (!ok) return;
        setAccessibility(true);
        void commands.initializeEnigo().catch(() => {});
      });
    }, 1000);
    return () => clearInterval(id);
  }, [mac, accessibility]);

  const allow = () => void openAccessibilityPane();

  return (
    <Page title={t("wt.nav.text")}>
      <Group>
        <SettingRow
          title={t("wt.text.output")}
          description={t("wt.text.outputDesc", {
            key: pasteKey(props.platform),
          })}
          lockField="output_mode"
          stacked
        >
          {({ labelId, locked }) => (
            <>
              <ChoiceGroup<OutputMode>
                labelledBy={labelId}
                disabled={locked}
                value={wt?.output_mode ?? "paste"}
                onChange={(v) => void update({ output_mode: v })}
                options={[
                  { value: "paste", label: t("wt.text.paste") },
                  { value: "clipboard", label: t("wt.text.clipboard") },
                ]}
              />
              {mac &&
              wt?.output_mode !== "clipboard" &&
              accessibility === false ? (
                <div className="wt-inline">
                  <Status tone="warn">{t("wt.text.noAccessibility")}</Status>
                  <Button onClick={allow}>{t("wt.text.allow")}</Button>
                </div>
              ) : null}
            </>
          )}
        </SettingRow>
        <SettingRow
          title={t("wt.text.punctuation")}
          description={t("wt.text.punctuationDesc")}
          stacked
        >
          {({ labelId }) => (
            <ChoiceGroup<PunctuationMode>
              labelledBy={labelId}
              value={wt?.punctuation ?? "automatic"}
              onChange={(v) => void update({ punctuation: v })}
              options={[
                { value: "automatic", label: t("wt.text.automatic") },
                { value: "always", label: t("wt.text.always") },
                { value: "never", label: t("wt.text.never") },
              ]}
            />
          )}
        </SettingRow>
        <SettingRow
          title={t("wt.text.share")}
          description={
            mac ? t("wt.text.shareDescMac") : t("wt.text.shareDescWindows")
          }
          lockField="share_clipboard_with_devices"
        >
          {({ labelId, descId, locked }) => (
            <Switch
              labelledBy={labelId}
              describedBy={descId}
              disabled={locked}
              checked={!!wt?.share_clipboard_with_devices}
              onChange={(v) => void update({ share_clipboard_with_devices: v })}
            />
          )}
        </SettingRow>
      </Group>
    </Page>
  );
}
