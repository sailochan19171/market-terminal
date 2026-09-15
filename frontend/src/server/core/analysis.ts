// Per-company analysis: one normalised model for dashboards and stored versions.
//
// build(db, "TCS"), build(db, "TCS", { exchange: "BSE" }), build(db, "TCS", { asOf: "2025-09-01" }).
// A point-in-time build only uses prices up to that session and filings broadcast by then. Every metric is a
// real figure derived from filings and prices, or null with a reason in `reasons`. Nothing is estimated.
// Stored analyses ("versions") are zlib-compressed snapshots of build() in analysis_version; never overwritten.
import crypto from "node:crypto";
import zlib from "node:zlib";
import { now, type Db, type Row } from "../db";
import { logger } from "../log";
import { BALANCE_SHEET, CASH_FLOW, DERIVED, STATEMENT_SCHEMA } from "../nse/statementDefs";
import { addDays, cagr, grouped, localIsoNow, normDateTime, parseIso, pctChange, todayIso } from "../util";
import { Adjuster, loadEvents, parseFactor, TOLERANCE, type Event } from "./adjust";
import { annual, CR, dividendAmount, pickBasis, quarterRow, ttm } from "./metrics";

const log = logger("core.analysis");

export const SNAPSHOT_SCHEMA = 1;
const EQUITY_SERIES = ["EQ", "BE", "BZ", "SM", "ST"];
const DELAYED_AFTER_DAYS = 4;

export const VERSION_SCHEMA = `
CREATE TABLE IF NOT EXISTS analysis_version (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    company_key        TEXT NOT NULL,
    symbol             TEXT,
    bse_code           TEXT,
    company            TEXT,
    exchange           TEXT NOT NULL,
    analysis_date      TEXT NOT NULL,
    version            INTEGER NOT NULL,
    status             TEXT NOT NULL,
    kind               TEXT NOT NULL,
    data_from          TEXT,
    data_to            TEXT,
    results_as_of      TEXT,
    shareholding_as_of TEXT,
    summary            TEXT,
    content_hash       TEXT,
    snapshot           BLOB,
    error              TEXT,
    created_at         TEXT NOT NULL,
    updated_at         TEXT NOT NULL,
    UNIQUE (company_key, version)
);
CREATE INDEX IF NOT EXISTS ix_av_company ON analysis_version(company_key, analysis_date);
CREATE INDEX IF NOT EXISTS ix_av_created ON analysis_version(created_at);
CREATE INDEX IF NOT EXISTS ix_av_date ON analysis_version(analysis_date);
`;

export class NotFoundError extends Error {}

const cr = (v: number | null | undefined) => (v == null ? null : v / CR);
const f0 = (v: number) => v.toFixed(0);
const f1 = (v: number) => v.toFixed(1);
const f2 = (v: number) => v.toFixed(2);

export type Exchange = "NSE" | "BSE";
export interface Identity {
  key: string; symbol: string | null; bseCode: string | null; bseTicker: string | null; isin: string | null;
  company: string | null; industry: string | null; indices: string[]; series: string | null; faceValue: number | null;
  listingDate: string | null; exchanges: Record<Exchange, boolean>; instrumentType: string; limited: boolean;
  _bseMarketCap: [number | null, string | null];
}

// --- identity ---------------------------------------------------------------------------
export function instrumentType(symbol: string, series: string | null | undefined): string {
  const s = (series ?? "").toUpperCase();
  if (symbol.endsWith("-RE")) return "Rights entitlement";
  if (s === "EQ" || !s) return "Equity";
  if (s === "BE" || s === "BZ") return "Equity (trade-for-trade)";
  if (s === "SM" || s === "ST") return "SME equity";
  if (["GS", "GB", "TB"].includes(s)) return "Government security";
  if (s === "SG") return "Sovereign gold bond";
  if (s === "IV" || s === "RR") return "REIT / InvIT";
  if ("NYZEDMP".includes(s[0])) return "Bond / debenture";
  return "Listed instrument";
}

/** Map an NSE symbol, BSE scrip code, BSE ticker or ISIN to one company. Throws NotFoundError. */
export function resolve(db: Db, ident: string): Identity {
  const q = (ident ?? "").trim().toUpperCase();
  if (!q) throw new NotFoundError(ident);
  const nseSql = "SELECT symbol, company, isin, series, face_value, listing_date FROM nse_symbol";
  const scripSql = "SELECT scrip_cd, scrip_id, scrip_name, isin, face_value, industry, status, market_cap, updated_at FROM scrip";
  let nse: Row | undefined = db.get(`${nseSql} WHERE UPPER(symbol) = ?`, [q]);
  let scrip: Row | undefined;
  if (!nse) {
    scrip = db.get(`${scripSql} WHERE scrip_cd = ? OR UPPER(scrip_id) = ? OR isin = ? ORDER BY (status = 'Active') DESC LIMIT 1`, [q, q, q]);
    if (scrip?.isin) nse = db.get(`${nseSql} WHERE isin = ?`, [scrip.isin]);
    if (!nse && !scrip) nse = db.get(`${nseSql} WHERE isin = ?`, [q]);
  }
  if (nse && !scrip && nse.isin) scrip = db.get(`${scripSql} WHERE isin = ? ORDER BY (status = 'Active') DESC LIMIT 1`, [nse.isin]);

  let nseTrades = false;
  if (nse) nseTrades = Boolean(db.get("SELECT 1 FROM nse_bhavcopy WHERE symbol = ? LIMIT 1", [nse.symbol]));
  else if (db.get("SELECT 1 FROM nse_bhavcopy WHERE symbol = ? LIMIT 1", [q])) {
    // Listed instrument with prices but no master row (bonds, G-secs...).
    nse = { symbol: q, company: null, isin: null, series: null, face_value: null, listing_date: null };
    nseTrades = true;
  }
  const bseTrades = Boolean(scrip && db.get("SELECT 1 FROM bhavcopy WHERE scrip_cd = ? LIMIT 1", [scrip.scrip_cd]));
  if (!nse && !scrip) throw new NotFoundError(ident);

  const symbol: string | null = nse ? nse.symbol : null;
  const series: string | null = (nse?.series || null)
    ?? (symbol ? db.scalar<string>("SELECT series FROM nse_bhavcopy WHERE symbol = ? ORDER BY trade_date DESC LIMIT 1", [symbol]) : null);
  let industry: string | null = null;
  const indices: string[] = [];
  if (symbol) {
    for (const r of db.all("SELECT index_symbol, industry FROM nse_index_constituent WHERE symbol = ? ORDER BY index_symbol", [symbol])) {
      indices.push(r.index_symbol);
      industry = industry || r.industry;
    }
  }
  industry = industry || scrip?.industry || null;
  return {
    key: symbol ?? scrip!.scrip_cd,
    symbol,
    bseCode: scrip?.scrip_cd ?? null,
    bseTicker: scrip?.scrip_id ?? null,
    isin: nse?.isin || scrip?.isin || null,
    company: nse?.company || scrip?.scrip_name || symbol,
    industry,
    indices,
    series,
    faceValue: nse?.face_value || scrip?.face_value || null,
    listingDate: nse?.listing_date ?? null,
    exchanges: { NSE: nseTrades, BSE: bseTrades },
    instrumentType: symbol ? instrumentType(symbol, series) : "Equity",
    limited: Boolean(symbol) && !EQUITY_SERIES.includes(series || "EQ"),
    _bseMarketCap: scrip ? [scrip.market_cap ?? null, scrip.updated_at ?? null] : [null, null],
  };
}

