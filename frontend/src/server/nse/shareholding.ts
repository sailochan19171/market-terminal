// Shareholding patterns - full history and category detail per company.
//
// Two sources:
//   * /api/corporate-share-holdings-master?index=equities&symbol=X - every quarterly filing for one company
//     (about 20 quarters), each with a link to its XBRL document.
//   * The shareholding-pattern XBRL itself, which splits holdings into the SEBI categories (promoter group,
//     foreign and domestic institutions, government, non-institutions) and gives shareholder counts.
//
// The summary feed only carries promoter and public percentages; FII, DII, government and the number of
// shareholders come from the XBRL.
import { now, type Db, type Row } from "../db";
import { NotFound } from "../http";
import { logger } from "../log";
import type { NSEClient } from "./client";
import { elText, NUM, readXml, XbrlParseError, xbrlNumber } from "./fundamentals";
import { isoDateOf, pyFloatLoose, pyJsonDumps, pyStrip, strptime, textOf, textOrNull } from "./py";
import { ensureSchema } from "./shareholdingSchema";

export { ensureSchema, SCHEMA } from "./shareholdingSchema";

const log = logger("nse.shareholding");

export const MASTER = "corporate-share-holdings-master";

/** XBRL category member -> our column. Percentages are fractions of 1 in newer files. */
export const MEMBERS = new Map<string, string>([
  ["ShareholdingOfPromoterAndPromoterGroupMember", "promoter"],
  ["InstitutionsForeignMember", "fii"],
  ["InstitutionsDomesticMember", "dii"],
  ["GovernmentsMember", "government"],
  ["NonInstitutionsMember", "public"],
  ["ShareholdingPatternMember", "total"],
]);

/** "30-SEP-2021" -> "2021-09-30"; anything else is kept as the stripped text. */
export function parseDate(v: unknown): string {
  const s = textOf(v);
  for (const fmt of ["%d-%b-%Y", "%d-%B-%Y"]) {
    const d = strptime(s, fmt); // strptime is case-insensitive, so Python's .title() changes nothing
    if (d) return isoDateOf(d);
  }
  return s;
}

export interface ShareholdingDetail {
  promoter: number | null;
  fii: number | null;
  dii: number | null;
  government: number | null;
  public: number | null;
  others: number | null;
  shareholders: number | null;
  total_shares: number | null;
}

/** Category split from one shareholding-pattern XBRL; {} when it has no percentages. Throws XbrlParseError. */
export function parseXbrl(xml: string | Uint8Array): ShareholdingDetail | Record<string, never> {
  const els = readXml(xml);
  // Context id -> its single dimension member (null for multi-dimension contexts). ElementTree's
  // `e.get("id")` is None for a context without an id, and elements without contextRef look that key up too.
  const contexts = new Map<string | null, string | null>();
  const members = new Map<number, string[]>();
  els.forEach((el, i) => {
    if (el.name === "context") members.set(i, []);
    if (el.name === "explicitMember" && el.text) {
      const m = pyStrip(el.text).split(":").pop()!;
      // `e.iter()` includes the context's whole subtree, so nested contexts see the member too.
      for (let p = i; p !== -1; p = els[p].parent) members.get(p)?.push(m);
    }
  });
  els.forEach((el, i) => {
    if (el.name !== "context") return;
    const list = members.get(i)!;
    contexts.set(el.attrs.get("id") ?? null, list.length === 1 ? list[0] : null);
  });

  const pct = new Map<string, number>();
  const holders = new Map<string, number>();
  const shares = new Map<string, number>();
  for (const el of els) {
    const ctx = el.attrs.get("contextRef") ?? null;
    const member = contexts.get(ctx) ?? null;
    const col = MEMBERS.get(member || "");
    const text = elText(el);
    if (!col || !NUM.test(text)) continue;
    if (el.name === "ShareholdingAsAPercentageOfTotalNumberOfShares") {
      if (!pct.has(col)) pct.set(col, xbrlNumber(text));
    } else if (el.name === "NumberOfShareholders") {
      if (!holders.has(col)) holders.set(col, Math.trunc(xbrlNumber(text)));
    } else if (el.name === "NumberOfShares") {
      if (!shares.has(col)) shares.set(col, xbrlNumber(text));
    }
  }
  if (!pct.size) return {};

  // Filers disagree on units: newer documents write 71.77% as 0.7177, older ones as 71.77. The grand total
  // is 100% either way, so it tells us which; without it, any value above 1 means percent already.
  const total = pct.get("total");
  const scale = total !== undefined ? (total > 1.5 ? 1 : 100) : [...pct.values()].some((v) => v > 1) ? 1 : 100;
  for (const [k, v] of pct) pct.set(k, v * scale);
  const known = ["promoter", "fii", "dii", "government", "public"].reduce((s, k) => s + (pct.get(k) ?? 0), 0);
  return {
    promoter: pct.get("promoter") ?? null,
    fii: pct.get("fii") ?? null,
    dii: pct.get("dii") ?? null,
    government: pct.get("government") ?? null,
    public: pct.get("public") ?? null,
    // Custodians / depository receipts and anything uncategorised.
    others: known ? Math.max(0, 100 - known) : null,
    shareholders: holders.get("total") ?? null,
    total_shares: shares.get("total") ?? null,
  };
}

