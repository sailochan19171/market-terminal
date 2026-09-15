// Helpers shared by the API route handlers.
import { getDb, type Db, type Row } from "../db";
import { logger } from "../log";
import { ensureSchema as ensureMetrics } from "../core/metrics";
import { ensureSchema as ensureAnalysis, ensureStatementSchema } from "../core/analysis";
import { ensure as ensureSearch } from "../core/searchIndex";
import { ensureSchema as ensureSync } from "../nse/companySync";
import { ensureSchema as ensureHoldingDetail } from "../nse/shareholdingSchema";

const log = logger("api");

/** A client error with a message the UI can show. */
export class ApiError extends Error {
  constructor(public status: number, message: string, public body: Row = {}) {
    super(message);
  }
}
export const badRequest = (message: string) => new ApiError(400, message, { error: "bad_request" });

let schemaReady = false;

/** The shared connection with every module's tables in place (checked once per process). */
export function db(): Db {
  const d = getDb();
  if (!schemaReady) {
    ensureMetrics(d);
    ensureAnalysis(d);
    ensureStatementSchema(d);
    ensureSync(d);
    ensureHoldingDetail(d);
    ensureSearch(d);
    schemaReady = true;
  }
  return d;
}

const memos = new Map<string, { at: number; value: unknown }>();

/** A value recomputed at most once per `ttlMs` in this process (for slow aggregates that change rarely). */
export function memo<T>(key: string, ttlMs: number, fn: () => T): T {
  const hit = memos.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value as T;
  const value = fn();
  memos.set(key, { at: Date.now(), value });
  return value;
}

export function json(data: unknown, init: ResponseInit & { cache?: string } = {}) {
  const headers = new Headers(init.headers);
  headers.set("Cache-Control", init.cache ?? "no-store");
  return Response.json(data, { ...init, headers });
}

/** Wrap a handler: ApiError -> its status and message, anything else -> 500 with a readable message. */
export function handle<A extends unknown[]>(fn: (...args: A) => Promise<Response> | Response) {
  return async (...args: A): Promise<Response> => {
    try {
      return await fn(...args);
    } catch (e) {
      if (e instanceof ApiError) return json({ error: e.body.error ?? "error", message: e.message, ...e.body }, { status: e.status });
      log.error(`unhandled: ${(e as Error).stack ?? e}`);
      return json({ error: "server_error", message: (e as Error).message ?? "Unexpected server error" }, { status: 500 });
    }
  };
}

export class Args {
  constructor(private params: URLSearchParams) {}

  static of(req: Request) {
    return new Args(new URL(req.url).searchParams);
  }

  str(name: string, def = ""): string {
    return this.params.get(name) ?? def;
  }

  /** Like the Flask arg_int: clamp to [lo, hi], fall back to the default when not a number. */
  int(name: string, def: number, lo = 1, hi = 5000): number {
    const raw = this.params.get(name);
    if (raw === null) return Math.max(lo, Math.min(hi, def));
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n) || !/^\s*[+-]?\d+\s*$/.test(raw)) return def;
    return Math.max(lo, Math.min(hi, n));
  }

  /** YYYY-MM-DD or null; throws 400 for malformed dates. */
  date(name: string, value?: string | null): string | null {
    const v = (value ?? this.params.get(name) ?? "").trim();
    return checkDate(name, v);
  }
}

export function checkDate(name: string, v: string | null | undefined): string | null {
  const s = (v ?? "").trim();
  if (!s) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw badRequest(`${name} must be a date in YYYY-MM-DD format`);
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) throw badRequest(`${name} is not a valid date`);
  return s;
}

export async function body<T = Row>(req: Request): Promise<T> {
  try {
    return ((await req.json()) ?? {}) as T;
  } catch {
    return {} as T;
  }
}

export type Ctx<P> = { params: Promise<P> };
