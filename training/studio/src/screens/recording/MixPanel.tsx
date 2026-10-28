/* Run 12: the mix on the recording screen. The owner sets the four shares, sees at once how many
   sentences each condition gets and how long they take at his pace, and what dealing again would
   move; "Del ud igen" deals exactly as `wt-train plan --mix` does. */
import { useEffect, useRef, useState } from "react";
import { ApiError, api } from "../../api/client";
import { useResource } from "../../api/hooks";
import type { MixPreview, MixShares, MixView } from "../../api/types";
import { IconCheck } from "../../components/icons";
import {
  Button,
  Card,
  ErrorBox,
  Loading,
  Notice,
  Section,
} from "../../components/ui";
import { duration, int, percent, seconds } from "../../lib/format";
import { errorText, S } from "../../strings";

const M = S.mix;
const PREVIEW_AFTER_MS = 250;

type Draft = Record<string, string>;

const draftOf = (mix: MixShares): Draft =>
  Object.fromEntries(Object.entries(mix).map(([k, v]) => [k, String(v)]));

/** The draft as whole percents, or null while one is not a whole number from 0 to 100. */
export function sharesOf(draft: Draft): MixShares | null {
  const out: MixShares = {};
  for (const [k, v] of Object.entries(draft)) {
    if (!/^\d{1,3}$/.test(v.trim())) return null;
    const n = Number(v);
    if (n > 100) return null;
    out[k] = n;
  }
  return out;
}

export const total = (mix: MixShares): number =>
  Object.values(mix).reduce((s, v) => s + v, 0);

const same = (a: MixShares, b: MixShares): boolean =>
  Object.keys({ ...a, ...b }).every((k) => (a[k] ?? 0) === (b[k] ?? 0));

