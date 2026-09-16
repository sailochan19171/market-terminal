// Publishes this PC's database to the hosted site's Turso copy: only rows that are new or changed.
//
// The hosted site reads Turso; the data jobs keep running here against the local file. After each update the
// publisher sends the difference, which keeps the hosted copy current within Turso's free write allowance:
//   - "stamp" tables: rows whose write timestamp moved past the last mark, skipped when their content is
//     unchanged (daily syncs rewrite many identical rows);
//   - "date" tables: append-only price history, by trading date;
//   - "full" tables: small derived tables compared row by row, including deletions.
// Watchlist, portfolio and alert tables are not published: on the hosted site they belong to its visitors.
// The full history backfilled here stays local; the hosted site gets recent sessions and filings (see the
// windows below), which keeps it inside Turso's free storage and write allowance.
import crypto from "node:crypto";
import path from "node:path";
import { config } from "../config";
import { Db, getDb, now, type Row } from "../db";
import { logger } from "../log";
import * as published from "../published";
import { SCHEMA as KB_SCHEMA } from "../research/kb";
import { siteCounts } from "../api/v2";
import { buildPulse } from "../api/live";

const log = logger("publish");

type Spec =
  | { table: string; mode: "stamp"; column: string; omit?: string[]; window?: { column: string; years: number } }
  | { table: string; mode: "date"; column: string }
  | { table: string; mode: "full"; ignore: string[] };

export const SPECS: Spec[] = [
  { table: "scrip", mode: "stamp", column: "updated_at" },
  { table: "bse_index", mode: "stamp", column: "updated_at" },
  { table: "corp_action", mode: "stamp", column: "fetched_at" },
  { table: "announcement", mode: "stamp", column: "fetched_at", window: { column: "news_dt", years: 2 } },
  { table: "announcement_day", mode: "stamp", column: "fetched_at", window: { column: "day", years: 2 } },
  { table: "bhavcopy_day", mode: "stamp", column: "fetched_at", window: { column: "trade_date", years: 5 } },
  { table: "nse_symbol", mode: "stamp", column: "updated_at" },
  { table: "nse_index", mode: "stamp", column: "updated_at" },
  { table: "nse_index_constituent", mode: "stamp", column: "updated_at" },
  { table: "nse_announcement", mode: "stamp", column: "fetched_at", window: { column: "ann_dt", years: 2 } },
  { table: "nse_corp_action", mode: "stamp", column: "fetched_at", window: { column: "ex_date", years: 5 } },
  { table: "nse_board_meeting", mode: "stamp", column: "fetched_at", window: { column: "meeting_dt", years: 2 } },
  { table: "nse_financial_result", mode: "stamp", column: "fetched_at" },
  { table: "nse_fundamental", mode: "stamp", column: "fetched_at" },
  { table: "nse_statement", mode: "stamp", column: "fetched_at" },
  { table: "nse_shareholding", mode: "stamp", column: "fetched_at" },
  { table: "nse_shareholding_detail", mode: "stamp", column: "fetched_at" },
  { table: "nse_insider_trade", mode: "stamp", column: "fetched_at", window: { column: "broadcast", years: 2 } },
  { table: "nse_bhavcopy_day", mode: "stamp", column: "fetched_at", window: { column: "trade_date", years: 5 } },
  { table: "nse_index_history_day", mode: "stamp", column: "fetched_at", window: { column: "trade_date", years: 5 } },
  { table: "bhavcopy", mode: "date", column: "trade_date" },
  { table: "nse_bhavcopy", mode: "date", column: "trade_date" },
  { table: "nse_index_history", mode: "date", column: "trade_date" },
  { table: "index_value", mode: "date", column: "as_of" },
  { table: "nse_index_value", mode: "date", column: "as_of" },
  { table: "company_metrics", mode: "full", ignore: ["updated_at"] },
  // Research documents: the hosted site searches these to answer questions.
  { table: "kb_doc", mode: "stamp", column: "updated_at" },
  // New analysis versions (scheduled ones follow new results). Ids are assigned by the hosted database, since
  // visitors create versions there too; rows match on (company_key, version).
  { table: "analysis_version", mode: "stamp", column: "updated_at", omit: ["id"] },
];

const PAGE = 2000;

const STATE_SCHEMA = `
CREATE TABLE IF NOT EXISTS publish_mark (tbl TEXT PRIMARY KEY, mark TEXT);
CREATE TABLE IF NOT EXISTS publish_hash (tbl TEXT NOT NULL, pk TEXT NOT NULL, hash TEXT NOT NULL, PRIMARY KEY (tbl, pk));
`;