export function pickExchange(identity: Identity, requested?: string | null): Exchange {
  const req = (requested ?? "").toUpperCase();
  if ((req === "NSE" || req === "BSE") && identity.exchanges[req]) return req;
  return identity.exchanges.NSE ? "NSE" : "BSE";
}

// --- prices -------------------------------------------------------------------------------
function bseEvents(db: Db, scripCd: string): Event[] {
  const byDate = new Map<string, Map<string, number>>();
  for (const r of db.all("SELECT purpose, ex_date FROM corp_action WHERE scrip_cd = ? AND ex_date != '' AND (purpose LIKE '%split%' OR purpose LIKE '%sub-division%' OR purpose LIKE '%bonus%')", [scripCd])) {
    const f = parseFactor(r.purpose);
    if (!f) continue;
    const d = String(r.ex_date).slice(0, 10);
    const parts = byDate.get(d) ?? new Map();
    parts.set(r.purpose.trim().toLowerCase(), f);
    byDate.set(d, parts);
  }
  const out: Event[] = [];
  for (const [exDate, parts] of byDate) {
    let f = 1;
    for (const v of parts.values()) f *= v;
    const before = db.get("SELECT close FROM bhavcopy WHERE scrip_cd = ? AND trade_date < ? ORDER BY trade_date DESC LIMIT 1", [scripCd, exDate]);
    const after = db.get("SELECT close FROM bhavcopy WHERE scrip_cd = ? AND trade_date >= ? ORDER BY trade_date LIMIT 1", [scripCd, exDate]);
    if (before && after && before.close && Math.abs(after.close / before.close / f - 1) > TOLERANCE) continue;
    out.push([exDate, f]);
  }
  return out.sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

export function eventsFor(db: Db, identity: Identity): Event[] {
  if (identity.symbol) return loadEvents(db, identity.symbol).get(identity.symbol) ?? [];
  if (identity.bseCode) return bseEvents(db, identity.bseCode);
  return [];
}

/** Only corporate actions that had happened by `asOf` are applied. */
export function adjuster(db: Db, identity: Identity, asOf?: string | null): Adjuster {
  let ev = eventsFor(db, identity);
  if (asOf) ev = ev.filter((e) => e[0] <= asOf);
  return new Adjuster(ev);
}

export const latestSession = (db: Db, exchange: Exchange) =>
  db.scalar<string>(`SELECT MAX(trade_date) FROM ${exchange === "NSE" ? "nse_bhavcopy" : "bhavcopy"}`);

export interface Bar { t: string; o: number | null; h: number | null; l: number | null; c: number; v: number | null; pc: number | null }

/** Adjusted daily bars for one exchange, oldest first. */
export function priceRows(db: Db, identity: Identity, exchange: Exchange, start?: string | null, end?: string | null, adj?: Adjuster): Bar[] {
  const where: string[] = [];
  const args: (string | number)[] = [];
  let sql: string;
  if (exchange === "NSE") {
    if (!identity.symbol) return [];
    const series = identity.series;
    if (!series || EQUITY_SERIES.includes(series)) where.push("series IN ('EQ','BE','BZ','SM','ST')");
    else {
      where.push("series = ?");
      args.push(series);
    }
    sql = "SELECT trade_date t, open o, high h, low l, close c, volume v, prev_close pc FROM nse_bhavcopy WHERE symbol = ? AND ";
    args.unshift(identity.symbol);
  } else {
    if (!identity.bseCode) return [];
    sql = "SELECT trade_date t, open o, high h, low l, close c, volume v, prev_close pc FROM bhavcopy WHERE scrip_cd = ? AND ";
    args.unshift(identity.bseCode);
    where.push("1=1");
  }
  if (start) { where.push("trade_date >= ?"); args.push(start); }
  if (end) { where.push("trade_date <= ?"); args.push(end); }
  const seen = new Set<string>();
  const out: Bar[] = [];
  for (const r of db.all(`${sql}${where.join(" AND ")} ORDER BY trade_date`, args)) {
    if (seen.has(r.t) || r.c === null) continue;
    seen.add(r.t);
    const bar: Bar = { t: r.t, o: r.o, h: r.h, l: r.l, c: r.c, v: r.v, pc: r.pc };
    if (adj) {
      const f = adj.factor(bar.t);
      if (f !== 1) {
        for (const k of ["o", "h", "l", "c", "pc"] as const) if (bar[k] !== null) (bar[k] as number) *= f;
        if (bar.v !== null) bar.v /= f;
      }
    }
    out.push(bar);
  }
  return out;
}

const RETURN_WINDOWS: [string, number][] = [["1W", 7], ["1M", 30], ["3M", 91], ["6M", 182], ["1Y", 365], ["3Y", 1095], ["5Y", 1826]];

function quoteAndReturns(bars: Bar[], exchange: Exchange) {
  if (!bars.length) return { quote: null as Row | null, returns: {} as Record<string, number | null>, reasons: {} as Record<string, string> };
  const last = bars[bars.length - 1];
  const prev = bars.length > 1 ? bars[bars.length - 2].c : last.pc;
  const change = prev ? last.c - prev : null;
  const quote: Row = {
    exchange, session: last.t, open: last.o, high: last.h, low: last.l, close: last.c, prevClose: prev, change,
    changePct: change !== null && prev ? (change / prev) * 100 : null, volume: last.v,
  };
  const yearStart = addDays(last.t, -365);
  const year = bars.filter((b) => b.t >= yearStart);
  const highs = year.map((b) => b.h).filter((x): x is number => x !== null);
  const lows = year.map((b) => b.l).filter((x): x is number => x !== null);
  quote.high52w = highs.length ? Math.max(...highs) : null;
  quote.low52w = lows.length ? Math.min(...lows) : null;
  quote.fromHigh = pctChange(last.c, quote.high52w);
  quote.fromLow = pctChange(last.c, quote.low52w);
  const returns: Record<string, number | null> = {};
  const reasons: Record<string, string> = {};
  for (const [label, days] of RETURN_WINDOWS) {
    const target = addDays(last.t, -days);
    let lo = 0, hi = bars.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (bars[mid].t <= target) lo = mid + 1;
      else hi = mid;
    }
    const i = lo - 1;
    if (i < 0) {
      returns[label] = null;
      reasons[label] = `${exchange} price history on file starts ${bars[0].t}`;
    } else returns[label] = pctChange(last.c, bars[i].c);
  }
  return { quote, returns, reasons };
}

