/* Run 12, test only on purpose: "Mål en model" measures a training run or Edda on the validation
   as a job (wt-train eval --dataset validation); the test set is a separate button that asks
   first, since it is for the final measurement and every use is written down. "Testsættet" shows
   whether the test set is frozen, and every use of it. */
import { useEffect, useState } from "react";
import { ApiError, api } from "../../api/client";
import { useJob, useResource } from "../../api/hooks";
import type {
  Job,
  MeasureBody,
  MeasureTargets,
  TestSet,
} from "../../api/types";
import { IconCheck } from "../../components/icons";
import {
  Button,
  Card,
  Empty,
  ErrorBox,
  JobPanel,
  Loading,
  Section,
} from "../../components/ui";
import { date, dateTime, int } from "../../lib/format";
import { errorText, S } from "../../strings";

const E = S.evaluation;
const EDDA = "edda";

export function MeasurePanel({ onMeasured }: { onMeasured: () => void }) {
  const t = useResource<MeasureTargets>("/api/eval/measure");
  const [ended, setEnded] = useState<Job | null>(null);
  const { job, follow } = useJob(null, (j) => {
    setEnded(j);
    onMeasured();
  });
  const [model, setModel] = useState<string | null>(null);
  const [build, setBuild] = useState<string | null>(null);
  const [skipFleurs, setSkipFleurs] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const targets = t.data;

  // A measurement that runs already (the page was opened while it ran) is followed.
  useEffect(() => {
    const running = targets?.job;
    if (running && running.status === "running" && running.id !== job?.id)
      follow(running);
  }, [targets?.job, job?.id, follow]);

  if (!targets)
    return (
      <Section id="measure" title={E.measureTitle} help={E.measureHelp}>
        <ErrorBox error={t.error} onRetry={t.reload} area="measure" />
        {!t.error && <Loading />}
      </Section>
    );

  const chosenModel =
    model ?? (targets.runs.length > 0 ? `run:${targets.runs[0].name}` : EDDA);
  const run = chosenModel.startsWith("run:")
    ? targets.runs.find((r) => r.name === chosenModel.slice(4))
    : undefined;
  const chosenBuild =
    build ??
    (targets.configs.find((c) => c.validation) ?? targets.configs[0])?.name ??
    null;
  const config = targets.configs.find((c) => c.name === chosenBuild);
  const edda = chosenModel === EDDA;
  const canValidation = edda ? !!config?.validation : !!run?.validation;
  const canTest = edda ? !!config?.test : !!run?.test;
  const running = job?.status === "running";
  const nothing =
    targets.runs.length === 0 && !targets.configs.some((c) => c.validation);

  async function start(dataset: "validation" | "test") {
    const body: MeasureBody = edda
      ? {
          backend: "hf",
          build: chosenBuild ?? "",
          dataset,
          fleurs: !skipFleurs,
        }
      : { backend: "lora", run: run?.name ?? "", dataset, fleurs: !skipFleurs };
    if (dataset === "test") body.confirm = true;
    setBusy(true);
    setError(null);
    setEnded(null);
    try {
      follow(await api.post<Job>("/api/eval/measure", body));
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  }

  return (
    <Section id="measure" title={E.measureTitle} help={E.measureHelp}>
      {nothing ? (
        <Empty
          what={E.measureEmptyWhat}
          when={E.measureEmptyWhen}
          code={
            targets.configs[0]
              ? `wt-train build configs/${targets.configs[0].name}.yaml`
              : undefined
          }
        />
      ) : (
        <Card className="measure">
          <div className="measure-fields">
            <label className="field">
              <span>{E.model}</span>
              <select
                value={chosenModel}
                onChange={(e) => {
                  setModel(e.target.value);
                  setConfirming(false);
                }}
              >
                {targets.runs.map((r) => (
                  <option key={r.name} value={`run:${r.name}`}>
                    {r.date ? `${r.title} · ${date(r.date)}` : r.title}
                  </option>
                ))}
                <option value={EDDA}>{targets.base}</option>
              </select>
            </label>
            {edda && (
              <label className="field">
                <span>{E.build}</span>
                <select
                  value={chosenBuild ?? ""}
                  onChange={(e) => {
                    setBuild(e.target.value);
                    setConfirming(false);
                  }}
                >
                  {targets.configs.map((c) => (
                    <option key={c.name} value={c.name}>
                      {c.validation ? c.name : E.notBuilt(c.name)}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
          {edda && config && !config.validation && (
            <div className="measure-hint">
              <p className="help">{E.buildFirst}</p>
              <code className="empty-code">
                wt-train build configs/{config.name}.yaml
              </code>
            </div>
          )}
          <label className="check">
            <input
              type="checkbox"
              checked={skipFleurs}
              onChange={(e) => setSkipFleurs(e.target.checked)}
            />
            <span>
              {E.skipFleurs}
              <span className="help block">{E.skipFleursHelp}</span>
            </span>
          </label>
          <div className="row-inline measure-actions">
            <Button
              variant="primary"
              onClick={() => start("validation")}
              disabled={!canValidation || running || busy}
              busy={busy && !confirming}
            >
              {running ? E.measuring : E.onValidation}
            </Button>
            {!confirming && (
              <Button
                onClick={() => setConfirming(true)}
                disabled={!canTest || running || busy}
              >
                {E.onTest}
              </Button>
            )}
          </div>
          {confirming && (
            <div className="confirm" role="group" aria-label={E.confirmLabel}>
              <p>{E.confirmText}</p>
              <div className="row-inline">
                <Button
                  variant="danger"
                  onClick={() => start("test")}
                  disabled={busy}
                  busy={busy}
                >
                  {E.confirmYes}
                </Button>
                <Button onClick={() => setConfirming(false)} autoFocus>
                  {E.confirmNo}
                </Button>
              </div>
            </div>
          )}
          {error && (
            <p className="inline-error" role="alert">
              {errorText(error.code, "measure")}
            </p>
          )}
          {job && (
            <div className="job-wrap">
              <JobPanel job={job} open={job.status !== "done"} />
            </div>
          )}
          {ended && ended.id === job?.id && (
            <p
              className={
                ended.status === "done" ? "feedback ok" : "inline-error"
              }
              role={ended.status === "done" ? "status" : "alert"}
            >
              {ended.status === "done" && <IconCheck size={15} />}
              {ended.status === "done"
                ? E.measured
                : ended.status === "stopped"
                  ? E.measureStopped
                  : E.measureFailed}
            </p>
          )}
        </Card>
      )}
    </Section>
  );
}

function nameOf(u: TestSet["uses"][number]): string {
  if (u.runs.length > 0) return u.runs.join(", ");
  return [u.build, u.eval_run].filter(Boolean).join(" · ");
}

export function TestSetPanel({
  testset,
  error,
  onRetry,
}: {
  testset: TestSet | null;
  error: ApiError | null;
  onRetry: () => void;
}) {
  return (
    <Section id="testset" title={E.testsetTitle} help={E.testsetHelp}>
      <ErrorBox error={error} onRetry={onRetry} />
      {!testset ? (
        !error && <Loading />
      ) : (
        <Card className="testset">
          {testset.lock ? (
            <p className="testset-lock">
              <strong>
                {testset.lock.created
                  ? E.locked(
                      date(testset.lock.created),
                      int(testset.lock.sentences ?? 0),
                      int(testset.lock.clips ?? 0),
                    )
                  : E.lockedUndated(
                      int(testset.lock.sentences ?? 0),
                      int(testset.lock.clips ?? 0),
                    )}
              </strong>
              {testset.lock.build && (
                <span className="help block">
                  {E.lockedFrom(testset.lock.build)}
                </span>
              )}
            </p>
          ) : (
            <p className="testset-lock">{E.notLocked}</p>
          )}
          <h3 className="card-title testset-count">
            {testset.count === 0
              ? E.unused
              : testset.count === 1
                ? E.usedOnce
                : E.used(int(testset.count))}
          </h3>
          {testset.uses.length > 0 && (
            <ul className="testset-uses" aria-label={E.usesLabel}>
              {testset.uses.map((u, i) => (
                <li key={`${u.at}-${i}`}>
                  <span className="testset-when">{dateTime(u.at)}</span>
                  <span className="testset-runs">{nameOf(u)}</span>
                  {u.source && (
                    <span className="tag tag--quiet">
                      {u.source === "studio" ? E.fromStudio : E.fromCli}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}
    </Section>
  );
}
