// Indstillinger › Model (spec 6.5, 6.14, DESK-34, DESK-45).
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { LogoLoader } from "@walkietalkey/ui";
import { commands, type ModelInfo, type ModelUnloadTimeout } from "@/bindings";
import { useModelStore } from "@/stores/modelStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { formatSizeMb, totalSizeMb, unloadChoice, UNLOAD_OPTIONS, type UnloadChoice } from "../lib/helpers";
import { useLocked } from "../lib/wtStore";
import { Button, ChoiceGroup, Group, Page, Select, SettingRow, Status } from "../ui/controls";

function DownloadState(props: { model: ModelInfo }) {
  const { t } = useTranslation();
  const progress = useModelStore((s) => s.downloadProgress[props.model.id]);
  const downloading = useModelStore((s) => !!s.downloadingModels[props.model.id]);
  if (!downloading) return null;
  const ratio = progress ? Math.max(0, Math.min(1, progress.percentage / 100)) : 0;
  return (
    <span className="wt-inline" role="status">
      <LogoLoader variant="fyld" size={16} progress={ratio} label={t("wt.modelSettings.downloadingNamed", { name: props.model.name })} />
      <span className="wt-list-sub">{Math.round(ratio * 100)} %</span>
    </span>
  );
}

export function ModelSection() {
  const { t } = useTranslation();
  const models = useModelStore((s) => s.models);
  const current = useModelStore((s) => s.currentModel);
  const store = useModelStore();
  const unload = useSettingsStore((s) => s.settings?.model_unload_timeout);
  const refreshSettings = useSettingsStore((s) => s.refreshSettings);
  const modelLocked = useLocked("selected_model");
  const selectId = useId();
  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  const downloaded = models.filter((m) => m.is_downloaded);
  const others = models.filter((m) => m.id !== current);
  const currentInfo = models.find((m) => m.id === current);

  const setUnload = async (v: UnloadChoice) => {
    try {
      // Handy's serde names (min15, hour1); see helpers.ts.
      await commands.setModelUnloadTimeout(v as unknown as ModelUnloadTimeout);
    } finally {
      await refreshSettings();
    }
  };

  const redownload = async () => {
    if (!currentInfo) return;
    setFailed(false);
    setBusy(currentInfo.id);
    try {
      await store.deleteModel(currentInfo.id);
      const ok = await store.downloadModel(currentInfo.id);
      if (ok) await store.selectModel(currentInfo.id);
      else setFailed(true);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Page title={t("wt.nav.model")}>
      <Group>
        <SettingRow title={t("wt.modelSettings.selected")} lockField="selected_model" htmlFor={selectId}>
          <Select
            id={selectId}
            disabled={modelLocked || !downloaded.length}
            value={current}
            onChange={(e) => void store.selectModel(e.target.value)}
          >
            {!current ? <option value="">{t("wt.modelSettings.none")}</option> : null}
            {downloaded.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </Select>
        </SettingRow>
        <SettingRow title={t("wt.modelSettings.keepLoaded")} description={t("wt.modelSettings.keepLoadedDesc")} stacked>
          {({ labelId }) => (
            <ChoiceGroup<UnloadChoice>
              labelledBy={labelId}
              value={unloadChoice(unload)}
              onChange={(v) => void setUnload(v)}
              options={UNLOAD_OPTIONS.map((o) => ({ value: o.value, label: t(o.labelKey) }))}
            />
          )}
        </SettingRow>
        <SettingRow title={t("wt.modelSettings.redownloadTitle")} description={t("wt.modelSettings.redownloadDesc")}>
          <>
            {currentInfo ? <DownloadState model={currentInfo} /> : null}
            <Button disabled={!currentInfo || !!busy || modelLocked} onClick={() => void redownload()}>
              {t("wt.modelSettings.redownload")}
            </Button>
          </>
        </SettingRow>
        {failed ? (
          <div className="wt-row">
            <Status tone="warn">{t("wt.model.downloadFailed")}</Status>
          </div>
        ) : null}
        <SettingRow title={t("wt.modelSettings.space")} description={t("wt.modelSettings.spaceDesc")}>
          <span className="wt-mono">{formatSizeMb(totalSizeMb(models))}</span>
        </SettingRow>
      </Group>

      <Group title={t("wt.modelSettings.others")} description={t("wt.modelSettings.othersDesc")}>
        {others.length ? (
          <ul className="wt-list">
            {others.map((m) => (
              <li key={m.id} className="wt-list-item">
                <div className="wt-list-main">
                  <span>{m.name}</span>
                  <span className="wt-list-sub">
                    {formatSizeMb(m.size_mb)}
                    {m.is_downloaded ? `, ${t("wt.modelSettings.onDisk")}` : ""}
                  </span>
                </div>
                <div className="wt-row-control">
                  <DownloadState model={m} />
                  {m.is_downloaded ? (
                    <>
                      <Button
                        disabled={modelLocked}
                        aria-label={t("wt.modelSettings.useNamed", { name: m.name })}
                        onClick={() => void store.selectModel(m.id)}
                      >
                        {t("wt.modelSettings.use")}
                      </Button>
                      <Button
                        variant="quiet"
                        aria-label={t("wt.modelSettings.deleteNamed", { name: m.name })}
                        onClick={() => void store.deleteModel(m.id)}
                      >
                        {t("wt.common.delete")}
                      </Button>
                    </>
                  ) : store.downloadingModels[m.id] ? (
                    <Button onClick={() => void store.cancelDownload(m.id)}>{t("wt.common.cancel")}</Button>
                  ) : (
                    <Button
                      aria-label={t("wt.modelSettings.downloadNamed", { name: m.name })}
                      onClick={() => void store.downloadModel(m.id)}
                    >
                      {t("wt.modelSettings.download")}
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="wt-empty">{t("wt.modelSettings.noOthers")}</p>
        )}
      </Group>
    </Page>
  );
}