// --- filings -------------------------------------------------------------------------------------
function fundamentalRows(db: Db, symbol: string, asOf: string | null): Row[] {
  let sql = "SELECT f.*, r.broadcast_dt AS filed_at FROM nse_fundamental f LEFT JOIN nse_financial_result r ON r.symbol = f.symbol AND r.period_end = f.period_end AND r.consolidated = f.consolidated WHERE f.symbol = ? AND f.period_end != '' AND f.quality IN ('ok', 'suspect') ";
  const args: string[] = [symbol];
  if (asOf) {
    sql += "AND f.period_end <= ? AND (r.broadcast_dt IS NULL OR r.broadcast_dt <= ?) ";
    args.push(asOf, `${asOf}T23:59:59`);
  }
  return db.all(`${sql}ORDER BY f.period_end`, args).map((r) => ({ ...r }));
}

export function quarterLine(q: Row, adj: Adjuster): Row {
  const row = quarterRow(q);
  const f = adj.factor(q.period_end);
  const rev = q.revenue;
  Object.assign(row, {
    gross_profit: cr(q.gross_profit),
    gpm: q.gross_profit != null && rev ? (q.gross_profit / rev) * 100 : null,
    npm: q.pat != null && rev ? (q.pat / rev) * 100 : null,
    eps: q.eps_basic == null ? null : q.eps_basic * f,
    eps_reported: q.eps_basic ?? null,
    shares: !q.shares ? null : q.shares / f,
    filed_at: q.filed_at ?? null,
  });
  return row;
}

function sumKey(lines: Row[], key: string): number | null {
  const vals = lines.map((l) => l[key]);
  return !vals.length || vals.some((v) => v == null) ? null : vals.reduce((a, b) => a + b, 0);
}

export function summarise(label: string, lines: Row[], quarters: Row[]): Row {
  const sales = sumKey(lines, "sales"), op = sumKey(lines, "operating_profit"), pbt = sumKey(lines, "pbt"), np = sumKey(lines, "net_profit");
  const taxes = quarters.map((q) => q.tax);
  const tax = taxes.some((t) => t == null) ? null : taxes.reduce((a, b) => a + b, 0) / CR;
  const gp = sumKey(lines, "gross_profit");
  return {
    label, sales, expenses: sumKey(lines, "expenses"), operating_profit: op,
    opm: op !== null && sales ? (op / sales) * 100 : null,
    gross_profit: gp, gpm: gp !== null && sales ? (gp / sales) * 100 : null,
    other_income: sumKey(lines, "other_income"), interest: sumKey(lines, "interest"), depreciation: sumKey(lines, "depreciation"), pbt,
    tax_pct: tax !== null && pbt ? (tax / pbt) * 100 : null,
    net_profit: np, npm: np !== null && sales ? (np / sales) * 100 : null,
    eps: sumKey(lines, "eps"),
  };
}

export function ensureStatementSchema(db: Db) {
  db.exec(STATEMENT_SCHEMA);
}

/** Balance sheets and cash flows filed by `cutoff`, one per period, on the chosen basis. */
export function statements(db: Db, symbol: string | null, basis: string | null, cutoff: string | null, limit = 10) {
  const empty = { format: null as string | null, balanceSheet: { lines: [] as Row[], periods: [] as Row[] }, cashFlow: { lines: [] as Row[], periods: [] as Row[] } };
  if (!symbol) return empty;
  ensureStatementSchema(db);
  let sql = "SELECT s.period_end, s.consolidated, s.kind, s.months, s.report_format, s.data, s.xbrl_url, r.broadcast_dt FROM nse_statement s LEFT JOIN nse_financial_result r ON r.symbol = s.symbol AND r.period_end = s.period_end AND r.consolidated = s.consolidated WHERE s.symbol = ? AND s.kind IN ('balance_sheet', 'cash_flow') ";
  const args: string[] = [symbol];
  if (cutoff) {
    sql += "AND s.period_end <= ? AND (r.broadcast_dt IS NULL OR r.broadcast_dt <= ?) ";
    args.push(cutoff, `${cutoff}T23:59:59`);
  }
  const pref = (basis || "consolidated") === "consolidated" ? "consolidated" : "standalone";
  const chosen = new Map<string, Row>();
  let fmt: string | null = null;
  for (const r of db.all(`${sql}ORDER BY s.period_end`, args)) {
    const key = `${r.kind}|${r.period_end}`;
    const isPref = String(r.consolidated).toLowerCase().startsWith(pref.slice(0, 5));
    if (chosen.has(key) && !isPref) continue;
    chosen.set(key, r);
    fmt = r.report_format || fmt;
  }
  const block = (kind: string, lines: typeof CASH_FLOW) => {
    let periods: Row[] = [];
    for (const [key, r] of [...chosen.entries()].sort((a, b) => (a[0].split("|")[1] < b[0].split("|")[1] ? -1 : 1))) {
      if (key.split("|")[0] !== kind) continue;
      const values: Record<string, number> = {};
      for (const [k, v] of Object.entries(JSON.parse(r.data || "{}") as Record<string, number | null>)) if (v !== null) values[k] = v / CR;
      periods.push({ periodEnd: r.period_end, basis: r.consolidated, months: r.months, values, filedAt: r.broadcast_dt, xbrl_url: r.xbrl_url });
    }
    periods = periods.slice(-limit);
    const present = new Set(periods.flatMap((p) => Object.keys(p.values)));
    return {
      lines: [
        ...lines.filter(([k]) => present.has(k)).map(([key, label, , level]) => ({ key, label, level })),
        ...(kind === "cash_flow" && present.has("fcf") ? [{ key: "fcf", label: DERIVED.fcf, level: 0 }] : []),
      ],
      periods,
    };
  };
  return {
    format: fmt,
    balanceSheet: block("balance_sheet", BALANCE_SHEET[(fmt as "bank" | "corporate") || "corporate"] ?? []),
    cashFlow: block("cash_flow", CASH_FLOW),
  };
}

// --- the model ---------------------------------------------------------------------------------------
export interface BuildOptions { exchange?: string | null; asOf?: string | null; basis?: string; peers?: boolean }

