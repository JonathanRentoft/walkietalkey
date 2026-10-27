/* Evaluering: the MLflow runs with their key numbers, a run's report inside Værkstedet, and two
   runs compared (the --vs page). Reports open on the report screen (Report.tsx). */
import { useState } from "react";
import { ApiError, api, paths } from "../api/client";
import { sleep, usePoll, useResource } from "../api/hooks";
import type { EvalRun, Job, Overview, ReportAnswer } from "../api/types";
import {
  Button,
  Card,
  ErrorBox,
  JobPanel,
  Loading,
  PageHeader,
  Section,
} from "../components/ui";
import { dateTime, int, interval, pct } from "../lib/format";
import { navigate, reportHref } from "../router";
import { errorText, S } from "../strings";

const E = S.evaluation;

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
  // A clean scale shared by every row: 0 to the next 5 % above the widest interval.
  const max =
    Math.ceil(
      (Math.max(0.05, ...list.map((r) => r.wer_ci?.[1] ?? r.wer ?? 0)) * 100) /
        5,
    ) * 0.05;
  const label = (r: EvalRun) => `${r.name} (${pct(r.wer, 1)})`;

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
        <p className="empty">{E.empty}</p>
      ) : (
        <>
          <Card className="table-card">
            <table className="table table--eval">
              <thead>
                <tr>
                  <th scope="col">{E.colRun}</th>
                  <th scope="col">{E.colDataset}</th>
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
                {list.map((r) => (
                  <tr key={r.id}>
                    <th scope="row">
                      <span className="run-name">{r.name}</span>
                      <span className="run-meta">
                        {dateTime(r.date)}
                        {r.model && <> · {r.model}</>}
                        {r.change && (
                          <>
                            {" "}
                            · <code>{r.change}</code>
                          </>
                        )}
                      </span>
                    </th>
                    <td>{r.dataset ?? S.common.none}</td>
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
                        aria-label={E.openLabel(r.name)}
                      >
                        {opening === r.id ? E.opening : E.open}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>

          <Section id="compare" title={E.compareTitle} help={E.compareHelp}>
            <Card className="compare">
              <label className="field">
                <span>{E.a}</span>
                <select value={a} onChange={(e) => setA(e.target.value)}>
                  <option value="">{E.choose}</option>
                  {list.map((r) => (
                    <option key={r.id} value={r.id}>
                      {label(r)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>{E.b}</span>
                <select value={b} onChange={(e) => setB(e.target.value)}>
                  <option value="">{E.choose}</option>
                  {list.map((r) => (
                    <option key={r.id} value={r.id}>
                      {label(r)}
                    </option>
                  ))}
                </select>
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
            </Card>
          </Section>
        </>
      )}
    </>
  );
}
