// The data cache (spec §5.3): read from cache first, refresh on the schedule the spec sets.
//
// The spec names PostgreSQL and Redis; this platform's database plays both parts. Indian filings and prices are
// already stored by the daily collectors, so they need no second copy. What is cached here is data fetched from
// outside at request time - US statements, prices and filings - with the spec's refresh intervals, plus computed
// ratio reports keyed by a hash of their inputs, so a report is invalidated the moment any input changes.
import { createHash } from "node:crypto";
import type { Db } from "../db";
import { logger } from "../log";

const log = logger("agent-cache");

export const TTL = {
  statements: 24 * 3600_000,   // annual and quarterly statements: checked daily for a new filing
  prices: 12 * 3600_000,        // end of day
  profile: 7 * 24 * 3600_000,   // profile and peers: weekly
  news: 6 * 3600_000,           // news: 6 hours
} as const;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS agent_cache (
    key         TEXT PRIMARY KEY,
    value       TEXT NOT NULL,
    source      TEXT,
    fetched_at  TEXT NOT NULL,
    expires_at  TEXT NOT NULL
);`;

let ready = false;
const memory = new Map<string, { value: unknown; source: string; fetchedAt: string; expires: number }>();

function ensure(db: Db) {
  if (ready) return;
  try {
    db.exec(SCHEMA);
  } catch { /* a read-only database still works from memory */ }
  ready = true;
}

export interface Cached<T> { value: T; source: string; fetchedAt: string; fromCache: boolean }

/**
 * The cached value when it is fresh; otherwise `fetch` it, store it, and return it. If the fetch fails and a
 * stale copy exists, the stale copy is returned rather than nothing (spec §8.2: "then try the cache").
 */
export async function cached<T>(db: Db, key: string, ttlMs: number, source: string, fetch: () => Promise<T>): Promise<Cached<T>> {
  ensure(db);
  const now = Date.now();
  const mem = memory.get(key);
  if (mem && mem.expires > now) return { value: mem.value as T, source: mem.source, fetchedAt: mem.fetchedAt, fromCache: true };

  let stale: Cached<T> | null = null;
  try {
    const row = db.get<{ value: string; source: string; fetched_at: string; expires_at: string }>("SELECT value, source, fetched_at, expires_at FROM agent_cache WHERE key = ?", [key]);
    if (row) {
      const hit = { value: JSON.parse(row.value) as T, source: row.source, fetchedAt: row.fetched_at, fromCache: true };
      if (new Date(row.expires_at).getTime() > now) {
        memory.set(key, { value: hit.value, source: hit.source, fetchedAt: hit.fetchedAt, expires: new Date(row.expires_at).getTime() });
        return hit;
      }
      stale = hit;
    }
  } catch { /* no table yet */ }

  try {
    const value = await fetch();
    const fetchedAt = new Date().toISOString();
    const expires = now + ttlMs;
    memory.set(key, { value, source, fetchedAt, expires });
    try {
      db.upsert("agent_cache", [{ key, value: JSON.stringify(value), source, fetched_at: fetchedAt, expires_at: new Date(expires).toISOString() }]);
    } catch (e) {
      log.warn(`could not store ${key}: ${(e as Error).message}`);
    }
    return { value, source, fetchedAt, fromCache: false };
  } catch (e) {
    if (stale) {
      log.warn(`${key}: fetch failed (${(e as Error).message}); serving the copy from ${stale.fetchedAt}`);
      return { ...stale, source: `${stale.source} (cached copy; the refresh failed)` };
    }
    throw e;
  }
}

/** Retry with exponential backoff: three tries by default (spec §8.2). */
export async function withRetry<T>(what: string, fn: () => Promise<T>, tries = 3, baseMs = 500): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (i < tries - 1) {
        const wait = baseMs * 2 ** i;
        log.warn(`${what} failed (${(e as Error).message}); retry ${i + 1} in ${wait} ms`);
        await new Promise((r) => setTimeout(r, wait));
      }
    }
  }
  throw last;
}

// --- computed ratio reports, keyed by their inputs --------------------------------------------

const reports = new Map<string, { at: number; value: unknown }>();

export const inputHash = (value: unknown) => createHash("sha1").update(JSON.stringify(value)).digest("hex");

/** A computed report for exactly these inputs; any change to an input produces a different key. */
export function memoReport<T>(inputs: unknown, compute: () => T): T {
  const key = inputHash(inputs);
  const hit = reports.get(key);
  if (hit) return hit.value as T;
  const value = compute();
  reports.set(key, { at: Date.now(), value });
  if (reports.size > 200) reports.delete(reports.keys().next().value!);
  return value;
}
