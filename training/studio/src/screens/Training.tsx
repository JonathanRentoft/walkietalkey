/* Træning: choose a config, see every setting with its Danish label, start, and watch the train
   and validation loss draw live; stop with a confirm. Earlier runs below. */
import { useEffect, useMemo, useState } from "react";
import { ApiError, api } from "../api/client";
import { usePoll, useResource } from "../api/hooks";
import type {
  ConfigSetting,
  Job,
  TrainingConfig,
  TrainingProgress,
  TrainingState,
} from "../api/types";
import { LineChart, Legend } from "../components/charts";
import { IconAwake, IconStop } from "../components/icons";
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
import {
  lossDomain,
  niceTicks,
  smooth,
  stepDecimals,
  stepDomain,
} from "../lib/chart";
import { dateTime, decimal, int, pct, plain, points } from "../lib/format";
import { errorText, S } from "../strings";

const T = S.training;

const PHASES = ["build", "cache", "train", "validate", "done"] as const;

/** A setting's value as the owner reads it. */
export function settingValue(v: unknown): string {
  // A setting left empty in the config means the workbench's default (data.recordings, ...).
  if (v === null || v === undefined) return T.byDefault;
  if (v === "") return S.common.none;
  if (typeof v === "boolean") return v ? S.common.yes : S.common.no;
  if (typeof v === "number") return plain(v);
  if (Array.isArray(v)) return v.map(settingValue).join(", ");
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

/** The settings by section, each with its Danish heading (the server's, else the page's own). */
export function grouped(
  settings: ConfigSetting[],
): { key: string; title: string; items: ConfigSetting[] }[] {
  const m = new Map<
    string,
    { key: string; title: string; items: ConfigSetting[] }
  >();
  for (const s of settings) {
    const key = s.section ?? "general";
    const title =
      s.section_label || T.sections[key] || (s.section ?? T.sections.general);
    const group = m.get(key) ?? { key, title, items: [] };
    group.items.push(s);
    m.set(key, group);
  }
  return [...m.values()];
}

export function TrainingScreen() {
  const configs = useResource<TrainingConfig[]>("/api/training/configs");
  const [fast, setFast] = useState(true);
  const state = usePoll<TrainingState>(
    "/api/training/state",
    fast ? 1000 : 5000,
  );
  const running = state.data?.job?.status === "running";
  useEffect(() => setFast(running), [running]);

  const [chosen, setChosen] = useState<string | null>(null);
  const list = configs.data ?? [];
  const name = chosen ?? state.data?.progress?.config ?? list[0]?.name ?? null;
  const config = list.find((c) => c.name === name) ?? null;

  const [startError, setStartError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  async function start() {
    if (!name) return;
    setBusy(true);
    setStartError(null);
    try {
      await api.post<Job>("/api/training/start", { config: name });
      setFast(true);
      state.reload();
    } catch (e) {
      setStartError(e as ApiError);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader title={T.title} intro={T.intro} />
      <ErrorBox error={configs.error} onRetry={configs.reload} />
      <ErrorBox
        error={state.data ? null : state.error}
        onRetry={state.reload}
      />

      {state.data ? (
        <Live state={state.data} onStopped={state.reload} />
      ) : (
        !state.error && <Loading />
      )}

      <Section
        id="config"
        title={T.settings}
        aside={
          list.length > 0 && (
            <div className="row-inline">
              <label className="field field--inline">
                <span>{T.config}</span>
                <select
                  value={name ?? ""}
                  onChange={(e) => setChosen(e.target.value)}
                >
                  {list.map((c) => (
                    <option key={c.name} value={c.name}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </label>
              <Button
                variant="primary"
                onClick={start}
                disabled={!name || running || busy || !!config?.error}
                busy={busy}
              >
                {busy ? T.starting : T.start}
              </Button>
            </div>
          )
        }
      >
        {startError && (
          <p className="inline-error" role="alert">
            {errorText(startError.code, "training")}
          </p>
        )}
        {running && <p className="help">{T.busy}</p>}
        {!config ? (
          !configs.error && <Loading />
        ) : (
          <Card>
            <p className="help mono-ish">{T.file(config.file)}</p>
            {config.error && (
              <div className="notice notice--warn" role="alert">
                <p>
                  {T.configError}
                  <span className="help block" lang="en">
                    {config.error}
                  </span>
                </p>
              </div>
            )}
            <div className="settings">
              {grouped(config.settings).map(
                ({ key: section, title, items }) => (
                  <div key={section} className="settings-group">
                    <h3>{title}</h3>
                    <dl>
                      {items.map((s) => (
                        <div key={s.key} className="setting">
                          <dt>
                            {s.label}
                            <code className="setting-key">{s.key}</code>
                          </dt>
                          <dd>{settingValue(s.value)}</dd>
                        </div>
                      ))}
                    </dl>
                  </div>
                ),
              )}
            </div>
          </Card>
        )}
      </Section>

      {state.data && (
        <Runs
          runs={state.data.runs}
          live={
            state.data.job?.status === "running"
              ? (state.data.progress?.run ?? null)
              : null
          }
        />
      )}
    </>
  );
}

function Phases({ phase }: { phase: string }) {
  const at = PHASES.indexOf(phase as (typeof PHASES)[number]);
  const ended = phase === "failed" || phase === "stopped";
  return (
    <ol className="phases" aria-label={T.phases}>
      {PHASES.map((p, i) => {
        const state = ended
          ? "off"
          : i < at
            ? "past"
            : i === at
              ? "now"
              : "next";
        return (
          <li
            key={p}
            className={`phase phase--${state}`}
            aria-current={state === "now" ? "step" : undefined}
          >
            <span className="phase-dot" aria-hidden="true" />
            {T.phase[p]}
          </li>
        );
      })}
      {ended && (
        <li className="phase phase--ended" aria-current="step">
          <span className="phase-dot" aria-hidden="true" />
          {T.phase[phase]}
        </li>
      )}
    </ol>
  );
}

function Live({
  state,
  onStopped,
}: {
  state: TrainingState;
  onStopped: () => void;
}) {
  const p = state.progress;
  const job = state.job;
  const running = job?.status === "running";
  const [confirming, setConfirming] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  useEffect(() => {
    if (!running) setConfirming(false);
  }, [running]);

  async function stop() {
    setStopping(true);
    setError(null);
    try {
      await api.post("/api/training/stop", {});
      onStopped();
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setStopping(false);
      setConfirming(false);
    }
  }

  if (!p && !job) return <Notice>{T.noRun}</Notice>;
  return (
    <Section
      id="live"
      title={running ? T.running : p ? (T.phase[p.phase] ?? p.phase) : T.title}
    >
      <Card className="live">
        {p && (
          <>
            <div className="live-head">
              <div>
                <Phases phase={p.phase} />
                <p className="live-numbers">
                  {p.epoch !== null && p.epochs !== null && (
                    <span>{T.epoch(int(p.epoch), int(p.epochs))}</span>
                  )}
                  {p.step !== null && p.total_steps !== null && (
                    <span>{T.step(int(p.step), int(p.total_steps))}</span>
                  )}
                  {p.run && <span className="mono-ish">{T.run(p.run)}</span>}
                </p>
              </div>
              {running && (
                <div className="live-stop">
                  {confirming ? (
                    <div className="confirm" role="group" aria-label={T.stop}>
                      <p>{T.stopConfirm}</p>
                      <div className="row-inline">
                        <Button
                          variant="danger"
                          onClick={stop}
                          disabled={stopping}
                          busy={stopping}
                        >
                          {stopping ? T.stopping : T.stopYes}
                        </Button>
                        <Button onClick={() => setConfirming(false)} autoFocus>
                          {T.stopNo}
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <Button onClick={() => setConfirming(true)}>
                      <IconStop size={15} />
                      {T.stop}
                    </Button>
                  )}
                </div>
              )}
            </div>
            {p.step !== null && p.total_steps ? (
              <div
                className="progress"
                role="progressbar"
                aria-label={T.step(int(p.step), int(p.total_steps))}
                aria-valuemin={0}
                aria-valuemax={p.total_steps}
                aria-valuenow={p.step}
              >
                <span
                  style={{
                    width: `${Math.min(1, p.step / p.total_steps) * 100}%`,
                  }}
                />
              </div>
            ) : null}
            {p.awake && running && (
              <p className="awake">
                <IconAwake size={16} />
                {T.awake}
              </p>
            )}
            {p.phase === "done" && (
              <Notice kind="ok">
                {T.done}
                {p.best_epoch != null && p.best_validation_wer != null
                  ? ` ${T.best(int(p.best_epoch), pct(p.best_validation_wer, 1))}`
                  : ""}
              </Notice>
            )}
            {p.phase === "failed" && (
              <Notice kind="warn">
                <p>
                  {T.failed}
                  {p.message && (
                    <span className="help block" lang="en">
                      {p.message}
                    </span>
                  )}
                </p>
              </Notice>
            )}
            {p.phase === "stopped" && <Notice>{T.stopped}</Notice>}
            <Charts progress={p} />
          </>
        )}
        {error && (
          <p className="inline-error" role="alert">
            {errorText(error.code, "training")}
          </p>
        )}
        {job && <JobPanel job={job} open={false} />}
      </Card>
    </Section>
  );
}

function Charts({ progress: p }: { progress: TrainingProgress }) {
  const smoothed = useMemo(() => smooth(p.train_loss, 0.6), [p.train_loss]);
  const xDomain = stepDomain(p.total_steps, [
    p.train_loss,
    p.validation_loss,
    p.validation_wer,
  ]);
  const loss = lossDomain([p.train_loss, p.validation_loss]);
  const lossDigits = stepDecimals(loss.step);
  const werExt = p.validation_wer.map(([, v]) => v);
  const wer = werExt.length
    ? niceTicks(
        Math.max(0, Math.min(...werExt) - 0.01),
        Math.max(...werExt) + 0.01,
        4,
      )
    : niceTicks(0, 0.25, 4);
  const werDigits = Math.max(0, stepDecimals(wer.step * 100));
  const fmtStep = (v: number) => int(v);
  return (
    <div className="charts">
      <div className="chart-block">
        <h3 className="chart-title">{T.lossTitle}</h3>
        <p className="help">{T.lossHelp}</p>
        <Legend
          items={[
            { label: T.trainLoss, series: 1, mark: "line" },
            { label: T.trainLossRaw, series: 1, mark: "line", faint: true },
            { label: T.validationLoss, series: 2, mark: "dot" },
          ]}
        />
        <LineChart
          label={T.lossTitle}
          xDomain={xDomain}
          y={loss}
          yFormat={(v) => decimal(v, Math.max(1, lossDigits))}
          xFormat={fmtStep}
          xLabel={T.stepAxis}
          series={[
            {
              id: "train",
              label: T.trainLoss,
              series: 1,
              points: smoothed,
              raw: p.train_loss,
            },
            {
              id: "validation",
              label: T.validationLoss,
              series: 2,
              points: p.validation_loss,
              dots: true,
            },
          ]}
          empty={T.noPoints}
        />
      </div>
      <div className="chart-block">
        <h3 className="chart-title">{T.werTitle}</h3>
        <p className="help">{T.werHelp}</p>
        <LineChart
          label={T.werTitle}
          height={180}
          xDomain={xDomain}
          y={wer}
          yFormat={(v) => pct(v, werDigits)}
          xFormat={fmtStep}
          xLabel={T.stepAxis}
          series={[
            {
              id: "wer",
              label: T.werTitle,
              series: 2,
              points: p.validation_wer,
              dots: true,
            },
          ]}
          empty={T.noPoints}
        />
      </div>
    </div>
  );
}

/** `live`: the run the training that is going now writes, shown as running, not unfinished. */
function Runs({
  runs,
  live,
}: {
  runs: TrainingState["runs"];
  live: string | null;
}) {
  return (
    <Section id="runs" title={T.runsTitle}>
      {runs.length === 0 ? (
        <p className="empty">{T.runsEmpty}</p>
      ) : (
        <Card className="table-card">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">{T.colRun}</th>
                <th scope="col">{T.colDate}</th>
                <th scope="col" className="num">
                  {T.colBestEpoch}
                </th>
                <th scope="col" className="num">
                  {T.colBaseline}
                </th>
                <th scope="col" className="num">
                  {T.colBest}
                </th>
                <th scope="col" className="num">
                  {T.colChange}
                </th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.name}>
                  <th scope="row" className="mono-ish">
                    {r.name}
                    {r.name === live ? (
                      <span className="tag tag--quiet run-tag">
                        {S.common.job.running}
                      </span>
                    ) : (
                      r.finished === false && (
                        <span className="tag tag--quiet run-tag">
                          {T.unfinished}
                        </span>
                      )
                    )}
                    {r.finished !== false && r.adapter === false && (
                      <span className="tag tag--quiet run-tag">
                        {T.noAdapter}
                      </span>
                    )}
                  </th>
                  <td>{dateTime(r.date)}</td>
                  <td className="num">{r.best_epoch ?? S.common.none}</td>
                  <td className="num">{pct(r.baseline_validation_wer, 1)}</td>
                  <td className="num">
                    <strong>{pct(r.best_validation_wer, 1)}</strong>
                  </td>
                  <td className="num">
                    {r.best_validation_wer !== null &&
                    r.baseline_validation_wer !== null
                      ? points(
                          r.best_validation_wer - r.baseline_validation_wer,
                          1,
                        )
                      : S.common.none}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </Section>
  );
}
