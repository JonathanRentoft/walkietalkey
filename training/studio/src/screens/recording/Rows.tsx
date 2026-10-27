/* Every sentence of the session as a row: its status, the text, and for a received take the level
   meter, the check's chips, what Edda heard, a play button and "Tag om" (and "Godkend alligevel"
   for a take the check sent back). Rows are memoised; the current one is highlighted and
   scrolled into view inside the list when it changes. */
import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { ApiError } from "../../api/client";
import type { Limits, RecordingState, Row } from "../../api/types";
import { IconRedo, IconCheck } from "../../components/icons";
import {
  DiffLegend,
  LevelMeter,
  PlayButton,
  ProblemChips,
  StatusBadge,
  WordDiff,
} from "../../components/take";
import { Button, Section, Segmented } from "../../components/ui";
import { useReducedMotion } from "@walkietalkey/ui";
import { int, seconds } from "../../lib/format";
import { errorText, S } from "../../strings";
import type { Act } from "./Session";

const R = S.recording;

type Filter = "all" | "redo" | "waiting" | "approved";

export interface RowActions {
  redo: (id: string) => void;
  approve: (id: string) => void;
  go: (id: string) => void;
}

function reviewNote(row: Row): string | null {
  const r = row.take?.review;
  if (!r) return null;
  if (r.status === "approved" && r.by === "owner") return R.approvedByOwner;
  if (r.status === "redo" && r.by === "owner") return R.redoByOwner;
  if (r.status === "redo") return R.redoByCheck;
  return null;
}

export const RowItem = memo(function RowItem({
  row,
  n,
  current,
  limits,
  actions,
  locked,
}: {
  row: Row;
  n: number;
  current: boolean;
  limits: Limits | null;
  actions: RowActions;
  /** A take is recording: nothing else can become current. */
  locked: boolean;
}) {
  const take = row.take;
  const sentBackByCheck = row.status === "redo" && take?.review?.by !== "owner";
  const note = reviewNote(row);
  const canGo =
    !current && !locked && (row.status === "waiting" || row.status === "redo");
  return (
    <li
      className={`row row--${row.status} ${current ? "row--current" : ""}`}
      data-row={row.id}
      aria-current={current ? "step" : undefined}
    >
      <span className="row-n" aria-hidden="true">
        {n}
      </span>
      <div className="row-main">
        <div className="row-top">
          <StatusBadge status={row.status} />
          {current && <span className="tag tag--current">{R.current}</span>}
          {row.skipped && <span className="tag tag--quiet">{R.skipped}</span>}
          <span className="row-id">{row.id}</span>
        </div>
        <p className="row-text" lang="da">
          {row.text}
        </p>
        {take && (
          <div className="row-take">
            <div className="row-take-line">
              <LevelMeter take={take} limits={limits} />
              <span className="row-take-meta">
                {R.take(int(take.n ?? 1), seconds(take.seconds))}
              </span>
              <ProblemChips problems={take.problems} />
            </div>
            {take.diff ? (
              <WordDiff take={take} />
            ) : take.edda_error ? (
              <p className="heard heard--none">{R.eddaError}</p>
            ) : take.transcribing ? (
              <p className="heard heard--none">
                <span className="loading-dot" aria-hidden="true" />
                {R.listening}
              </p>
            ) : (
              <p className="heard heard--none">{R.waitingForEdda}</p>
            )}
            {note && <p className="row-note">{note}</p>}
          </div>
        )}
      </div>
      <div className="row-actions">
        {take && <PlayButton take={take} rowId={row.id} />}
        {take && row.status !== "recording" && (
          <Button
            variant="quiet"
            size="sm"
            onClick={() => actions.redo(row.id)}
            disabled={locked}
          >
            <IconRedo size={14} />
            {R.redo}
          </Button>
        )}
        {take && sentBackByCheck && (
          <Button
            variant="quiet"
            size="sm"
            onClick={() => actions.approve(row.id)}
          >
            <IconCheck size={14} />
            {R.approveAnyway}
          </Button>
        )}
        {canGo && !take && (
          <Button
            variant="quiet"
            size="sm"
            className="row-go"
            aria-label={R.goLabel(row.id)}
            onClick={() => actions.go(row.id)}
          >
            {R.go}
          </Button>
        )}
      </div>
    </li>
  );
});

export function RowList({ state, act }: { state: RecordingState; act: Act }) {
  const [filter, setFilter] = useState<Filter>("all");
  const [error, setError] = useState<ApiError | null>(null);
  const reduced = useReducedMotion();
  const listRef = useRef<HTMLOListElement>(null);

  // Stable across polls, so the memoised rows only re-render when their own row changes.
  const actRef = useRef(act);
  actRef.current = act;
  const actions = useMemo<RowActions>(() => {
    const run = (path: string, id: string) =>
      actRef.current(path, { id }).then((e) => setError(e));
    return {
      redo: (id) => void run("/api/recording/redo", id),
      approve: (id) => void run("/api/recording/approve", id),
      go: (id) => void run("/api/recording/go", id),
    };
  }, []);
  // Compared by value, so a new poll with the same limits keeps the rows memoised.
  const limitsKey = JSON.stringify(state.limits);
  const limits = useMemo(
    () => JSON.parse(limitsKey) as Limits | null,
    [limitsKey],
  );

  const counts = state.counts;
  const shown = useMemo(() => {
    const index = new Map(state.rows.map((r, i) => [r.id, i + 1]));
    const rows =
      filter === "all"
        ? state.rows
        : state.rows.filter((r) =>
            filter === "waiting"
              ? r.status === "waiting" ||
                r.status === "recording" ||
                r.status === "received"
              : r.status === filter,
          );
    return rows.map((r) => ({ row: r, n: index.get(r.id) ?? 0 }));
  }, [state.rows, filter]);

  // Scroll the current row into view within the list (not the page) when it changes.
  useEffect(() => {
    const list = listRef.current;
    if (!list || !state.current) return;
    const el = list.querySelector<HTMLElement>(
      `[data-row="${state.current.replace(/["\\]/g, "\\$&")}"]`,
    );
    if (!el) return;
    const top = el.offsetTop - list.clientHeight / 3;
    list.scrollTo({
      top: Math.max(0, top),
      behavior: reduced ? "auto" : "smooth",
    });
  }, [state.current, filter, reduced]);

  const locked = !!state.recording;
  return (
    <Section
      id="rows"
      title={R.listTitle}
      className="rows-section"
      aside={
        <Segmented<Filter>
          label={R.filter}
          value={filter}
          onChange={setFilter}
          options={[
            { value: "all", label: R.filterAll(int(counts.total)) },
            { value: "redo", label: R.filterRedo(int(counts.redo)) },
            {
              value: "waiting",
              label: R.filterWaiting(
                int(counts.waiting + counts.recording + counts.received),
              ),
            },
            {
              value: "approved",
              label: R.filterApproved(int(counts.approved)),
            },
          ]}
        />
      }
    >
      <DiffLegend />
      {error && (
        <p className="inline-error" role="alert">
          {errorText(error.code, "recording")}
        </p>
      )}
      <ol className="rows" ref={listRef} tabIndex={-1} aria-label={R.listTitle}>
        {shown.length === 0 && (
          <li className="rows-empty">
            {counts.total === 0 ? R.empty.all : R.empty[filter]}
          </li>
        )}
        {shown.map(({ row, n }) => (
          <RowItem
            key={row.id}
            row={row}
            n={n}
            current={row.id === state.current}
            limits={limits}
            actions={actions}
            locked={locked}
          />
        ))}
      </ol>
    </Section>
  );
}