export function build(db: Db, ident: string | Identity, opts: BuildOptions = {}): Row {
  const identity = typeof ident === "string" ? resolve(db, ident) : ident;
  const exchange = pickExchange(identity, opts.exchange);
  const { symbol, bseCode } = identity;
  const newest = latestSession(db, exchange);
  let asOf = opts.asOf ?? null;
  if (asOf && newest && asOf >= newest) asOf = null; // "as of today" is simply the latest data
  const cutoff = asOf;
  const reasons: Record<string, string | null | undefined> = {};
  const sources: Record<string, string | null> = {};
  const adj = adjuster(db, identity, cutoff);

  const start = newest ? addDays(cutoff || newest, -1830) : null;
  const bars = priceRows(db, identity, exchange, start, cutoff, adj);
  const { quote, returns, reasons: returnReasons } = quoteAndReturns(bars, exchange);
  const close: number | null = quote ? quote.close : null;
  if (!quote) reasons.price = `No ${exchange} prices on file${cutoff ? ` on or before ${cutoff}` : ""}.`;

  const raw = symbol ? fundamentalRows(db, symbol, cutoff) : [];
  const okRows = raw.filter((r) => r.quality === "ok");
  const [used, available, chosen] = pickBasis(okRows, opts.basis ?? "auto");
  const lines = chosen.map((q) => quarterLine(q, adj));

  let pending = 0;
  if (symbol && !cutoff) {
    pending = db.scalar<number>("SELECT COUNT(*) FROM nse_financial_result r LEFT JOIN nse_fundamental f ON f.symbol = r.symbol AND f.period_end = r.period_end AND f.consolidated = r.consolidated WHERE r.symbol = ? AND r.xbrl_url IS NOT NULL AND r.xbrl_url != '' AND f.symbol IS NULL", [symbol]) ?? 0;
  }
  let noResults: string;
  if (!symbol) noResults = "Results are parsed from NSE XBRL filings; this company is listed only on BSE.";
  else if (identity.limited) noResults = `${identity.instrumentType} instruments do not file company financial results.`;
  else if (pending) noResults = `No verified results yet: ${pending} result filings for this company are queued for parsing.`;
  else if (raw.length && !okRows.length) noResults = "Result filings on file did not pass the consistency check (reported totals do not reconcile).";
  else noResults = `No quarterly result filings on file${cutoff ? ` as of ${cutoff}` : ""}.`;

  const banking = (q: Row) => (q.report_format ? q.report_format === "bank" : String(q.xbrl_url ?? "").toUpperCase().includes("BANKING"));
  const isBank = raw.length > 0 && banking(raw[raw.length - 1]);
  const last4 = ttm(chosen);
  const ttmRow = last4 ? summarise("TTM", last4.map((q) => quarterLine(q, adj)), last4) : null;
  const prev4 = chosen.length >= 8 ? ttm(chosen.slice(0, -4)) : null;
  const prevTtm = prev4 ? summarise("Prior TTM", prev4.map((q) => quarterLine(q, adj)), prev4) : null;
  const years = annual(chosen).map((y) => summarise(`Mar ${y.fy}`, y.quarters.map((q) => quarterLine(q, adj)), y.quarters));

  const needTtm = (key: string) => {
    if (!chosen.length) reasons[key] = noResults;
    else if (!last4) reasons[key] = `Needs four consecutive verified quarters; ${chosen.length} on file, latest ${chosen[chosen.length - 1].period_end}.`;
  };

  const m: Row = {};
  m.close = close;
  m.revenue_ttm = ttmRow ? ttmRow.sales : null;
  m.net_profit_ttm = ttmRow ? ttmRow.net_profit : null;
  m.eps_ttm = ttmRow ? ttmRow.eps : null;
  m.opm_ttm = ttmRow ? ttmRow.opm : null;
  m.npm_ttm = ttmRow ? ttmRow.npm : null;
  m.gross_profit_ttm = ttmRow ? ttmRow.gross_profit : null;
  m.gpm_ttm = ttmRow ? ttmRow.gpm : null;
  for (const k of ["revenue_ttm", "net_profit_ttm", "eps_ttm", "opm_ttm", "npm_ttm"]) {
    needTtm(k);
    if (m[k] === null && !(k in reasons)) reasons[k] = "Not reported in the last four quarterly filings.";
  }
  needTtm("gross_profit_ttm");
  if (m.gross_profit_ttm === null && !("gross_profit_ttm" in reasons)) {
    if (isBank) reasons.gross_profit_ttm = "Banks do not report cost of goods, so gross profit does not apply.";
    else if (last4 && last4.every((q) => (q.parser_version || 1) >= 3) && !last4.some((q) => q.gross_profit != null)) {
      reasons.gross_profit_ttm = "The company reports no cost of materials or goods purchased (typical of services businesses).";
    } else reasons.gross_profit_ttm = "Cost-of-goods lines are not yet extracted for all of the last four quarters.";
  }
  if (m.gpm_ttm === null) reasons.gpm_ttm = reasons.gross_profit_ttm;

  const latest = lines.length ? lines[lines.length - 1] : null;
  m.latest_quarter = latest ? latest.period_end : null;
  m.sales_qtr = latest ? latest.sales : null;
  m.net_profit_qtr = latest ? latest.net_profit : null;
  let yoy: Row | undefined;
  if (latest) {
    const target = `${parseInt(latest.period_end.slice(0, 4), 10) - 1}${latest.period_end.slice(4)}`;
    yoy = lines.find((l) => l.period_end === target);
  }
  m.sales_qtr_yoy = latest && yoy ? pctChange(latest.sales, yoy.sales) : null;
  m.profit_qtr_yoy = latest && yoy ? pctChange(latest.net_profit, yoy.net_profit) : null;
  for (const k of ["sales_qtr_yoy", "profit_qtr_yoy"]) if (m[k] === null) reasons[k] = !lines.length ? noResults : "The same quarter a year earlier is not on file.";
  m.revenue_ttm_growth = ttmRow && prevTtm ? pctChange(ttmRow.sales, prevTtm.sales) : null;
  m.profit_ttm_growth = ttmRow && prevTtm ? pctChange(ttmRow.net_profit, prevTtm.net_profit) : null;
  m.eps_ttm_growth = ttmRow && prevTtm ? pctChange(ttmRow.eps, prevTtm.eps) : null;
  for (const k of ["revenue_ttm_growth", "profit_ttm_growth", "eps_ttm_growth"]) if (m[k] === null) reasons[k] = !lines.length ? noResults : "Needs eight consecutive verified quarters.";

  const growth: Record<string, Record<string, number | null>> = { sales: {}, profit: {}, eps: {} };
  for (const n of [3, 5, 10]) {
    if (years.length > n) {
      const a = years[years.length - 1], b = years[years.length - 1 - n];
      growth.sales[`${n}Y`] = cagr(a.sales, b.sales, n);
      growth.profit[`${n}Y`] = cagr(a.net_profit, b.net_profit, n);
      growth.eps[`${n}Y`] = cagr(a.eps, b.eps, n);
    }
  }
  m.sales_cagr_3y = growth.sales["3Y"] ?? null;
  m.profit_cagr_3y = growth.profit["3Y"] ?? null;
  for (const k of ["sales_cagr_3y", "profit_cagr_3y"]) if (m[k] === null) reasons[k] = !lines.length ? noResults : `Needs four complete fiscal years; ${years.length} on file.`;

  if (m.eps_ttm !== null && close) {
    if (m.eps_ttm > 0) m.pe = close / m.eps_ttm;
    else {
      m.pe = null;
      reasons.pe = "Trailing twelve-month earnings are negative, so P/E is not meaningful.";
    }
  } else {
    m.pe = null;
    reasons.pe = reasons.price || reasons.eps_ttm || noResults;
  }

  // Shares outstanding: shareholding pattern first (exact count), then the results filing.
  let shares: Row | null = null;
  if (symbol) {
    const shRows = db.all(`SELECT d.as_of_date, d.total_shares, s.broadcast_dt FROM nse_shareholding_detail d LEFT JOIN nse_shareholding s ON s.symbol = d.symbol AND s.as_of_date = d.as_of_date WHERE d.symbol = ? AND d.total_shares IS NOT NULL ${cutoff ? "AND d.as_of_date <= ? " : ""}ORDER BY d.as_of_date DESC`, cutoff ? [symbol, cutoff] : [symbol]);
    for (const r of shRows) {
      const filed = normDateTime(r.broadcast_dt);
      if (cutoff && filed && filed.slice(0, 10) > cutoff) continue;
      shares = { value: r.total_shares / adj.factor(r.as_of_date), asOf: r.as_of_date, source: "Shareholding pattern filed with NSE" };
      break;
    }
    if (!shares) {
      const q = [...raw].reverse().find((x) => x.shares);
      if (q) shares = { value: q.shares / adj.factor(q.period_end), asOf: q.period_end, source: "Paid-up capital / face value in the result filing" };
    }
  }
  m.shares = shares ? shares.value : null;
  if (!shares) reasons.shares = !symbol ? noResults : "No shareholding pattern or result filing with a share count on file yet.";
  sources.shares = shares ? shares.source : null;

  if (m.shares && close) {
    m.market_cap = (m.shares * close) / CR;
    sources.market_cap = `Shares outstanding x ${exchange} close`;
  } else {
    const [mc, mcAt] = identity._bseMarketCap;
    if (mc && !cutoff) {
      m.market_cap = mc;
      sources.market_cap = `Published by BSE (${String(mcAt ?? "").slice(0, 10)})`;
    } else {
      m.market_cap = null;
      reasons.market_cap = reasons.price || reasons.shares || "Needs a share count and a price.";
    }
  }

  let bal: Row | null = null;
  const candidates = raw.filter((r) => r.equity != null);
  if (candidates.length) {
    const pref = used === "consolidated" ? "consolidated" : "standalone";
    const same = candidates.filter((r) => String(r.consolidated).toLowerCase().startsWith(pref.slice(0, 5)));
    const pick = (same.length ? same : candidates)[(same.length ? same : candidates).length - 1];
    bal = { periodEnd: pick.period_end, basis: pick.consolidated, equity: cr(pick.equity), borrowings: cr(pick.borrowings), totalAssets: cr(pick.total_assets) };
  }
  m.book_value = bal ? bal.equity : null;
  const balanceReason = !raw.length ? noResults : "Balance sheets come with half-yearly and annual filings; none parsed yet for this company.";
  if (bal && m.shares) {
    m.bvps = (bal.equity * CR) / m.shares;
    m.pb = close && m.bvps > 0 ? close / m.bvps : null;
    if (m.pb === null) reasons.pb = m.bvps <= 0 ? "Book value is negative." : reasons.price;
  } else {
    m.bvps = m.pb = null;
    reasons.bvps = reasons.pb = !bal ? balanceReason : reasons.shares;
  }
  if (!bal) reasons.book_value = balanceReason;
  const owners = last4 ? last4.map((q) => (q.pat_owners != null ? q.pat_owners : q.pat)) : [];
  if (bal && owners.length && owners.every((v) => v != null) && bal.equity && bal.equity > 0) {
    m.roe = (owners.reduce((a, b) => a + b, 0) / CR / bal.equity) * 100;
  } else {
    m.roe = null;
    reasons.roe = !bal ? balanceReason : reasons.net_profit_ttm || "Book value is not positive.";
  }
  if (bal && bal.borrowings !== null && bal.equity && !isBank) m.debt_to_equity = bal.borrowings / bal.equity;
  else {
    m.debt_to_equity = null;
    reasons.debt_to_equity = isBank ? "Not meaningful for banks, whose funding is mostly deposits." : !bal ? balanceReason : "Borrowings are not reported.";
  }

  const stm = statements(db, symbol, chosen.length ? used : null, cutoff);
  const bsPeriods = stm.balanceSheet.periods, cfPeriods = stm.cashFlow.periods;
  const stmReason = !symbol || identity.limited ? noResults : "Balance sheets and cash flows come from half-yearly and annual filings; none has been read for this company yet.";
  const latestBs: Record<string, number> = bsPeriods.length ? bsPeriods[bsPeriods.length - 1].values : {};
  const annualCf = [...cfPeriods].reverse().find((p) => (p.months || 0) >= 12);
  m.cash = bsPeriods.length ? (latestBs.cash ?? latestBs.cash_rbi ?? null) : null;
  const ca = latestBs.current_assets, cl = latestBs.current_liabilities;
  m.current_ratio = ca != null && cl ? ca / cl : null;
  m.cfo_fy = annualCf ? annualCf.values.cfo ?? null : null;
  m.capex_fy = annualCf ? annualCf.values.capex ?? null : null;
  m.fcf_fy = annualCf ? annualCf.values.fcf ?? null : null;
  for (const k of ["cash", "current_ratio", "cfo_fy", "capex_fy", "fcf_fy"]) {
    if (m[k] !== null) continue;
    if (k === "current_ratio" && isBank) reasons[k] = "Banks do not report current assets and liabilities separately.";
    else if (k === "fcf_fy" && isBank) reasons[k] = "Not meaningful for banks: operating cash flow includes deposit movements.";
    else if (["cfo_fy", "capex_fy", "fcf_fy"].includes(k) && cfPeriods.length && !annualCf) reasons[k] = "Only half-year cash flow statements are on file; a full-year statement is filed with March results.";
    else if ((["cash", "current_ratio"].includes(k) ? bsPeriods : cfPeriods).length) reasons[k] = "This line is not reported in the latest statement.";
    else reasons[k] = stmReason;
  }
  const stmEquity = latestBs.owners_equity ?? latestBs.equity;
  if (m.book_value === null && stmEquity != null) {
    m.book_value = stmEquity;
    delete reasons.book_value;
  }

  const dividends: Row[] = [];
  const session: string | null = quote ? quote.session : cutoff || newest;
  if (session) {
    const lo = addDays(session, -365);
    const rows = symbol
      ? db.all("SELECT ex_date, purpose FROM nse_corp_action WHERE symbol = ? AND ex_date > ? AND ex_date <= ? AND LOWER(purpose) LIKE '%dividend%' ORDER BY ex_date DESC", [symbol, lo, session])
      : db.all("SELECT ex_date, purpose FROM corp_action WHERE scrip_cd = ? AND ex_date > ? AND ex_date <= ? AND LOWER(purpose) LIKE '%dividend%' ORDER BY ex_date DESC", [bseCode, lo, session]);
    const src = symbol ? "NSE" : "BSE";
    const seen = new Set<string>();
    for (const r of rows) {
      const amount = dividendAmount(r.purpose);
      const key = `${r.ex_date}|${amount}`;
      if (seen.has(key)) continue;
      seen.add(key);
      dividends.push({ exDate: r.ex_date, purpose: r.purpose, amount: amount ? amount * adj.factor(r.ex_date) : null, source: src });
    }
  }
  const totalDiv = dividends.reduce((s, d) => s + (d.amount || 0), 0);
  m.dividend_ttm = totalDiv || null;
  m.dividend_yield = totalDiv && close ? (totalDiv / close) * 100 : null;
  if (!dividends.length) reasons.dividend_ttm = reasons.dividend_yield = `No dividend ex-dates in the twelve months to ${session}.`;
  else if (!totalDiv) reasons.dividend_ttm = reasons.dividend_yield = "Dividend announced but the amount could not be read from the notice.";

  let holding: Row[] = [];
  let holdingSource: string | null = null;
  if (symbol) {
    const summary = new Map(db.all("SELECT as_of_date, promoter, public, emp_trusts, broadcast_dt FROM nse_shareholding WHERE symbol = ?", [symbol]).map((r) => [r.as_of_date, { ...r }]));
    const detail = new Map(db.all("SELECT as_of_date, promoter, fii, dii, government, public, others, shareholders, total_shares FROM nse_shareholding_detail WHERE symbol = ? AND status = 'ok'", [symbol]).map((r) => [r.as_of_date, { ...r }]));
    for (const d of [...new Set([...summary.keys(), ...detail.keys()])].sort()) {
      const s: Row = summary.get(d) ?? {};
      const filed = normDateTime(s.broadcast_dt);
      if (cutoff && (d > cutoff || (filed && filed.slice(0, 10) > cutoff))) continue;
      let row: Row;
      if (detail.has(d)) {
        row = detail.get(d)!;
        row.source = "xbrl";
      } else {
        row = { as_of_date: d, promoter: s.promoter ?? null, public: s.public ?? null, others: s.emp_trusts ?? null, fii: null, dii: null, government: null, shareholders: null, total_shares: null, source: "summary" };
      }
      row.filed_at = filed;
      holding.push(row);
    }
    holding = holding.slice(-24);
    holdingSource = holding.length ? holding[holding.length - 1].source : null;
  }
  const lastHold = holding[holding.length - 1];
  m.promoter = lastHold ? lastHold.promoter : null;
  m.fii = lastHold ? lastHold.fii : null;
  m.dii = lastHold ? lastHold.dii : null;
  if (!holding.length) reasons.promoter = reasons.fii = reasons.dii = !symbol ? "Shareholding patterns are collected from NSE; this company is listed only on BSE." : "No shareholding pattern on file yet.";
  else if (m.fii === null) reasons.fii = reasons.dii = "Only the promoter / public summary is on file for the latest quarter.";
  if (holding.length && m.promoter === null) reasons.promoter = "No promoter group is disclosed.";

  Object.assign(m, {
    change: quote ? quote.change : null, change_pct: quote ? quote.changePct : null,
    high_52w: quote ? quote.high52w : null, low_52w: quote ? quote.low52w : null, volume: quote ? quote.volume : null,
  });
  for (const [label] of RETURN_WINDOWS) {
    const k = `ret_${label.toLowerCase()}`;
    m[k] = returns[label] ?? null;
    if (m[k] === null) reasons[k] = returnReasons[label] || reasons.price;
  }

  let status = "end_of_day";
  if (cutoff) status = "historical";
  else if (newest && (parseIso(todayIso())!.getTime() - parseIso(newest)!.getTime()) / 86_400_000 > DELAYED_AFTER_DAYS) status = "delayed";
  const freshness = {
    status, asOf: cutoff,
    prices: { session: quote ? quote.session : null, latestStored: newest, source: `${exchange} bhavcopy (end of day)` },
    results: { latestQuarter: m.latest_quarter, filedAt: latest ? latest.filed_at : null, source: symbol ? "NSE XBRL result filings" : null, pendingFilings: pending },
    shareholding: {
      asOf: lastHold ? lastHold.as_of_date : null, filedAt: lastHold ? lastHold.filed_at : null,
      source: holdingSource === "xbrl" ? "Shareholding-pattern XBRL (NSE)" : holdingSource ? "NSE shareholding summary" : null,
    },
    computedAt: localIsoNow(),
    notes: [
      adj.active ? `Prices are adjusted for splits and bonuses up to ${cutoff || "today"}.` : null,
      cutoff ? "Industry and index membership reflect current constituent lists." : null,
    ].filter(Boolean),
  };

  Object.assign(sources, {
    price: freshness.prices.source,
    revenue_ttm: last4 ? `Sum of the last four quarterly filings (${used})` : null,
    pe: m.pe ? "Close / trailing twelve-month EPS (adjusted for splits and bonuses)" : null,
    pb: bal && m.pb ? `Close / (book value / shares outstanding), balance sheet of ${bal.periodEnd}` : null,
    roe: bal && m.roe ? `TTM profit attributable to owners / book value (${bal.periodEnd})` : null,
    dividend_yield: m.dividend_yield ? "Dividends with ex-date in the last 12 months / close" : null,
  });

  const { _bseMarketCap, ...publicIdentity } = identity; // eslint-disable-line @typescript-eslint/no-unused-vars
  const model: Row = {
    schema: SNAPSHOT_SCHEMA,
    identity: publicIdentity,
    exchange,
    quote,
    metrics: m,
    reasons: Object.fromEntries(Object.entries(reasons).filter(([k, v]) => v && (m[k] === null || m[k] === undefined))),
    sources: Object.fromEntries(Object.entries(sources).filter(([, v]) => v)),
    basis: { used: chosen.length ? used : null, available },
    reportFormat: raw.length ? (isBank ? "bank" : "corporate") : null,
    quarters: lines.slice(-40),
    annual: years,
    ttm: ttmRow,
    growth,
    balance: bal,
    sharesInfo: shares,
    statements: stm,
    dividends,
    shareholding: holding,
    freshness,
    dataPeriod: {
      pricesFrom: bars.length ? bars[0].t : null, pricesTo: bars.length ? bars[bars.length - 1].t : null,
      resultsFrom: lines.length ? lines[0].period_end : null, resultsTo: lines.length ? lines[lines.length - 1].period_end : null,
    },
    noResultsReason: lines.length ? null : noResults,
  };
  model.analysis = observations(db, model, (opts.peers ?? true) && !cutoff);
  return model;
}

