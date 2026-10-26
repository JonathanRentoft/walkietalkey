/* Below the session: progress per condition against the mix, and the pilot (its setups, the
   comparison job, the per-setup comparison as small multiples, and the full report). */
import type { ApiError } from "../../api/client";
import { api } from "../../api/client";
import { useJob } from "../../api/hooks";
import type {
  Job,
  Pilot,
  PilotComparisonSetup,
  Progress,
} from "../../api/types";
import { Bars, Legend, type BarRow } from "../../components/charts";
import {
  Button,
  Card,
  ErrorBox,
  JobPanel,
  Loading,
  Section,
} from "../../components/ui";
import {
  db,
  dbfs,
  dateTime,
  int,
  minutes,
  pct,
  percent,
} from "../../lib/format";
import { Link, reportHref } from "../../router";
import { errorText, S } from "../../strings";
import { useEffect, useState } from "react";

const R = S.recording;

export function ProgressPanel({
  progress,
  error,
  onRetry,
}: {
  progress: Progress | null;
  error: ApiError | null;
  onRetry: () => void;
}) {
  return (
    <Section id="progress" title={R.progressTitle} help={R.progressHelp}>
      <ErrorBox error={error} onRetry={onRetry} />
      {!progress ? (
        !error && <Loading />
      ) : (
        <Card>
          <MixBar progress={progress} />
          <Bars
            label={R.progressTitle}
            track
            wide
            max={1}
            rows={progress.conditions.map<BarRow>((c) => ({
              key: c.id,
              label: c.label,
              value: c.planned > 0 ? c.done / c.planned : 0,
              text:
                c.planned > 0
                  ? R.progressDone(int(c.done), int(c.planned))
                  : R.noShareShort,
              sub: [
                minutes(c.minutes),
                c.exam_total > 0
                  ? R.examProgress(int(c.exam_done), int(c.exam_total))
                  : null,
              ]
                .filter(Boolean)
                .join(" · "),
            }))}
          />
          <p className="total">
            {R.progressTotal(
              minutes(progress.minutes),
              int(progress.sentences),
            )}
          </p>
        </Card>
      )}
    </Section>
  );
}

/** The chosen mix as one bar: each condition's share, labelled. */
function MixBar({ progress }: { progress: Progress }) {
  const parts = progress.conditions.filter((c) => c.share > 0);
  const total = parts.reduce((s, c) => s + c.share, 0) || 1;
  const series = (i: number) => ((i % 3) + 1) as 1 | 2 | 3;
  return (
    <div className="mix">
      <p className="mix-title">{R.mixTitle}</p>
      <div
        className="stack stack--mix"
        role="img"
        aria-label={parts
          .map((c) => `${c.label} ${percent(c.share)}`)
          .join(", ")}
      >
        {parts.map((c, i) => (
          <span
            key={c.id}
            className={`stack-part s${series(i)}`}
            style={{ width: `${(c.share / total) * 100}%` }}
          />
        ))}
      </div>
      <Legend
        items={parts.map((c, i) => ({
          label: `${c.label}: ${percent(c.share)}`,
          series: series(i),
        }))}
      />
    </div>
  );
}

/* ---------------------------------------------------------------- pilot */

type Metric = "wer" | "snr" | "level" | "clipped";

function metricRows(
  setups: PilotComparisonSetup[],
  labels: Map<string, string>,
  m: Metric,
): { rows: BarRow[]; min: number; max: number } {
  const label = (s: PilotComparisonSetup) =>
    s.label ?? labels.get(s.name) ?? s.name;
  if (m === "wer") {
    const max = Math.max(0.05, ...setups.map((s) => s.wer ?? 0));
    return {
      min: 0,
      max,
      rows: setups.map((s) => ({
        key: s.name,
        label: label(s),
        value: s.wer ?? 0,
        text: pct(s.wer, 1),
      })),
    };
  }
  if (m === "snr") {
    const max = Math.max(10, ...setups.map((s) => s.snr_db ?? 0));
    return {
      min: 0,
      max,
      rows: setups.map((s) => ({
        key: s.name,
        label: label(s),
        value: s.snr_db ?? 0,
        text: db(s.snr_db),
      })),
    };
  }
  if (m === "level")
    return {
      min: -70,
      max: 0,
      rows: setups.map((s) => ({
        key: s.name,
        label: label(s),
        value: s.level_dbfs ?? -70,
        text: dbfs(s.level_dbfs),
      })),
    };
  const max = Math.max(1, ...setups.map((s) => s.clipped ?? 0));
  return {
    min: 0,
    max,
    rows: setups.map((s) => ({
      key: s.name,
      label: label(s),
      value: s.clipped ?? 0,
      text: int(s.clipped ?? 0),
    })),
  };
}

