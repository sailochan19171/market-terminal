// BSE indices - the master list and their current values.
//
// Endpoints:
//   * IndexList/w          -> code/name for every BSE index
//   * IndexMasterNew_ng/w  -> live LTP/change per index, paginated
import { now, type Db } from "../db";
import { logger } from "../log";
import type { BSEClient } from "./client";
import { asDict, asList, isDict, pyFloat, pyInt, pyParseFloat, pyTruthy, strOf, strOrEmpty } from "./pyCompat";

const log = logger("bse.indices");

export const INDEX_LIST = "IndexList/w";
export const INDEX_VALUES = "IndexMasterNew_ng/w";
const MAX_PAGES = 20;

export interface IndexRow { index_code: string; index_name: string; updated_at: string }
export interface IndexValue {
  index_code: string; as_of: string; value: number | null; change: number | null; pct_change: number | null;
  open: null; high: null; low: null; prev_close: number | null;
}

/** Rows of the IndexList/w payload. */
export function parseList(raw: unknown, ts: string = now()): IndexRow[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((r) => strOf(asDict(r).sccode))
    .map((r) => ({ index_code: strOf(asDict(r).sccode), index_name: strOrEmpty(asDict(r).scname), updated_at: ts }));
}

/** The page's row list. The endpoint uses a lowercase 'table' key. */
function pageTable(payload: Record<string, unknown>): unknown[] {
  const t = pyTruthy(payload.table) ? payload.table : pyTruthy(payload.Table) ? payload.Table : [];
  return asList(t);
}

/** `int(float(table[0].get("TotalPageCnt") or 1))`, falling back to 1 where Python raised ValueError/TypeError. */
export function totalPages(first: unknown): number {
  const v = asDict(first).TotalPageCnt;
  const x = pyTruthy(v) ? v : 1;
  let f: number | null;
  if (typeof x === "number" || typeof x === "boolean") f = Number(x);
  else if (typeof x === "string") f = pyParseFloat(x);
  else f = null;
  if (f === null || Number.isNaN(f)) return 1;
  return pyInt(f); // float("inf") raised OverflowError in Python, which was not caught either
}

/** Value rows of one IndexMasterNew_ng page, skipping codes already in `seen`. Returns the fresh count. */
export function parseValuesPage(table: unknown[], ts: string, seen: Set<string>, out: IndexValue[]): number {
  let fresh = 0;
  for (const item of table) {
    const r = asDict(item);
    const code = strOf(r.code);
    if (!code || seen.has(code)) continue;
    seen.add(code);
    fresh++;
    out.push({
      index_code: code,
      as_of: ts,
      value: pyFloat(r.LTP),
      change: pyFloat(r.CHANGE),
      pct_change: pyFloat(r.PERCENTCHG),
      open: null,
      high: null,
      low: null,
      prev_close: pyFloat(r.Prev_Close),
    });
  }
  return fresh;
}

export async function fetchList(client: BSEClient): Promise<IndexRow[]> {
  const raw = await client.api(INDEX_LIST, { type: "", ddlchar: "", index: "", period: "" });
  return parseList(raw);
}

/** Current value/change for every index, walking all pages. */
export async function fetchValues(client: BSEClient): Promise<IndexValue[]> {
  const ts = now();
  const seen = new Set<string>();
  const out: IndexValue[] = [];

  for (let page = 1; page <= MAX_PAGES; page++) {
    const payload = await client.api(INDEX_VALUES, { pageno: page });
    if (!isDict(payload)) break;
    const table = pageTable(payload);
    if (!table.length) break;
    if (parseValuesPage(table, ts, seen, out) === 0) break;
    if (page >= totalPages(table[0])) break;
  }
  return out;
}

/** Names carried by one IndexMasterNew_ng page. */
export function parseNamesPage(table: unknown[], ts: string): IndexRow[] {
  const rows: IndexRow[] = [];
  for (const item of table) {
    const r = asDict(item);
    const code = strOf(r.code);
    const name = strOrEmpty(r.INDEXNAME);
    if (code && name) rows.push({ index_code: code, index_name: name, updated_at: ts });
  }
  return rows;
}

/** IndexMasterNew_ng also carries names - use it to fill gaps in the master. */
export async function namesFromValues(client: BSEClient): Promise<IndexRow[]> {
  const ts = now();
  const rows: IndexRow[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const payload = await client.api(INDEX_VALUES, { pageno: page });
    if (!isDict(payload)) break;
    const table = pageTable(payload);
    if (!table.length) break;
    rows.push(...parseNamesPage(table, ts));
    if (page >= totalPages(table[0])) break;
  }
  return rows;
}

export interface IndexSyncOptions { values?: boolean }

/** Index master, then (by default) current values. Returns rows written. */
export async function sync(client: BSEClient, db: Db, opts: IndexSyncOptions = {}): Promise<number> {
  let total = db.upsert("bse_index", await fetchList(client) as unknown as Record<string, unknown>[]);
  log.info(`index master -> ${total}`);

  if (opts.values ?? true) {
    try {
      const vals = await fetchValues(client);
      // Any index that appears only in the values feed still gets a name.
      db.upsert("bse_index", await namesFromValues(client) as unknown as Record<string, unknown>[]);
      const n = db.upsert("index_value", vals as unknown as Record<string, unknown>[]);
      log.info(`index values -> ${n}`);
      total += n;
    } catch (e) {
      log.warn(`index values unavailable: ${(e as Error).message}`);
    }
  }
  return total;
}
