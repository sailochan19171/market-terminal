"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export class ApiError extends Error {
  constructor(public status: number, message: string, public body?: unknown) {
    super(message);
  }
}

const RETRY_DELAYS_MS = [700, 2000, 5000];
const retriable = (e: unknown) =>
  !(e instanceof ApiError) || e.status >= 500 || e.status === 429 || e.status === 408;

function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(t); reject(new DOMException("Aborted", "AbortError")); }, { once: true });
  });
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { ...init, headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) } });
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    throw new Error("Could not reach the data server. Check that the API is running.");
  }
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    let body: unknown;
    try {
      body = await res.json();
      const b = body as { message?: string; error?: string };
      if (b?.message) message = b.message;
      else if (b?.error) message = b.error;
    } catch {
      /* not JSON */
    }
    throw new ApiError(res.status, message, body);
  }
  return res.json() as Promise<T>;
}

/** GET with retries for network errors and 5xx/429; 4xx fail immediately. */
export async function apiWithRetry<T>(path: string, signal?: AbortSignal): Promise<T> {
  let last: unknown;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      return await api<T>(path, { signal });
    } catch (e) {
      if ((e as Error).name === "AbortError" || !retriable(e) || attempt === RETRY_DELAYS_MS.length) throw e;
      last = e;
      await sleep(RETRY_DELAYS_MS[attempt], signal);
    }
  }
  throw last;
}

export function post<T>(path: string, body: unknown): Promise<T> {
  return api<T>(path, { method: "POST", body: JSON.stringify(body) });
}

export interface Loadable<T> {
  /** Latest successful response. Kept when a refresh fails or while the next path loads. */
  data: T | null;
  /** Error from the most recent attempt (after retries), if it failed. */
  error: string | null;
  errorStatus: number | null;
  errorBody: unknown;
  /** True while a request is in flight. */
  loading: boolean;
  /** `data` belongs to an earlier path (a new one is loading or failed). */
  stale: boolean;
  /** When `data` was last fetched successfully. */
  updatedAt: Date | null;
  reload: () => void;
}

/**
 * Fetch on mount and whenever `path` changes; pass null to skip.
 *
 * In-flight requests are cancelled when the path changes. Transient failures
 * are retried with backoff. A failure never wipes data that already loaded:
 * callers get the previous data with `stale`/`error` set, and can show a
 * non-blocking notice instead of an empty page.
 */
export function useApi<T>(path: string | null): Loadable<T> {
  const [state, setState] = useState<{ data: T | null; dataPath: string | null; updatedAt: Date | null }>({
    data: null, dataPath: null, updatedAt: null,
  });
  const [error, setError] = useState<{ message: string; status: number | null; body: unknown } | null>(null);
  const [loading, setLoading] = useState<boolean>(Boolean(path));
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!path) {
      setLoading(false);
      return;
    }
    const ctrl = new AbortController();
    setLoading(true);
    setError(null);
    apiWithRetry<T>(path, ctrl.signal)
      .then((d) => {
        if (!ctrl.signal.aborted) setState({ data: d, dataPath: path, updatedAt: new Date() });
      })
      .catch((e: Error) => {
        if (ctrl.signal.aborted || e.name === "AbortError") return;
        setError({ message: e.message, status: e instanceof ApiError ? e.status : null, body: e instanceof ApiError ? e.body : undefined });
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setLoading(false);
      });
    return () => ctrl.abort();
  }, [path, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return {
    data: state.data,
    error: error?.message ?? null,
    errorStatus: error?.status ?? null,
    errorBody: error?.body,
    loading,
    stale: state.dataPath !== null && state.dataPath !== path,
    updatedAt: state.updatedAt,
    reload,
  };
}

/** Debounce a changing value (search boxes). */
export function useDebounced<T>(value: T, ms = 250): T {
  const [v, setV] = useState(value);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}
