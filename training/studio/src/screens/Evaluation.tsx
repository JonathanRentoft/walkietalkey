/* Evaluering: the MLflow runs with their key numbers, a run's report inside Værkstedet, and two
   runs compared (the --vs page). Reports open on the report screen (Report.tsx). Run 11: each run
   under its readable name (the slug small, for the command line), grouped by the normaliser that
   counted it, since run 8's fix on 26 October changed every number without changing the model. */
import { useState } from "react";
import { ApiError, api, paths } from "../api/client";
import { sleep, usePoll, useResource } from "../api/hooks";
import type { EvalRun, Job, Overview, ReportAnswer } from "../api/types";
import {
  Button,
  Card,
  Empty,
  ErrorBox,
  JobPanel,
  Loading,
  Notice,
  PageHeader,
  Section,
} from "../components/ui";
import { dateTime, int, interval, pct } from "../lib/format";
import { navigate, reportHref } from "../router";
import { errorText, S } from "../strings";

const E = S.evaluation;
/** A first evaluation that needs nothing but the workbench: base Edda on FLEURS (a command, not copy). */
const EVAL_EXAMPLE = "wt-train eval --backend hf";

export interface Group {
  /** The normaliser's version; null for one without a number. */
  version: number | null;
  runs: EvalRun[];
}

/** The runs by normaliser, the newest normaliser first (one without a number last), each group
    newest run first as the server lists them. */
