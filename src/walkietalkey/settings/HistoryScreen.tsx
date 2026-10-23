// Historik (spec 6.12, DESK-85, DESK-90..94): search, copy, delete, the
// source and cleanup of each dictation, "Vis hvad der blev sendt" for cloud
// cleanup, and the history settings.
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { commands, type HistoryItem, type HistoryRetention } from "@/bindings";
import { RETENTION_OPTIONS, type WtPlatform } from "../lib/helpers";
import { useTauriEvent } from "../lib/hooks";
import { useUi } from "../lib/uiStore";
import { useWtSettings, useWtStore } from "../lib/wtStore";
import { Button, Dialog, Group, Page, Select, SettingRow, Status, Switch, TextInput } from "../ui/controls";

function formatTime(seconds: number, locale: string): string {
  try {
    return new Intl.DateTimeFormat(locale === "en" ? "en-GB" : "da-DK", {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(seconds * 1000));
  } catch {
    return new Date(seconds * 1000).toLocaleString();
  }
}

function formatDuration(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1).replace(".", ",")} s`;
}

function Item(props: { item: HistoryItem; selected: boolean; onChanged: () => void }) {
  const { t, i18n } = useTranslation();
  const { item } = props;
  const [showSent, setShowSent] = useState(props.selected && !!item.cleanup);
  const [copied, setCopied] = useState(false);
  const ref = useRef<HTMLLIElement>(null);
  const sentId = useId();

  useEffect(() => {
    if (props.selected) {
      ref.current?.scrollIntoView?.({ block: "center" });
      ref.current?.focus();
    }
  }, [props.selected]);

  const copy = async () => {
    try {
      const r = await commands.wtHistoryCopy(item.id);
      setCopied(r.status === "ok");
    } catch {
      setCopied(false);
    }
  };
  const remove = async () => {
    try {
      await commands.wtHistoryDelete(item.id);
    } finally {
      props.onChanged();
    }
  };

  const source = item.source === "tast" ? t("wt.history.fromKey") : t("wt.history.fromPhone", { name: item.source });
  return (
    <li
      ref={ref}
      tabIndex={-1}
      className="wt-history-item"
      data-selected={props.selected || undefined}
      aria-current={props.selected ? "true" : undefined}
    >
      <div className="wt-history-meta">
        <time dateTime={new Date(item.timestamp * 1000).toISOString()}>
          {formatTime(item.timestamp, i18n.language)}
        </time>
        <span>{source}</span>
        {item.cleaned ? <span>{t("wt.history.cleaned")}</span> : null}
      </div>
      <p className="wt-history-text">{item.text}</p>
      <div className="wt-history-actions">
        <Button onClick={() => void copy()}>{copied ? t("wt.history.copied") : t("wt.common.copy")}</Button>
        <Button variant="quiet" onClick={() => void remove()}>
          {t("wt.common.delete")}
        </Button>
        {item.cleanup ? (
          <Button
            variant="quiet"
            aria-expanded={showSent}
            aria-controls={sentId}
            onClick={() => setShowSent((v) => !v)}
          >
            {t("wt.cleanup.showSent")}
          </Button>
        ) : null}
      </div>
      {item.cleanup && showSent ? (
        <div className="wt-sent" id={sentId}>
          <dl>
            <dt>{t("wt.history.provider")}</dt>
            <dd>{item.cleanup.provider}</dd>
            <dt>{t("wt.history.duration")}</dt>
            <dd>{formatDuration(item.cleanup.duration_ms)}</dd>
          </dl>
          <span className="wt-row-desc">{t("wt.history.sentText")}</span>
          <pre>{item.cleanup.sent_text}</pre>
        </div>
      ) : null}
    </li>
  );
}

export function HistoryScreen(_props: { platform: WtPlatform }) {
  const { t } = useTranslation();
  const wt = useWtSettings();
  const update = useWtStore((s) => s.update);
  const selectedId = useUi((s) => s.historyId);
  const sentOnly = useUi((s) => s.historySentOnly);
  const openHistory = useUi((s) => s.openHistory);
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<HistoryItem[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [confirmAll, setConfirmAll] = useState(false);
  const retentionId = useId();
  const searchId = useId();

  const load = useCallback(async (q: string) => {
    try {
      const r = await commands.wtHistoryList(q.trim() ? q.trim() : null);
      if (r.status === "ok") {
        setItems(r.data);
        setFailed(false);
      } else setFailed(true);
    } catch {
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    const id = setTimeout(() => void load(query), query ? 200 : 0);
    return () => clearTimeout(id);
  }, [query, load]);
  useTauriEvent("wt-history-changed", () => void load(query));

  const deleteAll = async () => {
    setConfirmAll(false);
    try {
      await commands.wtHistoryDelete(null);
    } finally {
      void load(query);
    }
  };

  const shown = (items ?? []).filter((i) => !sentOnly || !!i.cleanup);

  return (
    <Page title={t("wt.nav.history")} description={t("wt.history.intro")}>
      <div className="wt-history-tools" role="search">
        <label htmlFor={searchId} className="wt-visually-hidden">
          {t("wt.history.search")}
        </label>
        <TextInput
          id={searchId}
          type="search"
          placeholder={t("wt.history.search")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <Button
          variant={sentOnly ? "primary" : "secondary"}
          aria-pressed={sentOnly}
          onClick={() => openHistory(null, !sentOnly)}
        >
          {t("wt.history.sentOnly")}
        </Button>
      </div>

      <div className="wt-card">
        {failed ? (
          <p className="wt-empty">{t("wt.history.loadFailed")}</p>
        ) : items === null ? null : shown.length ? (
          <ul className="wt-history-list" aria-label={t("wt.history.listLabel")}>
            {shown.map((item) => (
              <Item
                key={item.id}
                item={item}
                selected={item.id === selectedId}
                onChanged={() => void load(query)}
              />
            ))}
          </ul>
        ) : (
          <p className="wt-empty">{query ? t("wt.history.noMatches") : t("wt.history.empty")}</p>
        )}
      </div>

      <Group title={t("wt.history.settings")}>
        <SettingRow
          title={t("wt.history.retention")}
          description={t("wt.history.retentionDesc")}
          lockField="history_retention"
          htmlFor={retentionId}
        >
          {({ locked }) => (
            <Select
              id={retentionId}
              disabled={locked}
              value={wt?.history_retention ?? "two_weeks"}
              onChange={(e) => void update({ history_retention: e.target.value as HistoryRetention })}
            >
              {RETENTION_OPTIONS.map((o) => (
                <option key={o} value={o}>
                  {t(`wt.history.keep.${o}`)}
                </option>
              ))}
            </Select>
          )}
        </SettingRow>
        <SettingRow title={t("wt.history.keepAudio")} description={t("wt.history.keepAudioDesc")}>
          {({ labelId, descId }) => (
            <Switch
              labelledBy={labelId}
              describedBy={descId}
              checked={!!wt?.keep_audio_for_debugging}
              onChange={(v) => void update({ keep_audio_for_debugging: v })}
            />
          )}
        </SettingRow>
        <SettingRow title={t("wt.history.deleteAllTitle")} description={t("wt.history.deleteAllDesc")}>
          <Button variant="danger" onClick={() => setConfirmAll(true)}>
            {t("wt.history.deleteAll")}
          </Button>
        </SettingRow>
      </Group>
      <p className="wt-note">{t("wt.history.storage")}</p>

      <Dialog
        open={confirmAll}
        alert
        title={t("wt.history.deleteAllConfirmTitle")}
        onCancel={() => setConfirmAll(false)}
        actions={
          <>
            <Button data-autofocus onClick={() => setConfirmAll(false)}>
              {t("wt.common.cancel")}
            </Button>
            <Button variant="danger" onClick={() => void deleteAll()}>
              {t("wt.history.deleteAll")}
            </Button>
          </>
        }
      >
        <p>{t("wt.history.deleteAllConfirm")}</p>
      </Dialog>
      {items && failed ? <Status tone="warn">{t("wt.history.loadFailed")}</Status> : null}
    </Page>
  );
}