/**
 * Fetch every shareholding filing for one company and parse its detail.
 *
 * `maxQuarters` limits XBRL parsing to the most recent filings (the bulk run uses it so every company gets
 * current data before anyone's history). Rows parsed before share counts were extracted are read again.
 */
export async function syncSymbol(
  client: NSEClient, db: Db, symbol: string,
  opts: { maxQuarters?: number | null; progress?: (done: number, total: number) => void } = {},
): Promise<number> {
  ensureSchema(db);
  const payload = await client.api<unknown>(MASTER, { index: "equities", symbol });
  let rows: Row[];
  if (Array.isArray(payload)) rows = payload;
  else if (payload && typeof payload === "object") rows = ((payload as Row).data || []) as Row[];
  else if (payload) throw new TypeError(`unexpected ${MASTER} payload for ${symbol}`);
  else rows = [];
  const ts = now();

  const summary: Row[] = [];
  const xbrl = new Map<Row, unknown>();
  for (const r of rows) {
    if (textOf(r.symbol).toUpperCase() !== symbol.toUpperCase()) continue;
    const s: Row = {
      symbol, as_of_date: parseDate(r.date),
      company: textOrNull(r.name),
      isin: textOrNull(r.isin),
      promoter: pyFloatLoose(r.pr_and_prgrp), public: pyFloatLoose(r.public_val),
      emp_trusts: pyFloatLoose(r.employeeTrusts),
      broadcast_dt: textOrNull(r.broadcastDate),
      raw: pyJsonDumps(r), fetched_at: ts,
    };
    summary.push(s);
    xbrl.set(s, r.xbrl); // what json.loads(raw).get("xbrl") gives back
  }
  if (summary.length) db.upsert("nse_shareholding", summary);

  const done = new Set(db.all<{ as_of_date: string }>(
    "SELECT as_of_date FROM nse_shareholding_detail WHERE symbol = ? "
    + "AND (status = 'nodata' OR (status = 'ok' AND total_shares IS NOT NULL))", [symbol]).map((r) => r.as_of_date));
  // Newest first; Array.sort is stable like Python's sorted(reverse=True).
  let recent = [...summary].sort((a, b) => (a.as_of_date < b.as_of_date ? 1 : a.as_of_date > b.as_of_date ? -1 : 0));
  if (opts.maxQuarters) recent = recent.slice(0, opts.maxQuarters);
  const todo = recent.filter((s) => !done.has(s.as_of_date));

  let written = 0;
  for (let i = 1; i <= todo.length; i++) {
    const s = todo[i - 1];
    const url = xbrl.get(s);
    let detail: Partial<ShareholdingDetail> = {};
    let status = "nodata";
    if (url) {
      try {
        detail = parseXbrl(await client.archive(String(url)));
        status = Object.keys(detail).length ? "ok" : "nodata";
      } catch (e) {
        if (!(e instanceof NotFound || e instanceof XbrlParseError)) {
          // Network: leave for a later attempt.
          log.warn(`shareholding ${symbol} ${s.as_of_date}: ${(e as Error).message}`);
          continue;
        }
      }
    }
    db.upsert("nse_shareholding_detail", [{
      symbol, as_of_date: s.as_of_date,
      // A company with no promoter group omits the category entirely.
      promoter: detail.promoter ?? s.promoter,
      fii: detail.fii ?? null,
      dii: detail.dii ?? null, government: detail.government ?? null,
      public: detail.public ?? null, others: detail.others ?? null,
      shareholders: detail.shareholders ?? null,
      total_shares: detail.total_shares ?? null, xbrl_url: url ?? null,
      status, fetched_at: now(),
    }]);
    written += 1;
    opts.progress?.(i, todo.length);
  }
  return written;
}