// --- rule-based observations ----------------------------------------------------------------------------------
export function observations(db: Db, model: Row, peers = true) {
  const m = model.metrics as Row;
  const lines = model.quarters as Row[];
  const pros: string[] = [], cons: string[] = [];
  const has = (k: string) => m[k] !== null && m[k] !== undefined;

  if (has("profit_qtr_yoy")) {
    if (m.profit_qtr_yoy >= 20) pros.push(`Net profit grew ${f0(m.profit_qtr_yoy)}% against the same quarter last year.`);
    else if (m.profit_qtr_yoy <= -20) cons.push(`Net profit fell ${f0(-m.profit_qtr_yoy)}% against the same quarter last year.`);
  }
  if (has("sales_qtr_yoy")) {
    if (m.sales_qtr_yoy >= 15) pros.push(`Sales grew ${f0(m.sales_qtr_yoy)}% year on year in the latest quarter.`);
    else if (m.sales_qtr_yoy <= -10) cons.push(`Sales declined ${f0(-m.sales_qtr_yoy)}% year on year in the latest quarter.`);
  }
  const recent = lines.slice(-8);
  if (recent.length >= 4) {
    const losses = recent.filter((l) => (l.net_profit || 0) < 0).length;
    if (losses === 0) pros.push(`Profitable in each of the last ${recent.length} reported quarters.`);
    else if (losses >= 2) cons.push(`Reported a loss in ${losses} of the last ${recent.length} quarters.`);
  }
  const bank = model.reportFormat === "bank";
  if (lines.length >= 8 && !bank) {
    const nowOpm = lines.slice(-4).map((l) => l.opm).filter((v) => v !== null);
    const before = lines.slice(-8, -4).map((l) => l.opm).filter((v) => v !== null);
    if (nowOpm.length === 4 && before.length === 4) {
      const a = before.reduce((x, y) => x + y, 0) / 4, b = nowOpm.reduce((x, y) => x + y, 0) / 4;
      if (b - a >= 2) pros.push(`Operating margin improved from ${f1(a)}% to ${f1(b)}% over the past year.`);
      else if (a - b >= 2) cons.push(`Operating margin compressed from ${f1(a)}% to ${f1(b)}% over the past year.`);
    }
  }
  if (lines.length && !bank) {
    const oi = lines.slice(-4).map((l) => l.other_income), pbt = lines.slice(-4).map((l) => l.pbt);
    if ([...oi, ...pbt].every((v) => v !== null)) {
      const spbt = pbt.reduce((a, b) => a + b, 0), soi = oi.reduce((a, b) => a + b, 0);
      if (spbt > 0 && soi / spbt >= 0.3) cons.push(`Other income is ${f0((soi / spbt) * 100)}% of profit before tax over the last four quarters.`);
    }
  }
  if (has("roe")) {
    if (m.roe >= 18) pros.push(`Return on equity is strong at ${f1(m.roe)}%.`);
    else if (m.roe < 8) cons.push(`Return on equity is low at ${f1(m.roe)}%.`);
  }
  if (has("debt_to_equity")) {
    if (m.debt_to_equity <= 0.1) pros.push(`Almost debt free (borrowings ${f2(m.debt_to_equity)}x equity).`);
    else if (m.debt_to_equity >= 1.5) cons.push(`Borrowings are ${f1(m.debt_to_equity)}x shareholders' equity.`);
  }
  if (has("promoter") && m.promoter > 0) {
    if (m.promoter >= 60) pros.push(`Promoter holding is high at ${f1(m.promoter)}%.`);
    else if (m.promoter < 30) cons.push(`Promoter holding is low at ${f1(m.promoter)}%.`);
  }
  const holding = model.shareholding as Row[];
  if (holding.length >= 2 && holding[holding.length - 1].promoter != null && holding[holding.length - 2].promoter != null) {
    const diff = holding[holding.length - 1].promoter - holding[holding.length - 2].promoter;
    if (diff <= -1) cons.push(`Promoters reduced their stake by ${f1(-diff)} points last quarter.`);
  }
  if (m.dividend_yield && m.dividend_yield >= 2) pros.push(`Dividends over the last year amount to a ${f1(m.dividend_yield)}% yield.`);
  const q: Row = model.quote ?? {};
  if (q.fromHigh != null && q.fromHigh <= -30) cons.push(`Trades ${f0(-q.fromHigh)}% below its 52-week high.`);
  else if (q.fromHigh != null && q.fromHigh >= -5) pros.push("Trades within 5% of its 52-week high.");
  if (has("sales_cagr_3y")) {
    if (m.sales_cagr_3y >= 15) pros.push(`Sales have compounded at ${f0(m.sales_cagr_3y)}% a year over three years.`);
    else if (m.sales_cagr_3y < 0) cons.push(`Sales have shrunk over three years (${f0(m.sales_cagr_3y)}% a year).`);
  }
  const industry = model.identity.industry;
  if (peers && industry && m.pe) {
    const vals = db.all<{ pe: number }>("SELECT pe FROM company_metrics WHERE industry = ? AND pe IS NOT NULL AND pe > 0", [industry]).map((r) => r.pe).sort((a, b) => a - b);
    if (vals.length >= 5) {
      const med = vals[Math.floor(vals.length / 2)];
      if (m.pe <= med * 0.75) pros.push(`P/E of ${f1(m.pe)} is below the ${industry} median of ${f1(med)}.`);
      else if (m.pe >= med * 1.5) cons.push(`P/E of ${f1(m.pe)} is well above the ${industry} median of ${f1(med)}.`);
    }
  }
  return { pros, cons, basis: "Generated by fixed rules from reported filings and exchange prices; not investment advice." };
}

