// Values this PC computes and publishes for the hosted site, which cannot compute them cheaply itself:
// the live market pulse (NSE live feeds) and site-wide counts (full scans over a million filings).
import type { Db } from "./db";

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS published_value (
    key        TEXT PRIMARY KEY,
    data       TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
`;

export const LIVE_PULSE = "live_pulse";
export const SITE_STATS = "site_stats";

/** The published JSON for `key` with its timestamp, or null when missing (or the table does not exist yet). */
export function read<T>(db: Db, key: string): { data: T; updatedAt: string } | null {
  try {
    const row = db.get<{ data: string; updated_at: string }>("SELECT data, updated_at FROM published_value WHERE key = ?", [key]);
    return row ? { data: JSON.parse(row.data) as T, updatedAt: row.updated_at } : null;
  } catch {
    return null;
  }
}

export function write(db: Db, key: string, data: unknown, updatedAt: string) {
  db.run("INSERT INTO published_value (key, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at",
    [key, JSON.stringify(data), updatedAt]);
}
