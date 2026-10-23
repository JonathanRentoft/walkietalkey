// Indstillinger › Ordliste (spec 6.9, DESK-66..68): Ord (Handy's custom
// words, shown newest first), Erstatninger, Udviklerord, import and export.
import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { useSettingsStore } from "@/stores/settingsStore";
import {
  addWord,
  exportReplacements,
  exportWordList,
  importWords,
  newestFirst,
  parseReplacements,
  parseWordList,
  removeWord,
} from "../lib/helpers";
import {
  exportTextFile,
  importTextFile,
  type ExportResult,
} from "../lib/files";
import { useWtSettings, useWtStore } from "../lib/wtStore";
import {
  Button,
  Group,
  LockNote,
  Page,
  SettingRow,
  Status,
  Switch,
  TextInput,
} from "../ui/controls";

export function VocabularySection() {
  const { t } = useTranslation();
  const words = useSettingsStore((s) => s.settings?.custom_words ?? []);
  const updateHandy = useSettingsStore((s) => s.updateSetting);
  const wt = useWtSettings();
  const update = useWtStore((s) => s.update);
  const sourceLocked = useWtStore(
    (s) => !!s.view?.locked.includes("vocabulary_source"),
  );
  const [word, setWord] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const replacements = wt?.replacements ?? [];

  const setWords = (list: string[]) => void updateHandy("custom_words", list);

  const submitWord = (e: FormEvent) => {
    e.preventDefault();
    if (!word.trim()) return;
    setWords(addWord(words, word));
    setWord("");
  };

  const submitReplacement = (e: FormEvent) => {
    e.preventDefault();
    const f = from.trim();
    const w = to.trim();
    if (!f || !w) return;
    const rest = replacements.filter(
      (r) => r.from.toLowerCase() !== f.toLowerCase(),
    );
    void update({ replacements: [...rest, { from: f, to: w }] });
    setFrom("");
    setTo("");
  };

  const say = (r: ExportResult) => {
    if (r === "saved") setMessage(t("wt.vocabulary.exported"));
    else if (r === "copied") setMessage(t("wt.vocabulary.copied"));
    else if (r === "failed") setMessage(t("wt.vocabulary.exportFailed"));
  };

  const importWordFile = async () => {
    const text = await importTextFile();
    if (text == null) return;
    const imported = parseWordList(text);
    setWords(importWords(words, imported));
    setMessage(t("wt.vocabulary.importedWords", { count: imported.length }));
  };

  const importReplacementFile = async () => {
    const text = await importTextFile();
    if (text == null) return;
    const imported = parseReplacements(text);
    const keep = replacements.filter(
      (r) =>
        !imported.some((i) => i.from.toLowerCase() === r.from.toLowerCase()),
    );
    void update({ replacements: [...keep, ...imported] });
    setMessage(
      t("wt.vocabulary.importedReplacements", { count: imported.length }),
    );
  };

  return (
    <Page title={t("wt.nav.vocabulary")}>
      <Group
        title={t("wt.vocabulary.words")}
        description={t("wt.vocabulary.wordsDesc")}
      >
        <form className="wt-row" onSubmit={submitWord}>
          <div className="wt-inline">
            <TextInput
              aria-label={t("wt.vocabulary.newWord")}
              placeholder={t("wt.vocabulary.newWordPlaceholder")}
              value={word}
              onChange={(e) => setWord(e.target.value)}
            />
            <Button type="submit" disabled={!word.trim()}>
              {t("wt.vocabulary.addWord")}
            </Button>
          </div>
        </form>
        {words.length ? (
          <ul className="wt-list" aria-label={t("wt.vocabulary.words")}>
            {newestFirst(words).map((w) => (
              <li key={w} className="wt-list-item">
                <span>{w}</span>
                <Button
                  variant="quiet"
                  aria-label={t("wt.vocabulary.removeItem", { item: w })}
                  onClick={() => setWords(removeWord(words, w))}
                >
                  {t("wt.common.remove")}
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="wt-empty">{t("wt.vocabulary.noWords")}</p>
        )}
        {wt?.vocabulary_source ? (
          <div className="wt-row">
            <div className="wt-row-text">
              <span className="wt-row-desc">
                {t("wt.vocabulary.companyList")}
              </span>
              {sourceLocked ? <LockNote /> : null}
            </div>
          </div>
        ) : null}
      </Group>

      <Group
        title={t("wt.vocabulary.replacements")}
        description={t("wt.vocabulary.replacementsDesc")}
      >
        <form className="wt-row" onSubmit={submitReplacement}>
          <div className="wt-inline">
            <TextInput
              aria-label={t("wt.vocabulary.whenISay")}
              placeholder={t("wt.vocabulary.whenISay")}
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
            <TextInput
              aria-label={t("wt.vocabulary.write")}
              placeholder={t("wt.vocabulary.write")}
              value={to}
              onChange={(e) => setTo(e.target.value)}
            />
            <Button type="submit" disabled={!from.trim() || !to.trim()}>
              {t("wt.vocabulary.addReplacement")}
            </Button>
          </div>
        </form>
        {replacements.length ? (
          <ul className="wt-list" aria-label={t("wt.vocabulary.replacements")}>
            {newestFirst(replacements).map((r) => (
              <li key={r.from} className="wt-list-item">
                <span>
                  {t("wt.vocabulary.replacementItem", {
                    from: r.from,
                    to: r.to,
                  })}
                </span>
                <Button
                  variant="quiet"
                  aria-label={t("wt.vocabulary.removeItem", { item: r.from })}
                  onClick={() =>
                    void update({
                      replacements: replacements.filter(
                        (x) => x.from !== r.from,
                      ),
                    })
                  }
                >
                  {t("wt.common.remove")}
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="wt-empty">{t("wt.vocabulary.noReplacements")}</p>
        )}
      </Group>

      <Group>
        <SettingRow
          title={t("wt.vocabulary.developerWords")}
          description={t("wt.vocabulary.developerWordsDesc")}
        >
          {({ labelId, descId }) => (
            <Switch
              labelledBy={labelId}
              describedBy={descId}
              checked={!!wt?.developer_words}
              onChange={(v) => void update({ developer_words: v })}
            />
          )}
        </SettingRow>
        <SettingRow
          title={t("wt.vocabulary.importExport")}
          description={t("wt.vocabulary.importExportDesc")}
          stacked
        >
          <div className="wt-inline">
            <Button onClick={() => void importWordFile()}>
              {t("wt.vocabulary.importWords")}
            </Button>
            <Button
              onClick={() =>
                void exportTextFile("ord.txt", exportWordList(words)).then(say)
              }
            >
              {t("wt.vocabulary.exportWords")}
            </Button>
            <Button onClick={() => void importReplacementFile()}>
              {t("wt.vocabulary.importReplacements")}
            </Button>
            <Button
              onClick={() =>
                void exportTextFile(
                  "erstatninger.txt",
                  exportReplacements(replacements),
                ).then(say)
              }
            >
              {t("wt.vocabulary.exportReplacements")}
            </Button>
          </div>
          {message ? <Status>{message}</Status> : null}
        </SettingRow>
      </Group>
    </Page>
  );
}