// --- versions ------------------------------------------------------------------------------------------------------
export function ensureSchema(db: Db) {
  db.exec(VERSION_SCHEMA);
}

// What makes two analyses different: the company's own figures. Bookkeeping and peer medians are left out,
// so re-running an unchanged analysis never stores a duplicate.
const HASHED_KEYS = ["identity", "exchange", "quote", "metrics", "basis", "quarters", "annual", "ttm", "growth", "balance", "sharesInfo", "statements", "dividends", "shareholding", "dataPeriod"];

function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${stableStringify((v as Row)[k])}`).join(",")}}`;
}

export const contentHash = (model: Row) =>
  crypto.createHash("sha1").update(stableStringify(Object.fromEntries(HASHED_KEYS.map((k) => [k, model[k] ?? null])))).digest("hex");

export function summaryText(model: Row): string {
  const m = model.metrics as Row;
  const parts: string[] = [];
  if (m.close != null) parts.push(`Close Rs ${grouped(Math.round(m.close * 100) / 100, 2)}`);
  if (m.pe != null) parts.push(`P/E ${f1(m.pe)}`);
  if (m.revenue_ttm != null) parts.push(`Revenue TTM Rs ${grouped(Math.round(m.revenue_ttm))} Cr`);
  if (m.net_profit_ttm != null) {
    const g = m.profit_ttm_growth;
    parts.push(`Net profit TTM Rs ${grouped(Math.round(m.net_profit_ttm))} Cr${g != null ? ` (${g >= 0 ? "+" : ""}${f0(g)}%)` : ""}`);
  }
  if (m.ret_1y != null) parts.push(`1Y ${m.ret_1y >= 0 ? "+" : ""}${f1(m.ret_1y)}%`);
  return parts.join(" | ") || "Price data only";
}