export function byNormaliser(runs: EvalRun[]): Group[] {
  const groups = new Map<number | null, EvalRun[]>();
  for (const r of runs) {
    const v = typeof r.normaliser === "number" ? r.normaliser : null;
    groups.set(v, [...(groups.get(v) ?? []), r]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (a === null ? 1 : b === null ? -1 : b - a))
    .map(([version, list]) => ({ version, runs: list }));
}

function groupTitle(version: number | null): string {
  return version === null ? E.groupUnknown : E.group(int(version));
}

/** WER with its 95 % interval as a dot and whisker on a scale shared by every row. */
function IntervalMark({ run, max }: { run: EvalRun; max: number }) {
  if (run.wer === null) return null;
  const x = (v: number) => `${Math.min(100, Math.max(0, (v / max) * 100))}%`;
  return (
    <span className="ci" aria-hidden="true">
      <span className="ci-track" />
      {run.wer_ci && (
        <span
          className="ci-whisker"
          style={{
            left: x(run.wer_ci[0]),
            width: `calc(${x(run.wer_ci[1])} - ${x(run.wer_ci[0])})`,
          }}
        />
      )}
      <span className="ci-dot" style={{ left: x(run.wer) }} />
    </span>
  );
}

/** POST a report request and wait for its `report` job (API.md) before the page is opened. */
export async function writeReport(
  path: string,
  body: unknown,
): Promise<string> {
  const answer = await api.post<ReportAnswer>(path, body);
  if (answer.job) {
    let job = await api.get<Job>(paths.job(answer.job));
    while (job.status === "running") {
      await sleep(1000);
      job = await api.get<Job>(paths.job(answer.job));
    }
    if (job.status !== "done")
      throw new ApiError(
        500,
        "report-failed",
        `report job ${job.id} ${job.status}`,
      );
  }
  return answer.url;
}

/** While a report is written, the log of the running report job (from the overview). */
function ReportJob() {
  const o = usePoll<Overview>("/api/overview", 1000);
  const jobs = (o.data?.jobs ?? []).filter((j) => j.kind === "report");
  const job = jobs[jobs.length - 1];
  return job ? (
    <div className="job-wrap">
      <JobPanel job={job} />
    </div>
  ) : null;
}

export function EvaluationScreen() {
  const runs = useResource<EvalRun[]>("/api/eval/runs");
  const [opening, setOpening] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [a, setA] = useState("");
  const [b, setB] = useState("");

  async function open(run: EvalRun) {
    setError(null);
    if (run.report) {
      navigate(reportHref(run.report, "/evaluering"));
      return;
    }
    setOpening(run.id);
    try {
      const url = await writeReport("/api/eval/report", { run: run.id });
      navigate(reportHref(url, "/evaluering"));
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setOpening(null);
    }
  }

  async function compare() {
    if (!a || !b || a === b) return;
    setError(null);
    setOpening("compare");
    try {
      const url = await writeReport("/api/eval/compare", { a, b });
      navigate(reportHref(url, "/evaluering"));
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setOpening(null);
    }
  }

  const list = runs.data ?? [];
  const groups = byNormaliser(list);
  // A clean scale shared by every row: 0 to the next 5 % above the widest interval.
  const max =
    Math.ceil(
      (Math.max(0.05, ...list.map((r) => r.wer_ci?.[1] ?? r.wer ?? 0)) * 100) /
        5,
    ) * 0.05;
  const label = (r: EvalRun) => `${r.title ?? r.name} (${pct(r.wer, 1)})`;
  const runA = list.find((r) => r.id === a);
  const runB = list.find((r) => r.id === b);
  const mixed =
    !!runA && !!runB && a !== b && runA.normaliser !== runB.normaliser;

  const picker = (value: string, set: (v: string) => void) => (
    <select value={value} onChange={(e) => set(e.target.value)}>
      <option value="">{E.choose}</option>
      {groups.map((g) => (
        <optgroup key={String(g.version)} label={groupTitle(g.version)}>
          {g.runs.map((r) => (
            <option key={r.id} value={r.id}>
              {label(r)}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );

  return (
    <>
      <PageHeader title={E.title} intro={E.intro} />
      <ErrorBox error={runs.error} onRetry={runs.reload} />
      {error && (
        <p className="inline-error" role="alert">
          {errorText(error.code, "evaluation")}
        </p>
      )}
      {opening !== null && <ReportJob />}
      {!runs.data ? (
        !runs.error && <Loading />
      ) : list.length === 0 ? (
        <Empty what={E.emptyWhat} when={E.emptyWhen} code={EVAL_EXAMPLE} />
      ) : (
        <>
          {groups.length > 1 && (
            <Notice>
              <p>
                <strong className="block">{E.fixTitle}</strong>
                {E.fixNote}
              </p>
            </Notice>
          )}
          {groups.map((g) => (
            <Section
              key={String(g.version)}
              id={`normaliser-${g.version ?? "unknown"}`}
              title={groupTitle(g.version)}
              help={
                g.version === null
                  ? E.unknownHelp
                  : (E.since[String(g.version)] ?? undefined)
              }
              className="eval-group"
            >
              <Card className="table-card">
                <table className="table table--eval">
                  <thead>
                    <tr>
                      <th scope="col">{E.colRun}</th>
                      <th scope="col" className="num">
                        {E.colClips}
                      </th>
                      <th scope="col" className="num">
                        {E.colWer}
                      </th>
                      <th scope="col" className="ci-col">
                        {E.colInterval}
                        <span className="run-meta">{E.scale(pct(max, 0))}</span>
                      </th>
                      <th scope="col" className="num">
                        {E.colCer}
                      </th>
                      <th scope="col">
                        <span className="sr">{E.open}</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {g.runs.map((r) => (
                      <tr key={r.id}>
                        <th scope="row">
                          <span className="run-name">{r.title ?? r.name}</span>
                          <span className="run-meta">
                            {dateTime(r.date)}
                            {r.title && (
                              <>
                                {" · "}
                                <code
                                  className="run-slug"
                                  title={E.slug(r.name)}
                                >
                                  {r.name}
                                </code>
                              </>
                            )}
                          </span>
                        </th>
                        <td className="num">
                          {r.clips !== null ? int(r.clips) : S.common.none}
                        </td>
                        <td className="num">
                          <strong>{pct(r.wer)}</strong>
                          <span className="run-meta">{interval(r.wer_ci)}</span>
                        </td>
                        <td className="ci-col">
                          <IntervalMark run={r} max={max} />
                        </td>
                        <td className="num">{pct(r.cer)}</td>
                        <td className="actions">
                          <Button
                            size="sm"
                            onClick={() => open(r)}
                            disabled={opening !== null}
                            busy={opening === r.id}
                            aria-label={E.openLabel(r.title ?? r.name)}
                          >
                            {opening === r.id ? E.opening : E.open}
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Card>
            </Section>
          ))}

          <Section id="compare" title={E.compareTitle} help={E.compareHelp}>
            <Card className="compare">
              <label className="field">
                <span>{E.a}</span>
                {picker(a, setA)}
              </label>
              <label className="field">
                <span>{E.b}</span>
                {picker(b, setB)}
              </label>
              <Button
                variant="primary"
                onClick={compare}
                disabled={!a || !b || a === b || opening !== null}
                busy={opening === "compare"}
              >
                {opening === "compare" ? E.comparing : E.compare}
              </Button>
              {a && b && a === b && <p className="inline-error">{E.sameRun}</p>}
              {mixed && (
                <p className="compare-note" role="status">
                  {E.mixed}
                </p>
              )}
            </Card>
          </Section>
        </>
      )}
    </>
  );
}