/**
 * Companies whose shareholding detail is missing or out of date.
 *
 * Listed equities (main board and SME) are ranked index members first, then by market cap. A company
 * counts as current when its newest summary quarter already has parsed detail with a share count, and its
 * summary was fetched within `maxAgeDays` (new quarters are filed ~21 days after quarter end).
 */
export function pendingSymbols(db: Db, limit = 50, maxAgeDays = 20): string[] {
  ensureSchema(db);
  const hasMetrics = Boolean(db.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='company_metrics'"));
  const sql = "WITH latest AS (SELECT symbol, MAX(as_of_date) d, MAX(fetched_at) f FROM nse_shareholding GROUP BY symbol), "
    + "idx AS (SELECT DISTINCT symbol FROM nse_index_constituent) "
    + "SELECT s.symbol FROM nse_symbol s "
    + "LEFT JOIN latest l ON l.symbol = s.symbol "
    + "LEFT JOIN nse_shareholding_detail d ON d.symbol = s.symbol AND d.as_of_date = l.d "
    + "LEFT JOIN idx ON idx.symbol = s.symbol "
    + (hasMetrics ? "LEFT JOIN company_metrics m ON m.symbol = s.symbol " : "")
    + "WHERE COALESCE(s.series, 'EQ') IN ('EQ','BE','BZ','SM','ST') "
    + "  AND (l.symbol IS NULL OR l.f < datetime('now', ?) "
    + "       OR d.symbol IS NULL OR (d.status = 'ok' AND d.total_shares IS NULL)) "
    // Tried in the last day (success or not): let the rest of the queue go first.
    + "  AND NOT EXISTS (SELECT 1 FROM shareholding_attempt a WHERE a.symbol = s.symbol "
    + "                  AND a.attempted_at > datetime('now', '-1 day')) "
    + "ORDER BY idx.symbol IS NULL, "
    + (hasMetrics ? "COALESCE(m.market_cap_cr, 0) DESC, " : "")
    + "s.symbol LIMIT ?";
  return db.all<{ symbol: string }>(sql, [`-${Math.trunc(maxAgeDays)} days`, limit]).map((r) => r.symbol);
}

/** Bring the shareholding of the next `limit` stale companies (or the given `symbols`) up to date. */
export async function syncMany(client: NSEClient, db: Db, opts: { limit?: number; symbols?: string[]; maxQuarters?: number } = {}): Promise<number> {
  const { limit = 50, maxQuarters = 8 } = opts;
  let written = 0;
  let failures = 0;
  for (const symbol of opts.symbols ?? pendingSymbols(db, limit)) {
    let outcome = "ok";
    try {
      try {
        written += await syncSymbol(client, db, symbol, { maxQuarters });
      } catch {
        // NSE session cookies expire after a while; a long-running worker then fails every call. Start a fresh session once.
        client.jar.clear();
        await client.warmup(true);
        written += await syncSymbol(client, db, symbol, { maxQuarters });
      }
      failures = 0;
    } catch (e) {
      outcome = `error: ${String((e as Error)?.message ?? e).slice(0, 200)}`;
      failures += 1;
      log.warn(`shareholding ${symbol}: ${(e as Error)?.message ?? e}`);
    }
    // Recorded either way, so one broken company cannot block the queue.
    db.run("INSERT INTO shareholding_attempt (symbol, attempted_at, outcome) VALUES (?, datetime('now'), ?) "
      + "ON CONFLICT(symbol) DO UPDATE SET attempted_at = excluded.attempted_at, outcome = excluded.outcome", [symbol, outcome]);
    if (failures >= 3) {
      // The endpoint is refusing us (rate limit or outage): stop for this round instead of stalling filing parsing.
      log.warn(`shareholding: ${failures} failures in a row, pausing until the next round`);
      break;
    }
  }
  return written;
}