const publicRow = (r: Row) => {
  const { snapshot, content_hash, ...rest } = r; // eslint-disable-line @typescript-eslint/no-unused-vars
  return { ...rest };
};

export function createVersion(db: Db, ident: string | Identity, opts: { exchange?: string | null; asOf?: string | null; kind?: string } = {}): Row {
  ensureSchema(db);
  const identity = typeof ident === "string" ? resolve(db, ident) : ident;
  const model = build(db, identity, { exchange: opts.exchange, asOf: opts.asOf });
  if (!model.quote) throw new Error(`No ${model.exchange} prices on or before ${opts.asOf || "today"} for ${identity.key}.`);
  const analysisDate = model.quote.session;
  const digest = contentHash(model);
  const key = identity.key;
  const same = db.get("SELECT * FROM analysis_version WHERE company_key = ? AND exchange = ? AND analysis_date = ? AND content_hash = ? AND status = 'completed' ORDER BY version DESC LIMIT 1", [key, model.exchange, analysisDate, digest]);
  if (same) return { ...publicRow(same), unchanged: true };

  const ts = now();
  const blob = zlib.deflateSync(Buffer.from(JSON.stringify(model), "utf8"), { level: 6 });
  let id = 0;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      id = db.transaction(() => {
        const version = (db.scalar<number>("SELECT MAX(version) FROM analysis_version WHERE company_key = ?", [key]) || 0) + 1;
        const r = db.run("INSERT INTO analysis_version (company_key, symbol, bse_code, company, exchange, analysis_date, version, status, kind, data_from, data_to, results_as_of, shareholding_as_of, summary, content_hash, snapshot, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          [key, identity.symbol, identity.bseCode, identity.company, model.exchange, analysisDate, version, opts.kind ?? "on_demand", model.dataPeriod.pricesFrom, model.dataPeriod.pricesTo, model.metrics.latest_quarter, model.freshness.shareholding.asOf, summaryText(model), digest, blob, ts, ts]);
        return Number(r.lastInsertRowid);
      });
      break;
    } catch (e) {
      if (!String((e as Error).message).includes("UNIQUE") || attempt === 4) throw e;
    }
  }
  return { ...publicRow(db.get("SELECT * FROM analysis_version WHERE id = ?", [id])!), unchanged: false };
}

