/* Dine egne ord (run 12): the English words of the owner's own dictations that spelling.yaml does
   not cover yet, by how often he said them. He ticks the ones Edda should learn and may write
   sentences of his own with them. Only the words and their counts come from the history: no
   sentence of it is shown, and a word is only ever sent in a POST body, never in a URL. */
import { useState, type FormEvent } from "react";
import { ApiError, api } from "../api/client";
import { useResource } from "../api/hooks";
import type {
  OwnSentenceAnswer,
  OwnWord,
  OwnWordsView,
  TickedWord,
} from "../api/types";
import { IconCheck } from "../components/icons";
import {
  Button,
  Card,
  Empty,
  ErrorBox,
  Loading,
  Notice,
  PageHeader,
  Section,
} from "../components/ui";
import { int, pct } from "../lib/format";
import { errorText, S } from "../strings";
import { shortPath } from "./Learn";

const O = S.ownwords;

/** "14 gange · i 9 dikteringer · 1,1 % af dikteringerne". */
export function said(w: {
  count: number | null;
  dictations: number | null;
  share: number | null;
}): string {
  if (w.count === null || w.dictations === null) return O.notInHistory;
  return [
    w.count === 1 ? O.once : O.times(int(w.count)),
    w.dictations === 1 ? O.inOne : O.inDictations(int(w.dictations)),
    w.share !== null ? O.share(pct(w.share, 1)) : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

function NewWord({
  word,
  busy,
  onTick,
}: {
  word: OwnWord;
  busy: boolean;
  onTick: (word: string, ticked: boolean) => void;
}) {
  return (
    <li className="word-row">
      <label className="check word-check">
        <input
          type="checkbox"
          checked={false}
          disabled={busy}
          onChange={() => onTick(word.word, true)}
        />
        <span className="word-body">
          <span className="word-name">
            {word.word}
            {word.phrase && <span className="tag tag--quiet">{O.phrase}</span>}
          </span>
          <span className="word-meta">{said(word)}</span>
        </span>
      </label>
    </li>
  );
}

function MyWord({
  word,
  busy,
  onTick,
  onChanged,
}: {
  word: TickedWord;
  busy: boolean;
  onTick: (word: string, ticked: boolean) => void;
  onChanged: (view: OwnWordsView) => void;
}) {
  const [text, setText] = useState("");
  const [adding, setAdding] = useState(false);
  const [feedback, setFeedback] = useState<{
    ok: boolean;
    text: string;
  } | null>(null);
  const id = `own-${word.word.replace(/[^\p{L}\p{N}]+/gu, "-")}`;

  async function add(e: FormEvent) {
    e.preventDefault();
    if (!text.trim()) return;
    setAdding(true);
    setFeedback(null);
    try {
      const answer = await api.post<OwnSentenceAnswer>(
        "/api/ownwords/sentence",
        { word: word.word, text },
      );
      setText("");
      setFeedback({ ok: true, text: O.added });
      onChanged(answer);
    } catch (err) {
      setFeedback({
        ok: false,
        text: errorText((err as ApiError).code, "ownwords"),
      });
    } finally {
      setAdding(false);
    }
  }

  return (
    <li>
      <Card className="my-word">
        <div className="my-word-head">
          <div>
            <h3 className="word-name">
              {word.word}
              {word.phrase && (
                <span className="tag tag--quiet">{O.phrase}</span>
              )}
            </h3>
            <p className="word-meta">{said(word)}</p>
          </div>
          <Button
            variant="quiet"
            size="sm"
            disabled={busy}
            onClick={() => onTick(word.word, false)}
            aria-label={O.untickLabel(word.word)}
          >
            {O.untick}
          </Button>
        </div>
        {word.sentences.length > 0 ? (
          <ol className="my-sentences">
            {word.sentences.map((s) => (
              <li key={s.id}>
                <span className="my-sentence-id">{s.id}</span> {s.text}
              </li>
            ))}
          </ol>
        ) : (
          <p className="help">{O.noSentences}</p>
        )}
        <form className="my-word-form" onSubmit={add}>
          <label className="field" htmlFor={id}>
            <span>{O.sentenceLabel(word.word)}</span>
          </label>
          <div className="row-inline">
            <input
              id={id}
              type="text"
              value={text}
              maxLength={300}
              onChange={(e) => setText(e.target.value)}
              aria-describedby={`${id}-rules`}
            />
            <Button
              type="submit"
              disabled={adding || !text.trim()}
              busy={adding}
            >
              {adding ? O.adding : O.add}
            </Button>
          </div>
          <p className="help" id={`${id}-rules`}>
            {O.rules}
          </p>
          {feedback && (
            <p
              className={feedback.ok ? "feedback ok" : "inline-error"}
              role={feedback.ok ? "status" : "alert"}
            >
              {feedback.ok && <IconCheck size={15} />}
              {feedback.text}
            </p>
          )}
        </form>
      </Card>
    </li>
  );
}

export function OwnWordsScreen() {
  const res = useResource<OwnWordsView>("/api/ownwords");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const v = res.data;

  async function tick(word: string, ticked: boolean) {
    setBusy(true);
    setError(null);
    try {
      res.set(
        await api.post<OwnWordsView>("/api/ownwords/tick", { word, ticked }),
      );
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader title={O.title} intro={O.intro} />
      <ErrorBox error={res.error} onRetry={res.reload} area="ownwords" />
      {error && (
        <p className="inline-error" role="alert">
          {errorText(error.code, "ownwords")}
        </p>
      )}
      {!v ? (
        !res.error && <Loading />
      ) : !v.history.found ? (
        <Empty
          what={O.noHistoryWhat}
          when={O.noHistoryWhen}
          code={v.history.path}
        />
      ) : !v.history.readable ? (
        <Notice kind="warn" role="alert">
          <p>{O.unreadable}</p>
          <Button size="sm" onClick={res.reload}>
            {S.common.retry}
          </Button>
        </Notice>
      ) : (
        <>
          <div className="own-help">
            <p className="help">{O.privacy}</p>
            <p className="help">{O.source(int(v.history.dictations))}</p>
          </div>
          <Section id="new-words" title={O.newTitle} help={O.newHelp}>
            {v.words.length > 0 ? (
              <Card className="words-card">
                <ul className="words" aria-label={O.listLabel}>
                  {v.words.map((w) => (
                    <NewWord key={w.word} word={w} busy={busy} onTick={tick} />
                  ))}
                </ul>
                {v.more > 0 && <p className="help">{O.more(int(v.more))}</p>}
              </Card>
            ) : v.found === 0 ? (
              <Empty what={O.noWordsWhat} when={O.noWordsWhen} />
            ) : (
              <Empty what={O.allTicked} />
            )}
          </Section>
          <Section id="my-words" title={O.mineTitle} help={O.mineHelp}>
            {v.ticked.length > 0 ? (
              <ul className="my-words" aria-label={O.mineLabel}>
                {v.ticked.map((w) => (
                  <MyWord
                    key={w.word}
                    word={w}
                    busy={busy}
                    onTick={tick}
                    onChanged={res.set}
                  />
                ))}
              </ul>
            ) : (
              <Empty what={O.mineWhat} when={O.mineWhen} />
            )}
          </Section>
          <p className="help own-files">
            {O.files(shortPath(v.files.words), shortPath(v.files.sentences))}
          </p>
        </>
      )}
    </>
  );
}
