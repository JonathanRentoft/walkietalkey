/* Requests to the studio server (training/studio/API.md). Every POST carries the header
   X-WT-Studio: 1 and a JSON body; errors arrive as {"error": code, "message": English} and become
   an ApiError, which the screens name in Danish (strings.ts, errors). */
import type { ApiErrorBody } from "./types";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

function isErrorBody(v: unknown): v is ApiErrorBody {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as { error?: unknown }).error === "string"
  );
}

async function request<T>(
  path: string,
  init: RequestInit & { signal?: AbortSignal },
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { credentials: "same-origin", ...init });
  } catch (e) {
    if ((e as { name?: string })?.name === "AbortError") throw e;
    throw new ApiError(0, "network", String(e));
  }
  let body: unknown = null;
  const text = await res.text();
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      if (res.ok)
        throw new ApiError(res.status, "bad-response", text.slice(0, 200));
    }
  }
  if (!res.ok) {
    if (isErrorBody(body))
      throw new ApiError(res.status, body.error, body.message ?? body.error);
    throw new ApiError(
      res.status,
      res.status === 403
        ? "forbidden"
        : res.status === 404
          ? "not-found"
          : "http",
      `HTTP ${res.status}`,
    );
  }
  return body as T;
}

export function get<T>(path: string, signal?: AbortSignal): Promise<T> {
  return request<T>(path, {
    method: "GET",
    headers: { Accept: "application/json" },
    signal,
  });
}

export function post<T>(path: string, body: unknown = {}): Promise<T> {
  return request<T>(path, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-WT-Studio": "1",
    },
    body: JSON.stringify(body),
  });
}

export const api = { get, post };

/** The journal page and report URLs the page builds; names are encoded once, here. */
export const paths = {
  recordingState: (since: number | null) =>
    since === null
      ? "/api/recording/state"
      : `/api/recording/state?since=${encodeURIComponent(String(since))}`,
  job: (id: string) => `/api/jobs/${encodeURIComponent(id)}`,
  jobStop: (id: string) => `/api/jobs/${encodeURIComponent(id)}/stop`,
  data: (config: string | null) =>
    config ? `/api/data?config=${encodeURIComponent(config)}` : "/api/data",
  journalPage: (name: string) => `/api/journal/${encodeURIComponent(name)}`,
};
