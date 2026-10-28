/* Data: the sentences, the recorded minutes per condition, the train/validation/test split per
   condition (following the chosen config's fractions) and the leakage check, drawn. */
import { useState } from "react";
import { paths } from "../api/client";
import { useResource } from "../api/hooks";
import type { DataView, LeakageCheck } from "../api/types";
import { Bars, Legend, StackedBars } from "../components/charts";
import { IconCheck, IconQuestion, IconWarn } from "../components/icons";
import {
  Card,
  Empty,
  ErrorBox,
  Loading,
  PageHeader,
  Section,
  Segmented,
  StatTile,
} from "../components/ui";
import { int, minutes, pct } from "../lib/format";
import { S } from "../strings";

const D = S.data;

type Unit = "takes" | "minutes";

export function DataScreen() {
  const [config, setConfig] = useState<string | null>(null);
  const [unit, setUnit] = useState<Unit>("takes");
  const res = useResource<DataView>(paths.data(config));
  const d = res.data;

  return (
    <>
      <PageHeader title={D.title} intro={D.intro}>
        {d && (
          <label className="field field--inline">
            <span>{D.config}</span>
            <select
              value={d.config}
              onChange={(e) => setConfig(e.target.value)}
            >
              {d.configs.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>
        )}
      </PageHeader>
      <ErrorBox error={res.error} onRetry={res.reload} area="data" />
      {!d ? (
        !res.error && <Loading />
      ) : (
        <div className={res.loading ? "is-loading" : ""}>
          <div className="stats">
            <StatTile label={D.sentences} value={int(d.sentences.total)} />
            <StatTile label={D.plain} value={int(d.sentences.plain)} />
            <StatTile label={D.terms} value={int(d.sentences.terms)} />
            <StatTile label={D.recorded} value={int(d.sentences.recorded)} />
          </div>

          {d.conditions.every((c) => c.takes === 0) ? (
            <Section id="minutes" title={D.minutesTitle}>
              <Empty
                what={D.empty.what}
                when={D.empty.when}
                to={{ href: "/optag", label: D.empty.go }}
              />
            </Section>
          ) : (
            <>
              <Section id="minutes" title={D.minutesTitle}>
                <Card>
                  <Bars
                    label={D.minutesTitle}
                    max={Math.max(1, ...d.conditions.map((c) => c.minutes))}
                    rows={d.conditions.map((c) => ({
                      key: c.id,
                      label: c.label,
                      value: c.minutes,
                      text: minutes(c.minutes),
                      sub: `${int(c.takes)} ${D.takes.toLowerCase()}`,
                    }))}
                  />
                </Card>
              </Section>

              <Section
                id="split"
                title={D.splitTitle}
                help={D.splitHelp(
                  pct(d.fractions.validation, 0),
                  pct(d.fractions.test, 0),
                  d.config,
                )}
                aside={
                  <Segmented<Unit>
                    label={D.unit}
                    value={unit}
                    onChange={setUnit}
                    options={[
                      { value: "takes", label: D.takes },
                      { value: "minutes", label: D.minutes },
                    ]}
                  />
                }
              >
                <Card>
                  <Legend
                    items={[
                      { label: D.train, series: 1 },
                      { label: D.validation, series: 2 },
                      { label: D.test, series: 3 },
                    ]}
                  />
                  <StackedBars
                    label={D.splitTitle}
                    max={Math.max(
                      1e-9,
                      ...d.conditions.map((c) =>
                        unit === "takes" ? c.takes : c.minutes,
                      ),
                    )}
                    rows={d.conditions.map((c) => {
                      const f = (n: number) =>
                        unit === "takes" ? int(n) : minutes(n);
                      const v = (p: { takes: number; minutes: number }) =>
                        unit === "takes" ? p.takes : p.minutes;
                      return {
                        key: c.id,
                        label: c.label,
                        total: f(unit === "takes" ? c.takes : c.minutes),
                        parts: [
                          {
                            label: D.train,
                            value: v(c.split.train),
                            text: f(v(c.split.train)),
                            series: 1,
                          },
                          {
                            label: D.validation,
                            value: v(c.split.validation),
                            text: f(v(c.split.validation)),
                            series: 2,
                          },
                          {
                            label: D.test,
                            value: v(c.split.test),
                            text: f(v(c.split.test)),
                            series: 3,
                          },
                        ],
                      };
                    })}
                  />
                  <details className="table-view">
                    <summary>{S.common.showTable}</summary>
                    <table className="table">
                      <thead>
                        <tr>
                          <th scope="col">{D.condition}</th>
                          <th scope="col" className="num">
                            {D.train}
                          </th>
                          <th scope="col" className="num">
                            {D.validation}
                          </th>
                          <th scope="col" className="num">
                            {D.test}
                          </th>
                          <th scope="col" className="num">
                            {D.total}
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {d.conditions.map((c) => (
                          <tr key={c.id}>
                            <th scope="row">{c.label}</th>
                            {(["train", "validation", "test"] as const).map(
                              (k) => (
                                <td key={k} className="num">
                                  {int(c.split[k].takes)} /{" "}
                                  {minutes(c.split[k].minutes)}
                                </td>
                              ),
                            )}
                            <td className="num">
                              {int(c.takes)} / {minutes(c.minutes)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </details>
                  {d.rehearsal && (
                    <p className="help">
                      {D.rehearsal(
                        pct(d.rehearsal.share, 0),
                        pct(d.rehearsal.validation_share, 0),
                      )}
                    </p>
                  )}
                  {d.skipped.length > 0 && (
                    <details className="notes">
                      <summary>{D.skipped(int(d.skipped.length))}</summary>
                      <p className="help">{D.skippedHelp}</p>
                      <ul className="mono-list">
                        {d.skipped.map((s) => (
                          <li key={s.id}>
                            <code>{s.id}</code>{" "}
                            <span lang="en">{s.reason}</span>
                          </li>
                        ))}
                      </ul>
                    </details>
                  )}
                </Card>
              </Section>
            </>
          )}

          <Section id="leakage" title={D.leakageTitle} help={D.leakageHelp}>
            <Leakage view={d} />
          </Section>
        </div>
      )}
    </>
  );
}

function CheckMark({ check }: { check: LeakageCheck }) {
  const state =
    check.ok === true ? "ok" : check.ok === false ? "bad" : "unknown";
  const text =
    state === "ok"
      ? D.leakageOk
      : state === "bad"
        ? D.leakageOverlap(int(check.overlap ?? 0))
        : D.leakageUnknown;
  return (
    <span className={`leak-mark leak-mark--${state}`}>
      {state === "ok" ? (
        <IconCheck size={14} />
      ) : state === "bad" ? (
        <IconWarn size={14} />
      ) : (
        <IconQuestion size={14} />
      )}
      {text}
    </span>
  );
}

/** The splits as boxes, the held-out sets as boxes, and each check on the line between them. */
function Leakage({ view }: { view: DataView }) {
  const L = view.leakage;
  if (!L.ran) return <Empty what={D.leakageNotRun} when={D.empty.leakage} />;
  const splits = L.checks.find((c) => c.id === "splits");
  const held = L.checks.filter((c) => c.id !== "splits");
  const allOk = L.checks.every((c) => c.ok === true);
  const anyBad = L.checks.some((c) => c.ok === false);
  return (
    <Card className="leak">
      <div className="leak-diagram">
        <div className="leak-col">
          <p className="leak-col-title">{D.yourSplits}</p>
          <div className="leak-splits">
            <div className="leak-box leak-box--train">{D.boxes.train}</div>
            <div className="leak-join" aria-hidden="true" />
            <div className="leak-box">{D.boxes.validation}</div>
            <div className="leak-join" aria-hidden="true" />
            <div className="leak-box">{D.boxes.test}</div>
          </div>
          {splits && (
            <div
              className={`leak-line leak-line--${splits.ok === true ? "ok" : splits.ok === false ? "bad" : "unknown"}`}
            >
              <CheckMark check={splits} />
              <span className="leak-label">{splits.label}</span>
            </div>
          )}
        </div>
        <div className="leak-col leak-col--held">
          <p className="leak-col-title">{D.heldOut}</p>
          {held.map((c) => (
            <div
              key={c.id}
              className={`leak-link leak-link--${c.ok === true ? "ok" : c.ok === false ? "bad" : "unknown"}`}
            >
              <span className="leak-from">{D.boxes.train}</span>
              <span className="leak-wire" aria-hidden="true" />
              <CheckMark check={c} />
              <span className="leak-wire" aria-hidden="true" />
              <span className="leak-box leak-box--held">
                {D.boxes[c.id] ?? c.id}
              </span>
              <span className="leak-label">
                {c.label}
                {c.detail && (
                  <span className="help block" lang="en">
                    {c.detail}
                  </span>
                )}
              </span>
            </div>
          ))}
        </div>
      </div>
      <p
        className={`leak-summary ${anyBad ? "bad" : allOk ? "ok" : ""}`}
        role="status"
      >
        {anyBad
          ? D.leakageProblem
          : allOk
            ? D.leakageAllOk
            : D.leakageSomeUnknown}
        {anyBad && L.message && (
          <span className="help block" lang="en">
            {L.message}
          </span>
        )}
      </p>
    </Card>
  );
}
