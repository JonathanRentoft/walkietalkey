// Indstillinger › Model (spec 6.5, 6.14, DESK-34, DESK-45).
import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { LogoLoader } from "@walkietalkey/ui";
import {
  commands,
  type ModelInfo,
  type ModelUnloadTimeout,
  type ModelVersion,
  type PncStatus,
} from "@/bindings";
import { useModelStore } from "@/stores/modelStore";
import { useSettingsStore } from "@/stores/settingsStore";
import {
  EDDA_MODEL_ID,
  formatSizeMb,
  formatValidationWer,
  formatVersionDate,
  totalSizeMb,
  unloadChoice,
  UNLOAD_OPTIONS,
  type UnloadChoice,
} from "../lib/helpers";
import { useTauriEvent } from "../lib/hooks";
import { useLocked } from "../lib/wtStore";
import {
  Button,
  ChoiceGroup,
  Group,
  Page,
  Select,
  SettingRow,
  Status,
} from "../ui/controls";

/** Ekko PnC, the punctuation model (DESK-41): fetched at start when missing. */
function PunctuationRow() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<PncStatus | null>(null);
  useEffect(() => {
    commands
      .wtPunctuationStatus()
      .then(setStatus)
      .catch(() => setStatus(null));
  }, []);
  useTauriEvent<PncStatus>("wt-punctuation-status", setStatus);
  if (!status) return null;
  const text = {
    ready: t("wt.modelSettings.punctuation.ready"),
    missing: t("wt.modelSettings.punctuation.missing"),
    downloading: t("wt.modelSettings.punctuation.downloading"),
    failed: t("wt.modelSettings.punctuation.failed"),
    unsupported: t("wt.modelSettings.punctuation.unsupported"),
  }[status.state];
  const tone =
    status.state === "ready"
      ? "ok"
      : status.state === "failed"
        ? "warn"
        : "muted";
  return (
    <SettingRow
      title={t("wt.modelSettings.punctuation.title")}
      description={t("wt.modelSettings.punctuation.desc")}
    >
      <>
        <Status tone={tone}>{text}</Status>
        {status.state === "failed" || status.state === "missing" ? (
          <Button
            onClick={() =>
              void commands.wtPunctuationDownload().catch(() => {})
            }
          >
            {t("wt.modelSettings.punctuation.retry")}
          </Button>
        ) : null}
      </>
    </SettingRow>
  );
}

/** Run 6: the base Edda and every installed version of it, from the
 *  workbench (versions.rs). Switching is rolling back; the base always stays. */
