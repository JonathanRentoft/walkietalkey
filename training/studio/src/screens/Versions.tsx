/* Versioner: the base Edda and the installed fine-tuned versions, which one the app uses, one click
   to switch (and back), and exporting a training run (a job, its log while it runs). */
import { useEffect, useState } from "react";
import { ApiError, api } from "../api/client";
import { useJob, useResource } from "../api/hooks";
import type { Job, UseAnswer, Versions } from "../api/types";
import { IconCheck } from "../components/icons";
import {
  Button,
  Card,
  ErrorBox,
  JobPanel,
  Loading,
  Notice,
  PageHeader,
  Section,
} from "../components/ui";
import { dateTime, int, pct } from "../lib/format";
import { errorText, S } from "../strings";

const V = S.versions;

type Choice = number | "edda";

export function VersionsScreen() {
  const res = useResource<Versions>("/api/versions");
  const v = res.data;
  const [using, setUsing] = useState<Choice | null>(null);
  const [feedback, setFeedback] = useState<{
    ok: boolean;
    text: string;
    detail?: string;
  } | null>(null);

  const nameOf = (id: string | null) => {
    if (!v || !id) return null;
    if (id === v.base.id) return v.base.name;
    return v.versions.find((x) => x.id === id)?.name ?? id;
  };

  async function use(choice: Choice, name: string) {
    setUsing(choice);
    setFeedback(null);
    try {
      const answer = await api.post<UseAnswer>("/api/versions/use", {
        version: choice,
      });
      res.reload();
      setFeedback({
        ok: answer.ok !== false,
        text:
          answer.ok !== false
            ? V.switched(nameOf(answer.in_app) ?? name)
            : S.errors.generic,
      });
    } catch (e) {
      const err = e as ApiError;
      setFeedback({
        ok: false,
        text: errorText(err.code, "versions"),
        // use-failed: the English message says why (no app, too old, not installed).
        detail: err.code === "use-failed" ? err.message : undefined,
      });
    } finally {
      setUsing(null);
    }
  }

  const inApp = v?.in_app ?? null;
  const baseInUse = !!v && inApp === v.base.id;

  return (
    <>
      <PageHeader title={V.title} intro={V.intro} />
      <ErrorBox error={res.error} onRetry={res.reload} />
      {!v ? (
        !res.error && <Loading />
      ) : (
        <>
          {!v.app.found && <Notice kind="warn">{V.appMissing}</Notice>}
          {v.app.found && !v.app.use && (
            <Notice kind="warn">{V.appCannot}</Notice>
          )}
          <p className="in-use" role="status" aria-live="polite">
            {nameOf(inApp) && V.inUse(nameOf(inApp)!)}
          </p>
          {feedback && (
            <p
              className={feedback.ok ? "feedback ok" : "inline-error"}
              role="status"
            >
              {feedback.ok && <IconCheck size={15} />}
              {feedback.text}
              {feedback.detail && (
                <span className="help block" lang="en">
                  {feedback.detail}
                </span>
              )}
            </p>
          )}

          <div className="versions">
            <Card className={`version ${baseInUse ? "version--on" : ""}`}>
              <div className="version-main">
                <p className="eyebrow">{V.base}</p>
                <h2 className="version-name">
                  {V.baseName(v.base.name)}
                  {baseInUse && (
                    <span className="badge badge--inuse">
                      <IconCheck />
                      {V.inUseBadge}
                    </span>
                  )}
                </h2>
                <p className="help mono-ish">{v.base.id}</p>
              </div>
              <div className="version-side">
                {!v.base.installed ? (
                  <span className="tag tag--quiet">{V.notInstalled}</span>
                ) : baseInUse ? null : (
                  <Button
                    variant={baseInUse ? "quiet" : "secondary"}
                    onClick={() => use("edda", v.base.name)}
                    disabled={
                      baseInUse || using !== null || (v.app.found && !v.app.use)
                    }
                    busy={using === "edda"}
                  >
                    {using === "edda" ? V.using : V.useBase(v.base.name)}
                  </Button>
                )}
              </div>
            </Card>

            {v.versions.length === 0 && <p className="empty">{V.empty}</p>}
            {v.versions.map((x) => {
              const on = x.id === inApp || x.in_app;
              return (
                <Card
                  key={x.id}
                  className={`version ${on ? "version--on" : ""}`}
                >
                  <div className="version-main">
                    <p className="eyebrow">{V.versionN(int(x.version))}</p>
                    <h2 className="version-name">
                      {x.name}
                      {on && (
                        <span className="badge badge--inuse">
                          <IconCheck />
                          {V.inUseBadge}
                        </span>
                      )}
                    </h2>
                    <dl className="version-facts">
                      <div>
                        <dt>{V.colWer}</dt>
                        <dd>{pct(x.validation_wer, 1)}</dd>
                      </div>
                      <div>
                        <dt>{V.colRun}</dt>
                        <dd className="mono-ish">{x.run ?? S.common.none}</dd>
                      </div>
                      <div>
                        <dt>{V.colDate}</dt>
                        <dd>{dateTime(x.date)}</dd>
                      </div>
                    </dl>
                  </div>
                  <div className="version-side">
                    {!x.installed ? (
                      <span className="tag tag--quiet">{V.notInstalled}</span>
                    ) : on ? null : (
                      <Button
                        variant={on ? "quiet" : "secondary"}
                        onClick={() => use(x.version, x.name)}
                        disabled={
                          on || using !== null || (v.app.found && !v.app.use)
                        }
                        busy={using === x.version}
                      >
                        {using === x.version ? V.using : V.use}
                      </Button>
                    )}
                  </div>
                </Card>
              );
            })}
          </div>

          <Export versions={v} onDone={res.reload} />
        </>
      )}
    </>
  );
}