export function PilotPanel({
  pilot,
  error,
  onRetry,
  onChanged,
}: {
  pilot: Pilot | null;
  error: ApiError | null;
  onRetry: () => void;
  onChanged: () => void;
}) {
  const { job, follow } = useJob(null, () => onChanged());
  const [startError, setStartError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (pilot?.job && pilot.job.id !== job?.id) follow(pilot.job);
  }, [pilot?.job, job?.id, follow]);

  async function compare() {
    setBusy(true);
    setStartError(null);
    try {
      follow(await api.post<Job>("/api/pilot/compare", {}));
    } catch (e) {
      setStartError(e as ApiError);
    } finally {
      setBusy(false);
    }
  }

  const running = job?.status === "running";
  const labels = new Map((pilot?.setups ?? []).map((s) => [s.name, s.label]));
  const cmp = pilot?.comparison ?? null;
  const M = R.pilotMetrics;
  const metrics: {
    m: Metric;
    title: string;
    help: string;
    series: 1 | 2 | 3;
  }[] = [
    { m: "wer", title: M.wer, help: M.werHelp, series: 1 },
    { m: "snr", title: M.snr, help: M.snrHelp, series: 1 },
    { m: "level", title: M.level, help: M.levelHelp, series: 1 },
    { m: "clipped", title: M.clipped, help: M.clippedHelp, series: 1 },
  ];

  return (
    <Section
      id="pilot"
      title={R.pilotTitle}
      help={pilot ? R.pilotHelp(int(pilot.sentences)) : undefined}
      aside={
        <Button
          onClick={compare}
          disabled={!pilot || running || busy}
          busy={running || busy}
        >
          {running ? R.pilotComparing : R.pilotCompare}
        </Button>
      }
    >
      <ErrorBox error={error} onRetry={onRetry} />
      {startError && (
        <p className="inline-error" role="alert">
          {errorText(startError.code, "pilot")}
        </p>
      )}
      {!pilot ? (
        !error && <Loading />
      ) : (
        <>
          <Card>
            <h3 className="card-title">{R.pilotSetups}</h3>
            <Bars
              label={R.pilotSetups}
              track
              wide
              max={1}
              rows={pilot.setups.map((s) => ({
                key: s.name,
                label: s.label,
                value: s.total > 0 ? s.done / s.total : 0,
                text: R.setupDone(int(s.done), int(s.total)),
                sub: [
                  s.device === "phone" ? R.phone : R.mac,
                  s.suggested ? R.suggested : null,
                ]
                  .filter(Boolean)
                  .join(" · "),
              }))}
            />
          </Card>
          {job && (
            <div className="job-wrap">
              <JobPanel job={job} />
              {job.status === "failed" && (
                <p className="inline-error">{R.pilotFailed}</p>
              )}
            </div>
          )}
          {cmp ? (
            <Card className="pilot-cmp">
              <div className="pilot-cmp-head">
                <div>
                  <h3 className="card-title">
                    {R.pilotFrom(dateTime(cmp.generated_at))}
                  </h3>
                  {cmp.model && (
                    <p className="help mono-ish">{R.pilotModel(cmp.model)}</p>
                  )}
                </div>
                {cmp.report && (
                  <Link
                    className="btn btn--secondary btn--sm"
                    href={reportHref(cmp.report, "/optag")}
                  >
                    {R.pilotReport}
                  </Link>
                )}
              </div>
              <div className="multiples">
                {metrics.map(({ m, title, help, series }) => {
                  const { rows, min, max } = metricRows(cmp.setups, labels, m);
                  return (
                    <div key={m} className="multiple">
                      <p className="multiple-title">{title}</p>
                      <p className="help">{help}</p>
                      <Bars
                        label={title}
                        rows={rows}
                        min={min}
                        max={max}
                        series={series}
                      />
                    </div>
                  );
                })}
              </div>
              {cmp.setups.some((s) => s.notes.length > 0) && (
                <details className="notes">
                  <summary>{R.pilotNotes}</summary>
                  <ul lang="en">
                    {cmp.setups.flatMap((s) =>
                      s.notes.map((n, i) => (
                        <li key={`${s.name}-${i}`}>
                          <strong>
                            {s.label ?? labels.get(s.name) ?? s.name}:
                          </strong>{" "}
                          {n}
                        </li>
                      )),
                    )}
                  </ul>
                </details>
              )}
            </Card>
          ) : (
            <p className="empty">{R.pilotNone}</p>
          )}
        </>
      )}
    </Section>
  );
}
