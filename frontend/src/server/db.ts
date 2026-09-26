// SQLite access shared by API routes, jobs and the CLI: Node's built-in driver (node:sqlite) for the local file,
// or Turso over HTTP for the hosted site, behind one synchronous interface.
import type { DatabaseSync, SQLInputValue, StatementSync } from "node:sqlite";
import { config, ensureDirs } from "./config";
import { SCHEMA_BSE, SCHEMA_NSE } from "./core/schema";
import { RemoteDriver, type Value } from "./remoteDb";

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

/** Where a connection points: the local SQLite file, or a hosted Turso database. */
export type Target = { kind: "local"; file?: string; readOnly?: boolean } | { kind: "remote"; url: string; token: string };

/** The deployment's database: Turso when MARKET_DB=turso (the hosted site), otherwise the local file. */
export function defaultTarget(): Target {
  return config.DB_MODE === "turso" ? { kind: "remote", url: config.TURSO_DATABASE_URL, token: config.TURSO_AUTH_TOKEN } : { kind: "local" };
}

// Loaded on first use so hosted functions, which never open a local file, do not need node:sqlite at all.
const sqlite = () => process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");

export class Db {
  readonly remote: RemoteDriver | null = null;
  private local: DatabaseSync | null = null;
  private cache = new Map<string, StatementSync>();

  constructor(target: Target = defaultTarget()) {
    if (target.kind === "remote") {
      if (!target.url || !target.token) throw new Error("TURSO_DATABASE_URL and TURSO_AUTH_TOKEN must be set to use the hosted database");
      this.remote = new RemoteDriver(target.url, target.token);
      return;
    }
    // Anything that is not one of the two kinds is a mistake at the call site, and opening the local file instead
    // would hide it: a job would report on the copy on this machine while believing it was reading the hosted one.
    if (target.kind !== "local") throw new Error(`unknown database kind '${String((target as { kind: string }).kind)}': use { kind: "local" } or { kind: "remote", url, token }`);
    ensureDirs();
    this.local = new (sqlite().DatabaseSync)(target.file ?? config.DB_PATH, { readOnly: target.readOnly ?? false });
    this.local.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    if (!target.readOnly) this.local.exec("PRAGMA foreign_keys = ON");
  }

  get isRemote() {
    return this.remote !== null;
  }

  private stmt(sql: string): StatementSync {
    let s = this.cache.get(sql);
    if (!s) {
      s = this.local!.prepare(sql);
      if (this.cache.size > 500) this.cache.clear();
      this.cache.set(sql, s);
    }
    return s;
  }

  all<T = Row>(sql: string, params: Param[] = []): T[] {
    if (this.remote) return this.remote.all(sql, bind(params) as Value[]) as T[];
    return this.stmt(sql).all(...bind(params)) as T[];
  }

  get<T = Row>(sql: string, params: Param[] = []): T | undefined {
    if (this.remote) return this.remote.all(sql, bind(params) as Value[])[0] as T | undefined;
    return this.stmt(sql).get(...bind(params)) as T | undefined;
  }

  /** First column of the first row, or null. */
  scalar<T = unknown>(sql: string, params: Param[] = []): T | null {
    const row = this.get<Row>(sql, params);
    if (!row) return null;
    const v = Object.values(row)[0];
    return (v === undefined ? null : v) as T | null;
  }

  run(sql: string, params: Param[] = []): { changes: number | bigint; lastInsertRowid: number | bigint } {
    if (this.remote) return this.remote.run(sql, bind(params) as Value[]);
    return this.stmt(sql).run(...bind(params));
  }

  exec(sql: string) {
    if (this.remote) this.remote.exec(sql);
    else this.local!.exec(sql);
  }

  /** Run `fn` in a write transaction. Locally BEGIN IMMEDIATE takes the write lock up front, so a long
   *  reader in another process never leaves us unable to upgrade (the classic BUSY deadlock). */
  transaction<T>(fn: () => T): T {
    if (this.remote) {
      this.remote.begin();
      try {
        const out = fn();
        this.remote.commit();
        return out;
      } catch (e) {
        try { this.remote.rollback(); } catch { /* the stream is gone either way */ }
        throw e;
      }
    }
    if (this.local!.isTransaction) return fn();
    this.local!.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      this.local!.exec("COMMIT");
      return out;
    } catch (e) {
      try { this.local!.exec("ROLLBACK"); } catch { /* already rolled back */ }
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
    if (this.remote) {
      this.remote.runMany(sql, list.map((r) => bind(cols.map((c) => r[c])) as Value[]));
      return list.length;
    }
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
    this.local?.close();
    this.remote?.close();
  }
}

let shared: Db | null = null;
const initialised = new WeakSet<Db>();

/** Base schema plus column migrations. Module-specific tables are created by their own ensureSchema(). */
export function init(db: Db) {
  // The hosted database is uploaded with its schema, and Turso refuses schema-level PRAGMAs such as journal_mode.
  if (initialised.has(db) || db.isRemote) return;
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

export function openDb(target: Target = defaultTarget()): Db {
  const db = new Db(target);
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
