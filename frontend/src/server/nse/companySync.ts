// On-demand refresh of one company's filings.
//
// The background worker parses ~100k filings largest-company-first, which takes hours. When someone opens
// a company page whose results, shareholding or statements have not been read yet, the API queues that
// company here; the job runner picks it up within seconds and reports progress in the same row, so the
// page can show it instead of an empty section. The web server itself never does the network work.
import { now, type Db, type Row } from "../db";

export const PARSER_VERSION = 3;
const RESYNC_HOURS = 12;

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS company_sync (
    symbol      TEXT PRIMARY KEY,
    status      TEXT NOT NULL,          -- queued | running | done | error
    stage       TEXT,
    done        INTEGER DEFAULT 0,
    total       INTEGER DEFAULT 0,
    started_at  TEXT,
    finished_at TEXT,
    error       TEXT
);
`;

export function ensureSchema(db: Db) {
  db.exec(SCHEMA);
}

export function pendingResultsCount(db: Db, symbol: string): number {
  return db.scalar<number>(
    "SELECT COUNT(*) FROM nse_financial_result r LEFT JOIN nse_fundamental f ON f.symbol = r.symbol AND f.period_end = r.period_end AND f.consolidated = r.consolidated "
    + "WHERE r.symbol = ? AND r.xbrl_url IS NOT NULL AND r.xbrl_url != '' AND (f.symbol IS NULL OR (COALESCE(f.parser_version, 1) < ? AND f.quality IN ('ok', 'suspect')))",
    [symbol, PARSER_VERSION]) ?? 0;
}

function pendingStatements(db: Db, symbol: string): boolean {
  if (!db.hasTable("nse_statement")) return true;
  return Boolean(db.get(
    "SELECT 1 FROM nse_financial_result r LEFT JOIN (SELECT DISTINCT symbol, period_end, consolidated FROM nse_statement WHERE symbol = ?) s "
    + "ON s.period_end = r.period_end AND s.consolidated = r.consolidated WHERE r.symbol = ? AND r.xbrl_url IS NOT NULL AND r.xbrl_url != '' "
    + "AND substr(r.period_end, 6, 2) IN ('03', '09') AND s.period_end IS NULL LIMIT 1", [symbol, symbol]));
}

/** True when this company has unread filings and was not synced recently. */
export function needsSync(db: Db, symbol: string): boolean {
  ensureSchema(db);
  const recent = db.get("SELECT 1 FROM company_sync WHERE symbol = ? AND status IN ('queued','running','done') AND started_at >= datetime('now', ?)", [symbol, `-${RESYNC_HOURS} hours`]);
  if (recent) return false;
  if (pendingResultsCount(db, symbol)) return true;
  if (!db.get("SELECT 1 FROM nse_shareholding_detail WHERE symbol = ? LIMIT 1", [symbol])) return true;
  return pendingStatements(db, symbol);
}

export function status(db: Db, symbol: string): Row {
  ensureSchema(db);
  const row = db.get("SELECT * FROM company_sync WHERE symbol = ?", [symbol]);
  const out: Row = row ? { ...row } : { symbol, status: "idle" };
  const active = out.status === "queued" || out.status === "running";
  if (out.status === "queued") {
    out.status = "running";
    out.stage = out.stage ?? "queued";
  }
  out.pendingResults = pendingResultsCount(db, symbol);
  out.running = active;
  return out;
}

/** Ask the job runner to refresh this company. False when one is already queued or running. */
export function start(db: Db, symbol: string): boolean {
  ensureSchema(db);
  const s = symbol.toUpperCase();
  const cur = db.get("SELECT status FROM company_sync WHERE symbol = ?", [s]);
  if (cur && (cur.status === "queued" || cur.status === "running")) return false;
  db.run("INSERT INTO company_sync (symbol, status, stage, done, total, started_at, finished_at, error) VALUES (?, 'queued', 'queued', 0, 0, ?, NULL, NULL) "
    + "ON CONFLICT(symbol) DO UPDATE SET status = 'queued', stage = 'queued', done = 0, total = 0, started_at = excluded.started_at, finished_at = NULL, error = NULL",
    [s, now()]);
  return true;
}

/** Update fields of the status row, creating it if needed. */
export function setStatus(db: Db, symbol: string, fields: Record<string, string | number | null>) {
  const keys = Object.keys(fields);
  const r = db.run(`UPDATE company_sync SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE symbol = ?`, [...keys.map((k) => fields[k]), symbol]);
  if (!r.changes) {
    const all = { status: "running", ...fields, symbol };
    const cols = Object.keys(all);
    db.run(`INSERT INTO company_sync (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`, cols.map((k) => (all as Row)[k]));
  }
}

/** Queued companies, oldest request first (consumed by the job runner). */
export const queued = (db: Db, limit = 3): string[] =>
  db.all<{ symbol: string }>("SELECT symbol FROM company_sync WHERE status = 'queued' ORDER BY started_at LIMIT ?", [limit]).map((r) => r.symbol);