/** Publishing state lives beside the database, not in it, so it never travels to Turso. */
export function openState(): Db {
  const db = new Db({ kind: "local", file: path.join(path.dirname(config.DB_PATH), "publish.db") });
  db.exec(STATE_SCHEMA);
  return db;
}

export function openRemote(): Db {
  if (!config.TURSO_DATABASE_URL || !config.TURSO_AUTH_TOKEN) throw new Error("set TURSO_DATABASE_URL and TURSO_AUTH_TOKEN in .env to publish");
  return new Db({ kind: "remote", url: config.TURSO_DATABASE_URL, token: config.TURSO_AUTH_TOKEN });
}

export const isConfigured = () => Boolean(config.TURSO_DATABASE_URL && config.TURSO_AUTH_TOKEN);

const primaryKey = (db: Db, table: string) =>
  db.all<{ name: string; pk: number }>(`PRAGMA table_info("${table}")`).filter((c) => c.pk).sort((a, b) => a.pk - b.pk).map((c) => c.name);

const digest = (row: Row, skip: string[]) =>
  crypto.createHash("sha1").update(JSON.stringify(Object.keys(row).filter((k) => !skip.includes(k)).map((k) => {
    const v = row[k];
    return v instanceof Uint8Array ? Buffer.from(v).toString("base64") : v;
  }))).digest("base64");

/** Add columns the local schema gained since the hosted copy was uploaded. */
function alignColumns(local: Db, remote: Db, table: string) {
  const have = remote.columns(table);
  if (!have.size) throw new Error(`table ${table} is missing on the hosted database`);
  for (const c of local.all<{ name: string; type: string }>(`PRAGMA table_info("${table}")`)) {
    if (!have.has(c.name)) {
      log.info(`adding column ${table}.${c.name} on the hosted database`);
      remote.exec(`ALTER TABLE "${table}" ADD COLUMN "${c.name}" ${c.type || ""}`);
    }
  }
}

function publishRows(state: Db, remote: Db, spec: Spec, rows: Row[], pk: string[], skip: string[]): number {
  const changed: Row[] = [];
  const hashes: [string, string][] = [];
  for (const row of rows) {
    const key = JSON.stringify(pk.map((k) => row[k]));
    const hash = digest(row, skip);
    if (state.scalar<string>("SELECT hash FROM publish_hash WHERE tbl = ? AND pk = ?", [spec.table, key]) === hash) continue;
    changed.push(row);
    hashes.push([key, hash]);
  }
  if (changed.length) remote.upsert(spec.table, changed);
  // Recorded only after the hosted copy accepted the rows, so a failed run is simply repeated.
  state.transaction(() => {
    for (const [key, hash] of hashes) state.run("INSERT INTO publish_hash (tbl, pk, hash) VALUES (?, ?, ?) ON CONFLICT(tbl, pk) DO UPDATE SET hash = excluded.hash", [spec.table, key, hash]);
  });
  return changed.length;
}

function publishTable(local: Db, remote: Db, state: Db, spec: Spec): number {
  if (!local.hasTable(spec.table)) return 0;
  const omitted = spec.mode === "stamp" ? spec.omit ?? [] : [];
  // Rows whose own key is omitted are identified by the table's other unique columns.
  const pk = omitted.length && spec.table === "analysis_version" ? ["company_key", "version"] : primaryKey(local, spec.table);
  alignColumns(local, remote, spec.table);

  if (spec.mode === "full") {
    const rows = local.all(`SELECT * FROM "${spec.table}"`);
    const sent = publishRows(state, remote, spec, rows, pk, spec.ignore);
    const present = new Set(rows.map((r) => JSON.stringify(pk.map((k) => r[k]))));
    const gone = state.all<{ pk: string }>("SELECT pk FROM publish_hash WHERE tbl = ?", [spec.table]).map((r) => r.pk).filter((k) => !present.has(k));
    for (const key of gone) {
      const values = JSON.parse(key) as (string | number | null)[];
      remote.run(`DELETE FROM "${spec.table}" WHERE ${pk.map((k) => `"${k}" = ?`).join(" AND ")}`, values);
      state.run("DELETE FROM publish_hash WHERE tbl = ? AND pk = ?", [spec.table, key]);
    }
    return sent + gone.length;
  }

  let mark = state.scalar<string>("SELECT mark FROM publish_mark WHERE tbl = ?", [spec.table]);
  if (mark === null) {
    log.warn(`${spec.table}: no publish mark; run "publish init --from <uploaded snapshot>" first`);
    return 0;
  }
  const skip = spec.mode === "stamp" ? [spec.column] : [];
  let sent = 0;
  // Start strictly after the mark; within a run, page by (column, rowid) so rows sharing one timestamp are
  // never skipped at a page boundary.
  let cursor: [string, number] = [mark, Number.MAX_SAFE_INTEGER];
  for (;;) {
    const win = spec.mode === "stamp" && spec.window ? spec.window : null;
    const cutoff = win ? `${new Date().getFullYear() - win.years}${new Date().toISOString().slice(4, 10)}` : "";
    const rows = local.all(`SELECT rowid AS __rowid, * FROM "${spec.table}" WHERE ("${spec.column}" > ? OR ("${spec.column}" = ? AND rowid > ?))${win ? ` AND substr("${win.column}", 1, 10) >= ?` : ""} ORDER BY "${spec.column}", rowid LIMIT ${PAGE}`,
      win ? [cursor[0], cursor[0], cursor[1], cutoff] : [cursor[0], cursor[0], cursor[1]]);
    if (!rows.length) break;
    const last = rows[rows.length - 1];
    cursor = [String(last[spec.column]), Number(last.__rowid)];
    const drop = ["__rowid", ...(spec.mode === "stamp" ? spec.omit ?? [] : [])];
    const clean = rows.map((r) => {
      const copy = { ...r };
      for (const k of drop) delete copy[k];
      return copy;
    });
    sent += spec.mode === "stamp" ? publishRows(state, remote, spec, clean, pk, skip) : (remote.upsert(spec.table, clean), clean.length);
    mark = cursor[0];
    state.run("INSERT INTO publish_mark (tbl, mark) VALUES (?, ?) ON CONFLICT(tbl) DO UPDATE SET mark = excluded.mark", [spec.table, mark]);
    if (rows.length < PAGE) break;
  }
  return sent;
}