function VersionsGroup() {
  const { t } = useTranslation();
  const current = useModelStore((s) => s.currentModel);
  const models = useModelStore((s) => s.models);
  const selectModel = useModelStore((s) => s.selectModel);
  const locked = useLocked("selected_model");
  const [rows, setRows] = useState<ModelVersion[]>([]);
  const [failed, setFailed] = useState(false);
  const refresh = () =>
    void commands
      .wtModelVersions()
      .then(setRows)
      .catch(() => setRows([]));
  // A new selection, a new file, or `wt-train use` from the terminal.
  useEffect(refresh, [current, models]);
  useTauriEvent<{ model_id: string; error: string | null }>(
    "wt-model-switched",
    (e) => {
      setFailed(!!e?.error);
      void useModelStore.getState().loadCurrentModel();
      refresh();
    },
  );
  if (rows.length < 2) return null;
  const use = async (id: string) => {
    setFailed(false);
    const ok = await selectModel(id);
    if (ok === false) setFailed(true);
    refresh();
  };
  return (
    <Group
      title={t("wt.modelSettings.versions")}
      description={t("wt.modelSettings.versionsDesc")}
    >
      <ul className="wt-list">
        {rows.map((v) => {
          const selected = v.id === current || (v.selected && !current);
          const facts = v.base
            ? [t("wt.modelSettings.baseNote")]
            : [
                v.version !== null
                  ? t("wt.modelSettings.versionLabel", { n: v.version })
                  : null,
                formatVersionDate(v.created),
                v.validation_wer !== null
                  ? t("wt.modelSettings.werLabel", {
                      wer: formatValidationWer(v.validation_wer),
                    })
                  : null,
              ].filter(Boolean);
          return (
            <li key={v.id} className="wt-list-item">
              <div className="wt-list-main">
                <span>{v.name}</span>
                <span className="wt-list-sub">{facts.join(" · ")}</span>
              </div>
              <div className="wt-row-control">
                {selected ? (
                  <Status tone="ok">{t("wt.modelSettings.inUse")}</Status>
                ) : (
                  <Button
                    disabled={locked}
                    aria-label={t("wt.modelSettings.useNamed", {
                      name: v.name,
                    })}
                    onClick={() => void use(v.id)}
                  >
                    {t("wt.modelSettings.use")}
                  </Button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      {failed ? (
        <div className="wt-row">
          <Status tone="warn">{t("wt.modelSettings.switchFailed")}</Status>
        </div>
      ) : null}
    </Group>
  );
}

function DownloadState(props: { model: ModelInfo }) {
  const { t } = useTranslation();
  const progress = useModelStore((s) => s.downloadProgress[props.model.id]);
  const downloading = useModelStore(
    (s) => !!s.downloadingModels[props.model.id],
  );
  if (!downloading) return null;
  const ratio = progress
    ? Math.max(0, Math.min(1, progress.percentage / 100))
    : 0;
  return (
    <span className="wt-inline" role="status">
      <LogoLoader
        variant="fyld"
        size={16}
        progress={ratio}
        label={t("wt.modelSettings.downloadingNamed", {
          name: props.model.name,
        })}
      />
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
        <SettingRow
          title={t("wt.modelSettings.selected")}
          lockField="selected_model"
          htmlFor={selectId}
        >
          <Select
            id={selectId}
            disabled={modelLocked || !downloaded.length}
            value={current}
            onChange={(e) => void store.selectModel(e.target.value)}
          >
            {!current ? (
              <option value="">{t("wt.modelSettings.none")}</option>
            ) : null}
            {downloaded.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </Select>
        </SettingRow>
        <SettingRow
          title={t("wt.modelSettings.keepLoaded")}
          description={t("wt.modelSettings.keepLoadedDesc")}
          stacked
        >
          {({ labelId }) => (
            <ChoiceGroup<UnloadChoice>
              labelledBy={labelId}
              value={unloadChoice(unload)}
              onChange={(v) => void setUnload(v)}
              options={UNLOAD_OPTIONS.map((o) => ({
                value: o.value,
                label: t(o.labelKey),
              }))}
            />
          )}
        </SettingRow>
        <SettingRow
          title={t("wt.modelSettings.redownloadTitle")}
          description={t("wt.modelSettings.redownloadDesc")}
        >
          <>
            {currentInfo ? <DownloadState model={currentInfo} /> : null}
            {/* A custom file (a workbench fine-tune) cannot be fetched again,
                and redownload() deletes it first. */}
            <Button
              disabled={
                !currentInfo || currentInfo.is_custom || !!busy || modelLocked
              }
              onClick={() => void redownload()}
            >
              {t("wt.modelSettings.redownload")}
            </Button>
          </>
        </SettingRow>
        {failed ? (
          <div className="wt-row">
            <Status tone="warn">{t("wt.model.downloadFailed")}</Status>
          </div>
        ) : null}
        <PunctuationRow />
        <SettingRow
          title={t("wt.modelSettings.space")}
          description={t("wt.modelSettings.spaceDesc")}
        >
          <span className="wt-mono">{formatSizeMb(totalSizeMb(models))}</span>
        </SettingRow>
      </Group>

      <VersionsGroup />

      <Group
        title={t("wt.modelSettings.others")}
        description={t("wt.modelSettings.othersDesc")}
      >
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
                        aria-label={t("wt.modelSettings.useNamed", {
                          name: m.name,
                        })}
                        onClick={() => void store.selectModel(m.id)}
                      >
                        {t("wt.modelSettings.use")}
                      </Button>
                      {/* Run 6: the base Edda always stays. */}
                      {m.id === EDDA_MODEL_ID ? null : (
                        <Button
                          variant="quiet"
                          aria-label={t("wt.modelSettings.deleteNamed", {
                            name: m.name,
                          })}
                          onClick={() => void store.deleteModel(m.id)}
                        >
                          {t("wt.common.delete")}
                        </Button>
                      )}
                    </>
                  ) : store.downloadingModels[m.id] ? (
                    <Button onClick={() => void store.cancelDownload(m.id)}>
                      {t("wt.common.cancel")}
                    </Button>
                  ) : (
                    <Button
                      aria-label={t("wt.modelSettings.downloadNamed", {
                        name: m.name,
                      })}
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
