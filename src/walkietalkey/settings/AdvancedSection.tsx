// Indstillinger › Avanceret (spec 6.14, DESK-04): relay address, manual
// model install, troubleshooting, paste delays and the command line. Handy's
// own controls are reused here as they are.
import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { open } from "@tauri-apps/plugin-dialog";
import { commands } from "@/bindings";
import { useModelStore } from "@/stores/modelStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { LogLevelSelector } from "@/components/settings/debug/LogLevelSelector";
import { PasteDelay } from "@/components/settings/debug/PasteDelay";
import { ReliablePasteToggle } from "@/components/settings/debug/ReliablePaste";
import { KeyboardDiagnostic } from "@/components/settings/debug/KeyboardDiagnostic";
import { LiveLogViewer } from "@/components/settings/debug/LiveLogViewer";
import { MicrophoneSelector } from "@/components/settings/MicrophoneSelector";
import { useWtSettings, useWtStore } from "../lib/wtStore";
import {
  Button,
  Group,
  Page,
  SettingRow,
  Status,
  Switch,
  TextInput,
} from "../ui/controls";

/** Saves on Enter or blur. */
function AddressField(props: {
  id: string;
  value: string;
  disabled: boolean;
  onCommit: (v: string) => void;
}) {
  const [draft, setDraft] = useState(props.value);
  useEffect(() => setDraft(props.value), [props.value]);
  const commit = () => {
    const v = draft.trim();
    if (v && v !== props.value) props.onCommit(v);
    else setDraft(props.value);
  };
  return (
    <TextInput
      id={props.id}
      className="wt-input--wide"
      value={draft}
      disabled={props.disabled}
      spellCheck={false}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
      }}
    />
  );
}

const CLI_FLAGS = [
  ["--toggle-transcription", "wt.advanced.cli.toggle"],
  ["--cancel", "wt.advanced.cli.cancel"],
  ["--start-hidden", "wt.advanced.cli.startHidden"],
  ["--no-tray", "wt.advanced.cli.noTray"],
  ["--debug", "wt.advanced.cli.debug"],
  ["-f <fil.wav> --json", "wt.advanced.cli.file"],
  ["--list-models", "wt.advanced.cli.listModels"],
] as const;

export function AdvancedSection() {
  const { t } = useTranslation();
  const wt = useWtSettings();
  const update = useWtStore((s) => s.update);
  const handy = useSettingsStore((s) => s.settings);
  const updateHandy = useSettingsStore((s) => s.updateSetting);
  const relayId = useId();
  const phoneId = useId();
  const [importState, setImportState] = useState<"idle" | "ok" | "failed">(
    "idle",
  );

  const importModel = async () => {
    setImportState("idle");
    let path: string | string[] | null = null;
    try {
      path = await open({
        multiple: false,
        directory: false,
        filters: [{ name: "GGUF", extensions: ["gguf"] }],
      });
    } catch {
      path = null;
    }
    if (!path || Array.isArray(path)) return;
    try {
      const r = await commands.wtImportModelFile(path);
      setImportState(r.status === "ok" ? "ok" : "failed");
      await useModelStore.getState().loadModels();
      await useModelStore.getState().loadCurrentModel();
    } catch {
      setImportState("failed");
    }
  };

  return (
    <Page title={t("wt.nav.advanced")} description={t("wt.advanced.intro")}>
      <Group title={t("wt.advanced.network")}>
        <SettingRow
          title={t("wt.advanced.relay")}
          description={t("wt.advanced.relayDesc")}
          lockField="relay_url"
          htmlFor={relayId}
          stacked
        >
          {({ locked }) => (
            <AddressField
              id={relayId}
              disabled={locked}
              value={wt?.relay_url ?? ""}
              onCommit={(v) => void update({ relay_url: v })}
            />
          )}
        </SettingRow>
        <SettingRow
          title={t("wt.advanced.phoneApp")}
          description={t("wt.advanced.phoneAppDesc")}
          lockField="phone_app_url"
          htmlFor={phoneId}
          stacked
        >
          {({ locked }) => (
            <AddressField
              id={phoneId}
              disabled={locked}
              value={wt?.phone_app_url ?? ""}
              onCommit={(v) => void update({ phone_app_url: v })}
            />
          )}
        </SettingRow>
      </Group>

      <Group title={t("wt.advanced.manualModels")}>
        <SettingRow
          title={t("wt.model.importFile")}
          description={t("wt.advanced.importDesc")}
        >
          <Button onClick={() => void importModel()}>
            {t("wt.model.importFile")}
          </Button>
        </SettingRow>
        {importState === "ok" ? (
          <div className="wt-row">
            <Status tone="ok">{t("wt.advanced.imported")}</Status>
          </div>
        ) : importState === "failed" ? (
          <div className="wt-row">
            <Status tone="warn">{t("wt.model.importFailed")}</Status>
          </div>
        ) : null}
        <SettingRow
          title={t("wt.advanced.dataFolder")}
          description={t("wt.advanced.dataFolderDesc")}
        >
          <Button
            onClick={() => void commands.openAppDataDir().catch(() => {})}
          >
            {t("wt.advanced.openFolder")}
          </Button>
        </SettingRow>
        {wt?.model_base_url ? (
          <SettingRow
            title={t("wt.advanced.modelServer")}
            lockField="model_base_url"
            stacked
          >
            <span className="wt-mono">{wt.model_base_url}</span>
          </SettingRow>
        ) : null}
      </Group>

      <Group title={t("wt.advanced.debugging")}>
        <SettingRow
          title={t("wt.advanced.debugMode")}
          description={t("wt.advanced.debugModeDesc")}
        >
          {({ labelId, descId }) => (
            <Switch
              labelledBy={labelId}
              describedBy={descId}
              checked={!!handy?.debug_mode}
              onChange={(v) => void updateHandy("debug_mode", v)}
            />
          )}
        </SettingRow>
        <SettingRow
          title={t("wt.advanced.logs")}
          description={t("wt.advanced.logsDesc")}
        >
          <Button onClick={() => void commands.openLogDir().catch(() => {})}>
            {t("wt.advanced.openLogs")}
          </Button>
        </SettingRow>
        <div className="wt-handy">
          <MicrophoneSelector descriptionMode="inline" grouped />
          <LogLevelSelector descriptionMode="inline" grouped />
          <KeyboardDiagnostic />
          {handy?.debug_mode ? (
            <LiveLogViewer descriptionMode="inline" grouped />
          ) : null}
        </div>
      </Group>

      <Group
        title={t("wt.advanced.pasteDelays")}
        description={t("wt.advanced.pasteDelaysDesc")}
      >
        <div className="wt-handy">
          <PasteDelay descriptionMode="inline" grouped />
          <PasteDelay
            descriptionMode="inline"
            grouped
            settingKey="paste_delay_after_ms"
            labelKey="settings.debug.pasteDelayAfter.title"
            descriptionKey="settings.debug.pasteDelayAfter.description"
          />
          <ReliablePasteToggle descriptionMode="inline" grouped />
        </div>
      </Group>

      <Group
        title={t("wt.advanced.cli.title")}
        description={t("wt.advanced.cli.desc")}
      >
        <ul className="wt-credits">
          {CLI_FLAGS.map(([flag, key]) => (
            <li key={flag}>
              <code className="wt-mono">{flag}</code>
              <p className="wt-note">{t(key)}</p>
            </li>
          ))}
        </ul>
      </Group>
    </Page>
  );
}
