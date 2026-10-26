/* Loading, polling and jobs. The screens poll as API.md says: the recording state every 700 ms
   with ?since=<version> (a long poll), a running job every second. */
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, api, paths } from "./client";
import type { Job } from "./types";

export interface Resource<T> {
  data: T | null;
  error: ApiError | null;
  loading: boolean;
  reload: () => void;
  set: (value: T) => void;
}

function asApiError(e: unknown): ApiError {
  return e instanceof ApiError
    ? e
    : new ApiError(0, "unknown-error", String(e));
}

/** GET a path once (and again on reload or when the path changes). */
export function useResource<T>(path: string | null): Resource<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(path !== null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (path === null) return;
    const ctrl = new AbortController();
    setLoading(true);
    api
      .get<T>(path, ctrl.signal)
      .then((v) => {
        setData(v);
        setError(null);
      })
      .catch((e) => {
        if ((e as { name?: string })?.name === "AbortError") return;
        setError(asApiError(e));
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setLoading(false);
      });
    return () => ctrl.abort();
  }, [path, tick]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, loading, reload, set: setData };
}

export const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      resolve();
    });
  });

/** GET a path every `everyMs` while `enabled`; keeps the last good value through errors. */
export function usePoll<T>(
  path: string | null,
  everyMs: number,
  enabled = true,
): Resource<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(path !== null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (path === null) return;
    const ctrl = new AbortController();
    (async () => {
      let first = true;
      while (!ctrl.signal.aborted) {
        try {
          const v = await api.get<T>(path, ctrl.signal);
          if (ctrl.signal.aborted) return;
          setData(v);
          setError(null);
        } catch (e) {
          if (ctrl.signal.aborted) return;
          setError(asApiError(e));
        }
        if (first) {
          setLoading(false);
          first = false;
        }
        if (!enabled) return;
        await sleep(everyMs, ctrl.signal);
      }
    })();
    return () => ctrl.abort();
  }, [path, everyMs, enabled, tick]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, loading, reload, set: setData };
}

/** Follow a job: poll GET /api/jobs/<id> every second while it runs; onEnd once it stops. */
export function useJob(
  initial: Job | null,
  onEnd?: (job: Job) => void,
): {
  job: Job | null;
  follow: (job: Job | null) => void;
  error: ApiError | null;
} {
  const [job, setJob] = useState<Job | null>(initial);
  const [error, setError] = useState<ApiError | null>(null);
  const endRef = useRef(onEnd);
  endRef.current = onEnd;
  const id = job?.id ?? null;
  const running = job?.status === "running";
  useEffect(() => {
    if (!id || !running) return;
    const ctrl = new AbortController();
    (async () => {
      while (!ctrl.signal.aborted) {
        await sleep(1000, ctrl.signal);
        if (ctrl.signal.aborted) return;
        try {
          const j = await api.get<Job>(paths.job(id), ctrl.signal);
          if (ctrl.signal.aborted) return;
          setJob(j);
          setError(null);
          if (j.status !== "running") {
            endRef.current?.(j);
            return;
          }
        } catch (e) {
          if (ctrl.signal.aborted) return;
          setError(asApiError(e));
        }
      }
    })();
    return () => ctrl.abort();
  }, [id, running]);
  const follow = useCallback((j: Job | null) => setJob(j), []);
  return { job, follow, error };
}