function Export({
  versions,
  onDone,
}: {
  versions: Versions;
  onDone: () => void;
}) {
  const [run, setRun] = useState(versions.exportable[0]?.run ?? "");
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const { job, follow } = useJob(null, () => onDone());
  useEffect(() => {
    if (!run && versions.exportable[0]) setRun(versions.exportable[0].run);
  }, [versions.exportable, run]);

  async function start() {
    setBusy(true);
    setError(null);
    try {
      follow(await api.post<Job>("/api/versions/export", { run }));
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(false);
    }
  }
  const running = job?.status === "running";
  return (
    <Section id="export" title={V.exportTitle} help={V.exportHelp}>
      <Card>
        {versions.exportable.length === 0 ? (
          <p className="empty">{V.exportNone}</p>
        ) : (
          <div className="row-inline">
            <label className="field field--inline">
              <span>{V.exportRun}</span>
              <select
                value={run}
                onChange={(e) => setRun(e.target.value)}
                disabled={running}
              >
                {versions.exportable.map((r) => (
                  <option key={r.run} value={r.run}>
                    {r.run} ({pct(r.best_validation_wer, 1)})
                  </option>
                ))}
              </select>
            </label>
            <Button
              variant="primary"
              onClick={start}
              disabled={!run || running || busy}
              busy={running || busy}
            >
              {running ? V.exporting : V.export}
            </Button>
          </div>
        )}
        {error && (
          <p className="inline-error" role="alert">
            {errorText(error.code, "versions")}
          </p>
        )}
        {job && (
          <div className="job-wrap">
            <JobPanel job={job} />
            {job.status === "done" && (
              <p className="feedback ok" role="status">
                <IconCheck size={15} />
                {V.exported}
              </p>
            )}
            {job.status === "failed" && (
              <p className="inline-error">{V.exportFailed}</p>
            )}
            {job.status === "stopped" && (
              <p className="help">{V.exportStopped}</p>
            )}
          </div>
        )}
      </Card>
    </Section>
  );
}
