/* Pick a session: a real condition (with its progress against the mix, or its exam) or a pilot
   setup; then Start (POST /api/recording/start). */
import { useEffect, useState } from "react";
import type { ApiError } from "../../api/client";
import type { Progress, RecordingOptions, StartBody } from "../../api/types";
import { Button, Card } from "../../components/ui";
import { int, minutes, percent } from "../../lib/format";
import { errorText, S } from "../../strings";

const R = S.recording;

function Mini({ value, max }: { value: number; max: number }) {
  const t = max > 0 ? Math.min(1, value / max) : 0;
  return (
    <span className="mini-bar" aria-hidden="true">
      <span style={{ width: `${t * 100}%` }} />
    </span>
  );
}

export function Picker({
  options,
  progress,
  current,
  onStart,
  onClose,
}: {
  options: RecordingOptions;
  progress: Progress | null;
  current: { kind: string; id: string; exam?: boolean } | null;
  onStart: (body: StartBody) => Promise<ApiError | null>;
  onClose?: () => void;
}) {
  const startable = options.conditions.find((c) => c.share > 0);
  const [pick, setPick] = useState<string>(() =>
    current
      ? `${current.kind}:${current.id}`
      : startable
        ? `condition:${startable.id}`
        : "",
  );
  const [exam, setExam] = useState(current?.exam ?? false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [kind, id] = pick.split(/:(.*)/s);
  useEffect(() => setError(null), [pick, exam]);

  async function start() {
    if (!pick) return;
    setBusy(true);
    const body: StartBody =
      kind === "pilot"
        ? { kind: "pilot", id }
        : { kind: "condition", id, exam };
    const e = await onStart(body);
    setBusy(false);
    setError(e);
  }

  const examFor = (cid: string) =>
    progress?.conditions.find((c) => c.id === cid);

  return (
    <Card className="picker">
      <div className="picker-head">
        <h2>{onClose ? R.pickAgain : R.pickTitle}</h2>
        {onClose && (
          <Button variant="quiet" size="sm" onClick={onClose}>
            {S.common.close}
          </Button>
        )}
      </div>
      {onClose && <p className="help">{R.pickReplaces}</p>}

      <fieldset className="pick-group">
        <legend>{R.conditions}</legend>
        <p className="help">{R.conditionsHelp}</p>
        {options.conditions.map((c) => {
          const value = `condition:${c.id}`;
          const off = c.share <= 0;
          const ex = examFor(c.id);
          return (
            <label
              key={c.id}
              className={`pick ${pick === value ? "on" : ""} ${off ? "off" : ""}`}
            >
              <input
                type="radio"
                name="pick"
                value={value}
                checked={pick === value}
                disabled={off}
                onChange={() => setPick(value)}
              />
              <span className="pick-body">
                <span className="pick-title">{c.label}</span>
                {off ? (
                  <span className="pick-meta">{R.noShare}</span>
                ) : (
                  <span className="pick-meta">
                    <Mini value={c.done} max={c.planned} />
                    <span>{R.conditionDone(int(c.done), int(c.planned))}</span>
                    <span>{R.conditionShare(percent(c.share))}</span>
                    <span>{minutes(c.minutes)}</span>
                    {c.redo > 0 && <span>{R.conditionRedo(int(c.redo))}</span>}
                    {ex && ex.exam_total > 0 && (
                      <span>
                        {R.examProgress(int(ex.exam_done), int(ex.exam_total))}
                      </span>
                    )}
                  </span>
                )}
              </span>
            </label>
          );
        })}
        <label className={`check ${kind !== "condition" ? "dim" : ""}`}>
          <input
            type="checkbox"
            checked={exam && kind === "condition"}
            disabled={kind !== "condition"}
            onChange={(e) => setExam(e.target.checked)}
          />
          <span>
            {R.examToggle(int(options.exam.paragraphs))}
            <span className="help block">{R.examHelp}</span>
          </span>
        </label>
      </fieldset>

      <fieldset className="pick-group">
        <legend>{R.pilot}</legend>
        <p className="help">{R.pilotHelp(int(options.pilot.sentences))}</p>
        <div className="pick-grid">
          {options.pilot.setups.map((s) => {
            const value = `pilot:${s.name}`;
            return (
              <label
                key={s.name}
                className={`pick pick--small ${pick === value ? "on" : ""}`}
              >
                <input
                  type="radio"
                  name="pick"
                  value={value}
                  checked={pick === value}
                  onChange={() => setPick(value)}
                />
                <span className="pick-body">
                  <span className="pick-title">
                    {s.label}
                    {s.suggested && <span className="tag">{R.suggested}</span>}
                  </span>
                  <span className="pick-meta">
                    <Mini value={s.done} max={s.total} />
                    <span>{R.setupDone(int(s.done), int(s.total))}</span>
                    <span>{s.device === "phone" ? R.phone : R.mac}</span>
                  </span>
                </span>
              </label>
            );
          })}
        </div>
      </fieldset>

      <div className="picker-foot">
        <Button
          variant="primary"
          size="lg"
          onClick={start}
          disabled={!pick || busy}
          busy={busy}
        >
          {busy ? R.starting : R.start}
        </Button>
        {error && (
          <p className="inline-error" role="alert">
            {errorText(error.code, "recording")}
          </p>
        )}
      </div>
    </Card>
  );
}
