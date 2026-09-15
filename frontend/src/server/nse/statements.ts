// Balance sheets and cash flow statements from NSE result XBRL.
//
// Half-yearly (September) and annual (March) result filings carry the statement of assets and liabilities
// and the cash flow statement next to the profit and loss figures. Companies file in the Ind-AS corporate
// taxonomy and banks in the banking taxonomy, so each statement has one line map per format.
//
// Contexts: `OneI` is the balance-sheet date (instant); `FourD` is the year-to-date period, so a September
// cash flow covers six months and a March one the full fiscal year.
//
// Values are stored in rupees, as filed. Nothing is derived except free cash flow (operating cash flow
// minus capital expenditure).
import { config } from "../config";
import { now, type Db, type Row } from "../db";
import { NotFound } from "../http";
import { logger } from "../log";
import { mapPool } from "../util";
import type { NSEClient } from "./client";
import { elText, NUM, readXml, XbrlParseError, xbrlNumber } from "./fundamentals";
import { pyFloatRepr } from "./py";
import { BALANCE_SHEET, CASH_FLOW, OUTFLOWS, STATEMENT_SCHEMA, type LineDef } from "./statementDefs";

export { BALANCE_SHEET, CASH_FLOW, DERIVED, OUTFLOWS } from "./statementDefs";

const log = logger("nse.statements");

export const RECENT_FILINGS = 12; // six half-year filings, consolidated + standalone

export function ensureSchema(db: Db) {
  db.exec(STATEMENT_SCHEMA);
}

export type Lines = Record<string, number>;

export interface ParsedStatements {
  format: "corporate" | "bank" | null;
  balance_sheet: Lines | null;
  cash_flow: Lines | null;
  months?: number | null;
}

const DAY_MS = 86_400_000;

/** Days-since-epoch of a proleptic Gregorian date (Date.UTC alone maps years 0-99 to 19xx). */
function utcDay(y: number, m: number, d: number): number | null {
  if (y < 1 || m < 1 || m > 12 || d < 1) return null;
  const dt = new Date(0);
  dt.setUTCFullYear(y, m - 1, d);
  return dt.getUTCDate() === d ? dt.getTime() / DAY_MS : null;
}

/** Python 3.12 date.fromisoformat (YYYY-MM-DD, YYYYMMDD, YYYY-Www[-D], YYYYWww[D]) as a day number; null where it raises. */
function fromIsoFormat(s: string | null): number | null {
  if (s === null) return null;
  let m = /^([0-9]{4})(-?)([0-9]{2})\2([0-9]{2})$/.exec(s);
  if (m) return utcDay(+m[1], +m[3], +m[4]);
  m = /^([0-9]{4})(-?)W([0-9]{2})(?:\2([0-9]))?$/.exec(s);
  if (!m) return null;
  const y = +m[1], week = +m[3], day = m[4] === undefined ? 1 : +m[4];
  const jan1 = utcDay(y, 1, 1);
  if (jan1 === null || week < 1 || week > 53 || day < 1 || day > 7) return null;
  const firstWeekday = (((jan1 + 3) % 7) + 7) % 7; // 0 = Monday; 1970-01-01 was a Thursday
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  if (week === 53 && !(firstWeekday === 3 || (firstWeekday === 2 && leap))) return null;
  // Monday of ISO week 1 is the Monday on or before 4 January.
  const week1 = jan1 + 3 - ((firstWeekday + 3) % 7);
  return week1 + (week - 1) * 7 + day - 1;
}

/** Statements in one filing. Throws XbrlParseError on malformed XML. */
export function parse(xml: string | Uint8Array): ParsedStatements {
  const facts: Record<"OneI" | "FourD", Map<string, number>> = { OneI: new Map(), FourD: new Map() };
  let start: string | null = null;
  let end: string | null = null;
  for (const el of readXml(xml)) {
    const ctx = el.attrs.get("contextRef");
    const text = elText(el);
    if (ctx === "FourD" && el.name === "DateOfStartOfReportingPeriod") start = text;
    if (ctx === "FourD" && el.name === "DateOfEndOfReportingPeriod") end = text;
    if ((ctx === "OneI" || ctx === "FourD") && NUM.test(text)) facts[ctx].set(el.name, xbrlNumber(text));
  }

  const instant = facts.OneI, period = facts.FourD;
  const fmt = instant.has("Deposits") || period.has("ExpenditureExcludingProvisionsAndContingencies") || period.has("InterestEarned")
    ? "bank" : "corporate";

  const pick = (source: Map<string, number>, lines: LineDef[]): Lines => {
    const out: Lines = {};
    for (const [key, , tags] of lines) {
      const tag = tags.find((t) => source.has(t));
      if (tag) out[key] = source.get(tag)!;
    }
    return out;
  };

  let bs = pick(instant, BALANCE_SHEET[fmt]);
  // A balance sheet needs its total; stray instant facts (share counts) are not one.
  if (!("total_assets" in bs)) bs = {};
  const cfSource = new Map(period);
  if (instant.has("CashAndCashEquivalentsCashFlowStatement")) {
    cfSource.set("CashAndCashEquivalentsCashFlowStatement", instant.get("CashAndCashEquivalentsCashFlowStatement")!);
  }
  let cf = pick(cfSource, CASH_FLOW);
  if (!["cfo", "cfi", "cff"].some((k) => k in cf)) cf = {};
  for (const k of OUTFLOWS) {
    if (k in cf) cf[k] = cf[k] ? -Math.abs(cf[k]) : 0; // never store a negative zero
  }
  // Free cash flow is not meaningful for banks (operating cash includes deposit flows).
  if (fmt === "corporate" && "cfo" in cf && "capex" in cf) cf.fcf = cf.cfo + cf.capex;

  let months: number | null = null;
  const a = fromIsoFormat(start), b = fromIsoFormat(end);
  // round() halves to even in Python, but n / 30.44 is never exactly k + 0.5 for an integer day count.
  if (a !== null && b !== null) months = Math.round((b - a + 1) / 30.44);
  return {
    format: fmt,
    balance_sheet: Object.keys(bs).length ? bs : null,
    cash_flow: Object.keys(cf).length ? cf : null,
    months,
  };
}