/** Push every table's new and changed rows plus the site counts. Returns rows sent per table. */
export function publish(local: Db = getDb()): Record<string, number> {
  const remote = openRemote();
  const state = openState();
  const sent: Record<string, number> = {};
  try {
    remote.exec(published.SCHEMA);
    remote.exec(KB_SCHEMA);
    for (const spec of SPECS) {
      const t0 = Date.now();
      try {
        sent[spec.table] = publishTable(local, remote, state, spec);
        if (sent[spec.table]) log.info(`${spec.table}: ${sent[spec.table]} rows in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      } catch (e) {
        log.error(`${spec.table}: ${(e as Error).message}`);
      }
    }
    published.write(remote, published.SITE_STATS, siteCounts(local), now());
  } finally {
    remote.close();
    state.close();
  }
  return sent;
}

/** Start marks from the snapshot that was uploaded, so the first publish sends only what changed since. */
export function initFromSnapshot(snapshotFile: string) {
  const snap = new Db({ kind: "local", file: snapshotFile, readOnly: true });
  const state = openState();
  try {
    for (const spec of SPECS) {
      if (!snap.hasTable(spec.table)) continue;
      if (spec.mode === "full") {
        const pk = primaryKey(snap, spec.table);
        const rows = snap.all(`SELECT * FROM "${spec.table}"`);
        state.transaction(() => {
          state.run("DELETE FROM publish_hash WHERE tbl = ?", [spec.table]);
          for (const r of rows) state.run("INSERT INTO publish_hash (tbl, pk, hash) VALUES (?, ?, ?)", [spec.table, JSON.stringify(pk.map((k) => r[k])), digest(r, spec.ignore)]);
        });
        log.info(`${spec.table}: ${rows.length} row hashes from the snapshot`);
        continue;
      }
      const mark = snap.scalar<string>(`SELECT MAX("${spec.column}") FROM "${spec.table}"`) ?? "";
      state.run("INSERT INTO publish_mark (tbl, mark) VALUES (?, ?) ON CONFLICT(tbl) DO UPDATE SET mark = excluded.mark", [spec.table, mark]);
      log.info(`${spec.table}: mark ${mark || "(empty)"}`);
    }
  } finally {
    snap.close();
    state.close();
  }
}

/** Build the live market pulse here and publish it for the hosted site. */
export async function publishLive(): Promise<void> {
  const pulse = await buildPulse();
  const remote = openRemote();
  try {
    remote.exec(published.SCHEMA);
    published.write(remote, published.LIVE_PULSE, pulse, now());
  } finally {
    remote.close();
  }
}

/** NSE's cash session in IST, with a little margin for the pre-open and the closing prints. */
export function marketHours(at = new Date()): boolean {
  const day = new Date(at.toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  const minutes = day.getHours() * 60 + day.getMinutes();
  return day.getDay() >= 1 && day.getDay() <= 5 && minutes >= 9 * 60 && minutes <= 15 * 60 + 45;
}