export function MixPanel({
  reloadKey,
  onDealt,
}: {
  /** Changes when a recording is picked or stopped (the panel reads the mix again). */
  reloadKey: string | null;
  onDealt: () => void;
}) {
  const res = useResource<MixView>("/api/mix");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [preview, setPreview] = useState<MixPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [dealing, setDealing] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [dealt, setDealt] = useState<string | null>(null);
  const view = res.data;
  const reload = res.reload;

  // A pick started or stopped since the panel loaded: read the mix (and whether one is picked) again.
  const lastKey = useRef<string | null>(null);
  useEffect(() => {
    if (reloadKey === null) return;
    const before = lastKey.current;
    lastKey.current = reloadKey;
    if (before !== null && before !== reloadKey) reload();
  }, [reloadKey, reload]);

  // A fresh view resets the draft only when the owner has not started editing.
  useEffect(() => {
    if (view && draft === null) setDraft(draftOf(view.mix));
  }, [view, draft]);

  const shares = draft ? sharesOf(draft) : null;
  const valid = !!shares && total(shares) === 100;
  const changed = !!view && !!shares && !same(shares, view.mix);
  const key = valid && changed ? JSON.stringify(shares) : null;

  useEffect(() => {
    if (key === null) {
      setPreview(null);
      return;
    }
    let live = true;
    const t = setTimeout(async () => {
      setPreviewing(true);
      try {
        const p = await api.post<MixPreview>("/api/mix/preview", {
          mix: JSON.parse(key),
        });
        if (live) {
          setPreview(p);
          setError(null);
        }
      } catch (e) {
        if (live) setError(e as ApiError);
      } finally {
        if (live) setPreviewing(false);
      }
    }, PREVIEW_AFTER_MS);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [key]);

  async function deal() {
    if (!shares || !valid) return;
    setDealing(true);
    setError(null);
    setDealt(null);
    try {
      const after = await api.post<MixPreview>("/api/mix/deal", {
        mix: shares,
      });
      res.set(after);
      setDraft(draftOf(after.mix));
      setPreview(null);
      setDealt(M.dealt(int(after.moved.total)));
      onDealt();
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setDealing(false);
    }
  }

  const shown = preview ?? view;
  const labels = new Map(view?.conditions.map((c) => [c.id, c.label]) ?? []);
  const sum = shares ? total(shares) : null;

  return (
    <Section id="mix-edit" title={M.title} help={M.help}>
      <ErrorBox error={view ? null : res.error} onRetry={res.reload} />
      {!view || !draft || !shown ? (
        !res.error && <Loading />
      ) : (
        <Card className={`mix-edit ${previewing ? "is-loading" : ""}`}>
          {view.recording && (
            <Notice kind="info" role="status">
              <p>{M.recording}</p>
            </Notice>
          )}
          <div className="table-scroll">
            <table className="table table--mix">
              <thead>
                <tr>
                  <th scope="col">{M.colCondition}</th>
                  <th scope="col" className="num">
                    {M.colShare}
                  </th>
                  <th scope="col" className="num">
                    {M.colSentences}
                  </th>
                  <th scope="col" className="num">
                    {M.colLeft}
                  </th>
                  <th scope="col" className="num">
                    {M.colPace}
                  </th>
                  <th scope="col" className="num">
                    {M.colTime}
                  </th>
                </tr>
              </thead>
              <tbody>
                {shown.conditions.map((c) => (
                  <tr key={c.id}>
                    <th scope="row">{c.label}</th>
                    <td className="num">
                      <span className="share-input">
                        <input
                          type="number"
                          inputMode="numeric"
                          min={0}
                          max={100}
                          step={1}
                          value={draft[c.id] ?? "0"}
                          aria-label={M.shareLabel(c.label)}
                          onChange={(e) => {
                            setDealt(null);
                            setDraft({ ...draft, [c.id]: e.target.value });
                          }}
                        />
                        <span aria-hidden="true">%</span>
                      </span>
                    </td>
                    <td className="num">{int(c.planned)}</td>
                    <td className="num">{int(c.left)}</td>
                    <td className="num">
                      {M.pace(seconds(c.pace.seconds))}
                      <span className="run-meta">
                        {c.pace.source === "takes" ? M.paceOwn : M.pacePilot}
                      </span>
                    </td>
                    <td className="num">
                      <strong>{M.time(duration(c.minutes))}</strong>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mix-foot">
            <p
              className={sum === 100 ? "mix-total" : "mix-total bad"}
              role={sum === 100 ? undefined : "alert"}
            >
              {sum === 100
                ? M.total(percent(100))
                : sum === null
                  ? M.notWhole
                  : M.totalWrong(percent(sum))}
            </p>
            <p className="mix-total">{M.timeTotal(duration(shown.minutes))}</p>
          </div>
          <p className="help">{M.paceHelp}</p>
          {preview && (
            <div className="mix-moved" role="status">
              {preview.moved.total === 0 ? (
                <p>{M.movedNone}</p>
              ) : (
                <>
                  <p>
                    {preview.moved.total === 1
                      ? M.movedOne
                      : M.moved(int(preview.moved.total))}
                  </p>
                  <ul>
                    {preview.moved.pairs.map((p) => (
                      <li key={`${p.from}-${p.to}`}>
                        {M.movedPair(
                          int(p.n),
                          labels.get(p.from) ?? p.from,
                          labels.get(p.to) ?? p.to,
                        )}
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          )}
          {valid && !changed && !dealt && <p className="help">{M.unchanged}</p>}
          <div className="row-inline mix-actions">
            <Button
              variant="primary"
              onClick={deal}
              disabled={
                !valid || !changed || view.recording || dealing || previewing
              }
              busy={dealing}
            >
              {dealing ? M.dealing : M.deal}
            </Button>
            {changed && (
              <Button
                variant="quiet"
                onClick={() => {
                  setDraft(draftOf(view.mix));
                  setError(null);
                }}
              >
                {M.reset}
              </Button>
            )}
          </div>
          {error && (
            <p className="inline-error" role="alert">
              {errorText(error.code, "mix")}
            </p>
          )}
          {dealt && (
            <p className="feedback ok" role="status">
              <IconCheck size={15} />
              {dealt}
            </p>
          )}
        </Card>
      )}
    </Section>
  );
}