/** json.dumps(lines) with Python's default separators; every value is a float. */
export const linesJson = (lines: Lines) =>
  `{${Object.entries(lines).map(([k, v]) => `${JSON.stringify(k)}: ${pyFloatRepr(v, false)}`).join(", ")}}`;

/** nse_statement rows for one parsed filing (a 'none' marker when it has neither statement). */
export function rowsFor(filing: Row, parsed: ParsedStatements): Row[] {
  const base = {
    symbol: filing.symbol, period_end: filing.period_end, consolidated: filing.consolidated,
    report_format: parsed.format ?? null, xbrl_url: filing.xbrl_url, fetched_at: now(),
  };
  const out: Row[] = [];
  if (parsed.balance_sheet && Object.keys(parsed.balance_sheet).length) {
    out.push({ ...base, kind: "balance_sheet", months: null, data: linesJson(parsed.balance_sheet) });
  }
  if (parsed.cash_flow && Object.keys(parsed.cash_flow).length) {
    out.push({ ...base, kind: "cash_flow", months: parsed.months ?? null, data: linesJson(parsed.cash_flow) });
  }
  if (!out.length) out.push({ ...base, kind: "none", months: null, data: null });
  return out;
}

/** Half-yearly and annual filings not yet read for statements, newest first per company. */
export function pending(db: Db, opts: { limit?: number | null; symbol?: string } = {}): Row[] {
  ensureSchema(db);
  const hasMetrics = db.hasTable("company_metrics");
  const where = ["r.xbrl_url IS NOT NULL", "r.xbrl_url != ''", "substr(r.period_end, 6, 2) IN ('03', '09')"];
  const args: (string | number)[] = [];
  if (opts.symbol) {
    where.push("r.symbol = ?");
    args.push(opts.symbol);
  }
  let sql = "WITH ranked AS (SELECT r.symbol, r.period_end, r.consolidated, r.xbrl_url, "
    + "  ROW_NUMBER() OVER (PARTITION BY r.symbol ORDER BY r.period_end DESC, r.consolidated) rn "
    + "  FROM nse_financial_result r WHERE " + where.join(" AND ") + "), "
    + "done AS (SELECT DISTINCT symbol, period_end, consolidated FROM nse_statement), "
    + "idx AS (SELECT DISTINCT symbol FROM nse_index_constituent) "
    + "SELECT t.* FROM ranked t "
    + "LEFT JOIN done d ON d.symbol = t.symbol AND d.period_end = t.period_end AND d.consolidated = t.consolidated "
    + "LEFT JOIN idx ON idx.symbol = t.symbol "
    + (hasMetrics ? "LEFT JOIN company_metrics m ON m.symbol = t.symbol " : "")
    + "WHERE d.symbol IS NULL "
    + "ORDER BY (t.rn > ?) ASC, idx.symbol IS NULL, "
    + (hasMetrics ? "COALESCE(m.market_cap_cr, 0) DESC, " : "")
    + "t.symbol, t.period_end DESC";
  args.push(RECENT_FILINGS);
  if (opts.limit) sql += ` LIMIT ${Math.trunc(opts.limit)}`;
  return db.all(sql, args);
}

/** Read statements from outstanding half-yearly/annual filings. `limit` defaults to 200; null means all. */
export async function sync(client: NSEClient, db: Db, opts: { limit?: number | null; symbol?: string; workers?: number } = {}): Promise<number> {
  const todo = pending(db, { limit: opts.limit === undefined ? 200 : opts.limit, symbol: opts.symbol });
  if (!todo.length) return 0;

  let written = 0;
  let batch: Row[] = [];
  await mapPool(todo, Math.max(1, opts.workers || config.FUNDAMENTALS_WORKERS), async (row) => {
    let parsed: ParsedStatements;
    try {
      parsed = parse(await client.archive(row.xbrl_url));
    } catch (e) {
      if (e instanceof NotFound || e instanceof XbrlParseError) {
        parsed = { format: null, balance_sheet: null, cash_flow: null };
      } else { // network: retry in a later round
        log.warn(`statements ${row.symbol} ${row.period_end}: ${(e as Error).message}`);
        return;
      }
    }
    batch.push(...rowsFor(row, parsed));
    if (batch.length >= 50) {
      written += db.upsert("nse_statement", batch);
      batch = [];
    }
  });
  if (batch.length) written += db.upsert("nse_statement", batch);
  log.info(`statements -> ${written} rows from ${todo.length} filings`);
  return written;
}