export function loadVersion(db: Db, versionId: number): Row | null {
  ensureSchema(db);
  const row = db.get("SELECT * FROM analysis_version WHERE id = ?", [versionId]);
  if (!row) return null;
  const out: Row = publicRow(row);
  out.snapshot = row.snapshot ? JSON.parse(zlib.inflateSync(Buffer.from(row.snapshot as Uint8Array)).toString("utf8")) : null;
  return out;
}

/** Companies that get scheduled analyses: watchlist, NIFTY 500, and any already analysed. */
export function trackedCompanies(db: Db): string[] {
  ensureSchema(db);
  const keys = db.all<{ k: string | null }>("SELECT symbol k FROM nse_index_constituent WHERE index_symbol = 'nifty500' UNION SELECT symbol FROM watchlist WHERE UPPER(exchange) = 'NSE' UNION SELECT COALESCE(scrip_cd, symbol) FROM watchlist WHERE UPPER(exchange) = 'BSE' UNION SELECT company_key FROM analysis_version").map((r) => r.k);
  return [...new Set(keys.filter((k): k is string => Boolean(k)))].sort();
}

const SCHEDULE_EVERY_DAYS = 7;

/** New versions where data moved on: none yet, a new quarter or shareholding pattern, or the last one is a week old. */
export function runScheduled(db: Db, limit?: number): number {
  ensureSchema(db);
  let made = 0;
  for (const key of trackedCompanies(db).slice(0, limit || undefined)) {
    try {
      const identity = resolve(db, key);
      const exchange = pickExchange(identity, null);
      const last = db.get("SELECT analysis_date, results_as_of, shareholding_as_of FROM analysis_version WHERE company_key = ? AND exchange = ? AND status = 'completed' AND kind != 'point_in_time' ORDER BY analysis_date DESC, version DESC LIMIT 1", [identity.key, exchange]);
      const session = latestSession(db, exchange);
      if (last && session && last.analysis_date >= session) continue;
      if (last && session) {
        const results = identity.symbol ? db.scalar<string>("SELECT MAX(period_end) FROM nse_fundamental WHERE symbol = ? AND quality = 'ok'", [identity.symbol]) : null;
        const holding = identity.symbol ? db.scalar<string>("SELECT MAX(as_of_date) FROM nse_shareholding WHERE symbol = ?", [identity.symbol]) : null;
        const stale = (parseIso(session)!.getTime() - parseIso(last.analysis_date)!.getTime()) / 86_400_000 >= SCHEDULE_EVERY_DAYS;
        const moved = (results || "") > (last.results_as_of || "") || (holding || "") > (last.shareholding_as_of || "");
        if (!stale && !moved) continue;
      }
      const v = createVersion(db, identity, { exchange, kind: "scheduled" });
      if (!v.unchanged) made++;
    } catch (e) {
      if (e instanceof NotFoundError) continue;
      log.warn(`scheduled analysis ${key}: ${(e as Error).message}`);
    }
  }
  return made;
}
