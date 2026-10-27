/* The recording state, polled as API.md says (every 700 ms with ?since=<version>, a long poll),
   and the actions on it. Rows that did not change keep their object, so the memoised rows of a
   120-sentence list do not re-render on every poll. */
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, api, paths } from "../../api/client";
import { sleep } from "../../api/hooks";
import type { RecordingState, Row } from "../../api/types";

export const POLL_MS = 700;

const json = new WeakMap<Row, string>();
function key(r: Row): string {
  let k = json.get(r);
  if (k === undefined) {
    k = JSON.stringify(r);
    json.set(r, k);
  }
  return k;
}

/** The new rows, reusing every old row object that is unchanged (and the old array if all are). */
export function reconcileRows(
  prev: readonly Row[] | undefined,
  next: Row[],
): Row[] {
  if (!prev) return next;
  const old = new Map(prev.map((r) => [r.id, r]));
  let same = prev.length === next.length;
  const out = next.map((r, i) => {
    const o = old.get(r.id);
    if (o && key(o) === key(r)) {
      if (prev[i] !== o) same = false;
      return o;
    }
    same = false;
    return r;
  });
  return same ? (prev as Row[]) : out;
}

function isState(v: unknown): v is RecordingState {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as RecordingState).version === "number" &&
    Array.isArray((v as RecordingState).rows)
  );
}

export interface Recording {
  state: RecordingState | null;
  error: ApiError | null;
  /** POST an action; applies the state it answers. Resolves to the error, if any. */
  act: (path: string, body?: unknown) => Promise<ApiError | null>;
  busy: string | null;
  retry: () => void;
}

export function useRecording(): Recording {
  const [state, setState] = useState<RecordingState | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const version = useRef<number | null>(null);

  const apply = useCallback((s: RecordingState) => {
    version.current = s.version;
    setState((prev) => {
      if (prev && prev.version === s.version) return prev;
      return { ...s, rows: reconcileRows(prev?.rows, s.rows) };
    });
  }, []);

  useEffect(() => {
    const ctrl = new AbortController();
    (async () => {
      let failures = 0;
      while (!ctrl.signal.aborted) {
        try {
          const s = await api.get<RecordingState>(
            paths.recordingState(version.current),
            ctrl.signal,
          );
          if (ctrl.signal.aborted) return;
          if (isState(s)) apply(s);
          setError(null);
          failures = 0;
          await sleep(POLL_MS, ctrl.signal);
        } catch (e) {
          if (ctrl.signal.aborted) return;
          failures++;
          setError(
            e instanceof ApiError ? e : new ApiError(0, "network", String(e)),
          );
          // After a failure, ask for the whole state again (the server may have restarted).
          version.current = null;
          await sleep(Math.min(5000, 1000 * failures), ctrl.signal);
        }
      }
    })();
    return () => ctrl.abort();
  }, [apply, tick]);

  const act = useCallback(
    async (path: string, body: unknown = {}) => {
      setBusy(path);
      try {
        const answer = await api.post<unknown>(path, body);
        if (isState(answer)) apply(answer);
        return null;
      } catch (e) {
        return e instanceof ApiError
          ? e
          : new ApiError(0, "network", String(e));
      } finally {
        setBusy(null);
      }
    },
    [apply],
  );

  const retry = useCallback(() => setTick((t) => t + 1), []);
  return { state, error, act, busy, retry };
}
