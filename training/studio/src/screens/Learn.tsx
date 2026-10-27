/* Lær det (run 11): the learning notebooks in order, each opened in VS Code as the owner's own
   working copy (the server copies it to <work>/notebooks/ first), and "Start forfra" to put the
   original back, after a confirm. Each card says whether the copy exists and has been run. */
import { useState } from "react";
import { ApiError, api } from "../api/client";
import { useResource } from "../api/hooks";
import type {
  LearnListing,
  LearnNotebook,
  LearnOpenAnswer,
  LearnResetAnswer,
} from "../api/types";
import { IconCheck } from "../components/icons";
import {
  Button,
  Card,
  Empty,
  ErrorBox,
  Loading,
  PageHeader,
} from "../components/ui";
import { dateTime, int } from "../lib/format";
import { errorText, S } from "../strings";

const L = S.learn;

/** "01", as the notebook's own title heading numbers it. */
export function numberOf(n: LearnNotebook): string {
  return n.number === null ? "" : String(n.number).padStart(2, "0");
}

type Feedback = { ok: boolean; text: string } | null;

/** One notebook. `onChanged` gets the notebook as the server answered it after an action. */
function NotebookCard({
  notebook: nb,
  onChanged,
}: {
  notebook: LearnNotebook;
  onChanged: (n: LearnNotebook | null) => void;
}) {
  const [busy, setBusy] = useState<"open" | "reset" | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);

  async function open() {
    setBusy("open");
    setFeedback(null);
    try {
      const answer = await api.post<LearnOpenAnswer>("/api/learn/open", {
        name: nb.name,
      });
      setFeedback({
        ok: true,
        text: answer.created ? L.openedNew : L.opened,
      });
      onChanged(answer.notebook);
    } catch (e) {
      setFeedback({
        ok: false,
        text: errorText((e as ApiError).code, "learn"),
      });
      // no-vscode: the copy is made all the same.
      onChanged(null);
    } finally {
      setBusy(null);
    }
  }

  async function reset() {
    setBusy("reset");
    setFeedback(null);
    try {
      const answer = await api.post<LearnResetAnswer>("/api/learn/reset", {
        name: nb.name,
      });
      setFeedback({ ok: true, text: L.resetDone });
      onChanged(answer.notebook);
    } catch (e) {
      setFeedback({
        ok: false,
        text: errorText((e as ApiError).code, "learn"),
      });
    } finally {
      setBusy(null);
      setConfirming(false);
    }
  }

  const number = numberOf(nb);
  return (
    <li>
      <Card className="notebook">
        <div className="notebook-main">
          {number && (
            <span className="notebook-number" aria-hidden="true">
              {number}
            </span>
          )}
          <div className="notebook-text">
            <h2 className="notebook-title">
              {number && <span className="sr">{number} </span>}
              {nb.title}
            </h2>
            {nb.summary && <p className="notebook-summary">{nb.summary}</p>}
            <p className="notebook-meta">
              {nb.minutes !== null && <span>{L.minutes(int(nb.minutes))}</span>}
              {nb.copy ? (
                <>
                  <span>{L.saved(dateTime(nb.saved))}</span>
                  <span className={`tag ${nb.ran ? "tag--ran" : "tag--quiet"}`}>
                    {nb.ran && <IconCheck size={13} />}
                    {nb.ran ? L.ran : L.notRun}
                  </span>
                </>
              ) : (
                <span className="tag tag--quiet">{L.notOpened}</span>
              )}
            </p>
          </div>
        </div>
        <div className="notebook-side">
          <Button
            variant="primary"
            onClick={open}
            disabled={busy !== null}
            busy={busy === "open"}
            aria-label={L.openLabel(nb.title)}
          >
            {busy === "open" ? L.opening : L.open}
          </Button>
          {nb.copy && !confirming && (
            <Button
              variant="quiet"
              size="sm"
              onClick={() => setConfirming(true)}
              disabled={busy !== null}
              aria-label={L.resetLabel(nb.title)}
            >
              {L.reset}
            </Button>
          )}
        </div>
        {confirming && (
          <div
            className="confirm notebook-confirm"
            role="group"
            aria-label={L.reset}
          >
            <p>{L.resetConfirm}</p>
            <div className="row-inline">
              <Button
                variant="danger"
                onClick={reset}
                disabled={busy !== null}
                busy={busy === "reset"}
              >
                {busy === "reset" ? L.resetting : L.resetYes}
              </Button>
              <Button onClick={() => setConfirming(false)} autoFocus>
                {L.resetNo}
              </Button>
            </div>
          </div>
        )}
        {feedback && (
          <p
            className={
              feedback.ok ? "feedback ok notebook-feedback" : "inline-error"
            }
            role={feedback.ok ? "status" : "alert"}
          >
            {feedback.ok && <IconCheck size={15} />}
            {feedback.text}
          </p>
        )}
      </Card>
    </li>
  );
}

export function LearnScreen() {
  const res = useResource<LearnListing>("/api/learn");
  const list = res.data;
  const changed = (n: LearnNotebook | null) => {
    // Show the server's answer at once, then the whole list as it is now.
    if (n && list)
      res.set({
        ...list,
        notebooks: list.notebooks.map((x) => (x.name === n.name ? n : x)),
      });
    res.reload();
  };
  return (
    <>
      <PageHeader title={L.title} intro={L.intro} />
      <ErrorBox error={res.error} onRetry={res.reload} area="learn" />
      {!list ? (
        !res.error && <Loading />
      ) : list.notebooks.length === 0 ? (
        <Empty what={L.emptyWhat} when={L.emptyWhen} />
      ) : (
        <>
          <div className="learn-help">
            <p className="help">{L.setup}</p>
            <p className="help">{L.copies(list.copies)}</p>
          </div>
          <ol className="notebooks" aria-label={L.listLabel}>
            {list.notebooks.map((n) => (
              <NotebookCard key={n.name} notebook={n} onChanged={changed} />
            ))}
          </ol>
        </>
      )}
    </>
  );
}
