// SQLite access on Node's built-in driver (node:sqlite), shared by API routes, jobs and the CLI.
import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";
import { config, ensureDirs } from "./config";
import { SCHEMA_BSE, SCHEMA_NSE } from "./core/schema";

export type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
export type Param = string | number | bigint | null | undefined | boolean | Uint8Array;

const BUSY_TIMEOUT_MS = 120_000;

/** ISO-8601 UTC timestamp with seconds, matching the stored format ("2026-09-13T07:32:18+00:00"). */
export function now(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "+00:00");
}

const bind = (params: Param[]): SQLInputValue[] =>
  params.map((p) => (p === undefined ? null : typeof p === "boolean" ? (p ? 1 : 0) : p)) as SQLInputValue[];

// Columns added after a table first shipped; CREATE TABLE IF NOT EXISTS leaves old tables as they were.
const MIGRATIONS: Record<string, Record<string, string>> = {
  holding: { name: "TEXT", asset_type: "TEXT", account: "TEXT" },
  nse_fundamental: {
    finance_costs: "REAL", depreciation: "REAL", employee_cost: "REAL", exceptional: "REAL", tax: "REAL",
    pat_owners: "REAL", parser_version: "INTEGER", face_value: "REAL", shares: "REAL", cogs: "REAL",
    gross_profit: "REAL", equity: "REAL", borrowings: "REAL", total_assets: "REAL", report_format: "TEXT",
  },
};

export class Db {
  readonly raw: DatabaseSync;
  private cache = new Map<string, StatementSync>();

  constructor(file = config.DB_PATH, opts: { readOnly?: boolean } = {}) {
    ensureDirs();
    this.raw = new DatabaseSync(file, { readOnly: opts.readOnly ?? false });
    this.raw.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    if (!opts.readOnly) this.raw.exec("PRAGMA foreign_keys = ON");
  }

  private stmt(sql: string): StatementSync {
    let s = this.cache.get(sql);
    if (!s) {
      s = this.raw.prepare(sql);
      if (this.cache.size > 500) this.cache.clear();
      this.cache.set(sql, s);
    }
    return s;
  }

  all<T = Row>(sql: string, params: Param[] = []): T[] {
    return this.stmt(sql).all(...bind(params)) as T[];
  }

  get<T = Row>(sql: string, params: Param[] = []): T | undefined {
    return this.stmt(sql).get(...bind(params)) as T | undefined;
  }

  /** First column of the first row, or null. */
  scalar<T = unknown>(sql: string, params: Param[] = []): T | null {
    const row = this.stmt(sql).get(...bind(params)) as Row | undefined;
    if (!row) return null;
    const v = Object.values(row)[0];
    return (v === undefined ? null : v) as T | null;
  }

  run(sql: string, params: Param[] = []) {
    return this.stmt(sql).run(...bind(params));
  }

  exec(sql: string) {
    this.raw.exec(sql);
  }

  /** Run `fn` in a write transaction. BEGIN IMMEDIATE takes the write lock up front, so a long
   *  reader in another process never leaves us unable to upgrade (the classic BUSY deadlock). */
  transaction<T>(fn: () => T): T {
    if (this.raw.isTransaction) return fn();
    this.raw.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      this.raw.exec("COMMIT");
      return out;
    } catch (e) {
      try { this.raw.exec("ROLLBACK"); } catch { /* already rolled back */ }
      throw e;
    }
  }

  /** INSERT ... ON CONFLICT DO UPDATE for uniform rows (columns come from the first row). */
  upsert(table: string, rows: Row[]): number {
    const list = rows.filter(Boolean);
    if (!list.length) return 0;
    const cols = Object.keys(list[0]);
    const sql = `INSERT INTO "${table}" (${cols.map((c) => `"${c}"`).join(", ")}) VALUES (${cols.map(() => "?").join(", ")}) `
      + `ON CONFLICT DO UPDATE SET ${cols.map((c) => `"${c}" = excluded."${c}"`).join(", ")}`;
    const st = this.stmt(sql);
    this.transaction(() => {
      for (const r of list) st.run(...bind(cols.map((c) => r[c])));
    });
    return list.length;
  }

  columns(table: string): Set<string> {
    return new Set(this.all<{ name: string }>(`PRAGMA table_info(${table})`).map((r) => r.name));
  }

  hasTable(name: string): boolean {
    return Boolean(this.get("SELECT 1 FROM sqlite_master WHERE name = ?", [name]));
  }

  /** Add missing columns (idempotent). */
  addColumns(table: string, cols: Record<string, string>) {
    const have = this.columns(table);
    if (!have.size) return;
    for (const [col, kind] of Object.entries(cols)) {
      if (!have.has(col)) this.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${kind}`);
    }
  }

  close() {
    this.cache.clear();
    this.raw.close();
  }
}

let shared: Db | null = null;
const initialised = new WeakSet<Db>();

/** Base schema plus column migrations. Module-specific tables are created by their own ensureSchema(). */
export function init(db: Db) {
  if (initialised.has(db)) return;
  db.exec(SCHEMA_BSE);
  db.exec(SCHEMA_NSE);
  for (const [table, cols] of Object.entries(MIGRATIONS)) db.addColumns(table, cols);
  initialised.add(db);
}

/** The process-wide connection (API routes). Jobs open their own with `openDb()`. */
export function getDb(): Db {
  if (!shared) {
    shared = new Db();
    init(shared);
  }
  return shared;
}

export function openDb(): Db {
  const db = new Db();
  init(db);
  return db;
}

// --- run bookkeeping ---------------------------------------------------------------
export function startRun(db: Db, task: string): number {
  const r = db.run("INSERT INTO run_log (task, started_at, status) VALUES (?, ?, 'running')", [task, now()]);
  return Number(r.lastInsertRowid);
}

export function endRun(db: Db, id: number, status: string, rows = 0, message = "") {
  db.run("UPDATE run_log SET ended_at = ?, status = ?, rows = ?, message = ? WHERE id = ?", [now(), status, rows, message.slice(0, 2000), id]);
}

/** Record a task in run_log around `fn`, like run.py's run_task. */
export async function runTask(db: Db, task: string, fn: () => Promise<number> | number): Promise<number> {
  const id = startRun(db, task);
  try {
    const n = await fn();
    endRun(db, id, "ok", n);
    return n;
  } catch (e) {
    endRun(db, id, "error", 0, e instanceof Error ? e.message : String(e));
    throw e;
  }
}
