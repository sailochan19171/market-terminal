// Denormalised per-company metrics - one row per NSE symbol in company_metrics.
//
// Screens, peer tables, the home page and search all need the same derived figures. Computing them per
// request means multi-CTE SQL over millions of rows, so they are built here in a handful of bulk queries.
// Only fundamentals that passed the quality check are used. Nothing is estimated.
import { now, type Db, type Row } from "../db";
import { logger } from "../log";
import { cagr, parseIso, pctChange } from "../util";
import { Adjuster, loadEvents } from "./adjust";

const log = logger("core.metrics");

export const EQ_SERIES = ["EQ", "BE", "BZ", "SM", "ST"];
export const CR = 1e7;
const DIV_AMT = /(?:Rs\.?|Re\.?|INR)\s*-?\s*([0-9]+(?:\.[0-9]+)?)/i;

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS company_metrics (
    symbol TEXT PRIMARY KEY,
    company TEXT, isin TEXT, series TEXT, industry TEXT, indices TEXT,
    bse_code TEXT, face_value REAL, listing_date TEXT,
    trade_date TEXT, open REAL, high REAL, low REAL, close REAL, prev_close REAL,
    change REAL, pct_1d REAL, volume REAL, turnover REAL,
    high_52w REAL, low_52w REAL, from_high REAL, from_low REAL,
    ret_1m REAL, ret_3m REAL, ret_1y REAL,
    market_cap_cr REAL, mcap_source TEXT,
    basis TEXT, quarters_available INTEGER, latest_quarter TEXT,
    sales_qtr_cr REAL, np_qtr_cr REAL, qtr_sales_var REAL, qtr_profit_var REAL,
    sales_ttm_cr REAL, np_ttm_cr REAL, eps_ttm REAL, pe REAL,
    opm_ttm REAL, net_margin_ttm REAL,
    promoter REAL, div_ttm REAL, div_yield REAL,
    avg_eps_annual REAL, earnings_years INTEGER, price_to_avg_earnings REAL,
    sales_growth_3y REAL, profit_growth_3y REAL,
    ret_1w REAL, ret_6m REAL,
    shares REAL, shares_source TEXT, gross_profit_ttm_cr REAL, gpm_ttm REAL,
    book_value_cr REAL, bvps REAL, pb REAL, roe REAL, debt_to_equity REAL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_cm_industry ON company_metrics(industry);
CREATE INDEX IF NOT EXISTS ix_cm_bse ON company_metrics(bse_code);
`;

const ADDED_COLUMNS: Record<string, string> = {
  ret_1w: "REAL", ret_6m: "REAL", shares: "REAL", shares_source: "TEXT", gross_profit_ttm_cr: "REAL", gpm_ttm: "REAL",
  book_value_cr: "REAL", bvps: "REAL", pb: "REAL", roe: "REAL", debt_to_equity: "REAL",
};

export function ensureSchema(db: Db) {
  db.exec(SCHEMA);
  db.addColumns("company_metrics", ADDED_COLUMNS);
}

/** Indian fiscal years end in March: Jun/Sep/Dec of Y belong to FY Y+1. */
export function fiscalYear(periodEnd: string): number | null {
  const d = parseIso(periodEnd);
  if (!d) return null;
  return d.getUTCMonth() + 1 <= 3 ? d.getUTCFullYear() : d.getUTCFullYear() + 1;
}

export type Basis = "auto" | "consolidated" | "standalone";

/** Choose one reporting basis so earnings are never double-counted. */
export function pickBasis(rows: Row[], basis: Basis | string = "auto"): [string, { consolidated: boolean; standalone: boolean }, Row[]] {
  const byPeriod = new Map<string, { c?: Row; s?: Row }>();
  for (const r of rows) {
    const cons = String(r.consolidated ?? "").toLowerCase().startsWith("consolidated");
    const slot = byPeriod.get(r.period_end) ?? {};
    slot[cons ? "c" : "s"] = r;
    byPeriod.set(r.period_end, slot);
  }
  const vals = [...byPeriod.values()];
  const available = { consolidated: vals.some((v) => v.c), standalone: vals.some((v) => v.s) };
  let used = basis;
  if (used === "auto") used = available.consolidated ? "consolidated" : "standalone";
  const key = used === "consolidated" ? "c" : "s";
  const chosen = [...byPeriod.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([, v]) => v[key]).filter((x): x is Row => Boolean(x));
  return [used, available, chosen];
}

/** Presentation line items for one quarter, in crore. */
export function quarterRow(q: Row): Row {
  const rev = q.revenue ?? null, te = q.total_expenses ?? null;
  const fin = q.finance_costs ?? null, dep = q.depreciation ?? null;
  const hasLines = (q.parser_version || 1) >= 2;
  let expenses: number | null = null;
  if (te !== null) expenses = hasLines ? te - (fin || 0) - (dep || 0) : null;
  const op = rev !== null && expenses !== null ? rev - expenses : null;
  const pbt = q.pbt ?? null, tax = q.tax ?? null;
  return {
    period_end: q.period_end,
    sales: rev === null ? null : rev / CR,
    expenses: expenses === null ? null : expenses / CR,
    operating_profit: op === null ? null : op / CR,
    opm: op !== null && rev ? (op / rev) * 100 : null,
    other_income: q.other_income == null ? null : q.other_income / CR,
    interest: fin === null ? null : fin / CR,
    depreciation: dep === null ? null : dep / CR,
    pbt: pbt === null ? null : pbt / CR,
    tax_pct: tax !== null && pbt ? (tax / pbt) * 100 : null,
    net_profit: q.pat == null ? null : q.pat / CR,
    eps: q.eps_basic ?? null,
    quality: q.quality ?? null,
    xbrl_url: q.xbrl_url ?? null,
    complete: hasLines,
  };
}

/** The last four quarters, if they really are four consecutive quarters. */
export function ttm(quarters: Row[]): Row[] | null {
  if (quarters.length < 4) return null;
  const last4 = quarters.slice(-4);
  const a = parseIso(last4[0].period_end), b = parseIso(last4[3].period_end);
  if (!a || !b || (b.getTime() - a.getTime()) / 86_400_000 > 280) return null;
  return last4;
}

/** Fiscal-year totals, only for years with all four quarters present. */
export function annual(quarters: Row[]): { fy: number; quarters: Row[] }[] {
  const groups = new Map<number, Row[]>();
  for (const q of quarters) {
    const fy = fiscalYear(q.period_end);
    if (fy) groups.set(fy, [...(groups.get(fy) ?? []), q]);
  }
  return [...groups.entries()].sort((a, b) => a[0] - b[0]).filter(([, qs]) => qs.length === 4).map(([fy, qs]) => ({ fy, quarters: qs }));
}

export function sumField(qs: Row[], field: string): number | null {
  const vals = qs.map((q) => q[field]);
  if (vals.some((v) => v === null || v === undefined)) return null;
  return vals.reduce((a, b) => a + b, 0);
}

export function dividendAmount(purpose: string): number {
  if (!(purpose ?? "").toLowerCase().includes("dividend")) return 0;
  const m = purpose.match(DIV_AMT);
  return m ? parseFloat(m[1]) : 0;
}

const COLS = ("symbol company isin series industry indices bse_code face_value listing_date "
  + "trade_date open high low close prev_close change pct_1d volume turnover "
  + "high_52w low_52w from_high from_low ret_1m ret_3m ret_1y market_cap_cr mcap_source "
  + "basis quarters_available latest_quarter sales_qtr_cr np_qtr_cr qtr_sales_var "
  + "qtr_profit_var sales_ttm_cr np_ttm_cr eps_ttm pe opm_ttm net_margin_ttm promoter "
  + "div_ttm div_yield avg_eps_annual earnings_years price_to_avg_earnings "
  + "sales_growth_3y profit_growth_3y ret_1w ret_6m shares shares_source gross_profit_ttm_cr gpm_ttm "
  + "book_value_cr bvps pb roe debt_to_equity updated_at").split(" ");

export function rebuild(db: Db): number {
  ensureSchema(db);
  const ts = now();
  const lastDay = db.scalar<string>("SELECT MAX(trade_date) FROM nse_bhavcopy");
  if (!lastDay) {
    log.warn("metrics: no price data yet");
    return 0;
  }
  const ph = EQ_SERIES.map(() => "?").join(",");
  const events = loadEvents(db);
  const adjusters = new Map([...events].map(([sym, ev]) => [sym, new Adjuster(ev)]));

  const closesOnOrBefore = (daysBack: number) => {
    const target = db.scalar<string>("SELECT MAX(trade_date) FROM nse_bhavcopy WHERE trade_date <= date(?, ?)", [lastDay, `-${daysBack} day`]);
    const out = new Map<string, number | null>();
    if (!target) return out;
    for (const r of db.all<{ symbol: string; close: number | null }>(`SELECT symbol, close FROM nse_bhavcopy WHERE trade_date = ? AND series IN (${ph})`, [target, ...EQ_SERIES])) {
      const a = adjusters.get(r.symbol);
      out.set(r.symbol, a && r.close !== null ? r.close * a.factor(target) : r.close);
    }
    return out;
  };

  const day = new Map<string, Row>();
  for (const r of db.all(`SELECT symbol, series, open, high, low, close, prev_close, volume, turnover FROM nse_bhavcopy WHERE trade_date = ? AND series IN (${ph})`, [lastDay, ...EQ_SERIES])) {
    if (!day.has(r.symbol) || r.series === "EQ") day.set(r.symbol, { ...r });
  }

  const w52 = new Map<string, [number | null, number | null]>();
  for (const r of db.all(`SELECT symbol, MAX(high) hi, MIN(low) lo FROM nse_bhavcopy WHERE series IN (${ph}) AND trade_date >= date(?, '-365 day') GROUP BY symbol`, [...EQ_SERIES, lastDay])) {
    w52.set(r.symbol, [r.hi, r.lo]);
  }
  for (const [sym, a] of adjusters) {
    let hi: number | null = null, lo: number | null = null;
    for (const r of db.all("SELECT trade_date, high, low FROM nse_bhavcopy WHERE symbol = ? AND series IN ('EQ','BE','BZ','SM','ST') AND trade_date >= date(?, '-365 day')", [sym, lastDay])) {
      const f = a.factor(r.trade_date);
      if (r.high !== null) hi = hi === null ? r.high * f : Math.max(hi, r.high * f);
      if (r.low !== null) lo = lo === null ? r.low * f : Math.min(lo, r.low * f);
    }
    if (hi !== null) w52.set(sym, [hi, lo]);
  }
  const c1w = closesOnOrBefore(7), c1m = closesOnOrBefore(30), c3m = closesOnOrBefore(91), c6m = closesOnOrBefore(182), c1y = closesOnOrBefore(365);

  const symbols = new Map(db.all("SELECT symbol, company, isin, series, face_value, listing_date FROM nse_symbol").map((r) => [r.symbol, { ...r }]));
  const industry = new Map<string, string>();
  const indices = new Map<string, string[]>();
  for (const r of db.all("SELECT symbol, index_symbol, industry FROM nse_index_constituent")) {
    indices.set(r.symbol, [...(indices.get(r.symbol) ?? []), r.index_symbol]);
    if (r.industry && !industry.has(r.symbol)) industry.set(r.symbol, r.industry);
  }
  const bse = new Map<string, [string, number | null]>();
  for (const r of db.all("SELECT isin, scrip_cd, market_cap, status FROM scrip WHERE isin IS NOT NULL ORDER BY (status = 'Active') ASC")) {
    bse.set(r.isin, [r.scrip_cd, r.market_cap]); // Active rows win (written last)
  }
  const promoter = new Map(db.all("SELECT s.symbol, s.promoter FROM nse_shareholding s JOIN (SELECT symbol, MAX(as_of_date) d FROM nse_shareholding GROUP BY symbol) m ON m.symbol = s.symbol AND m.d = s.as_of_date").map((r) => [r.symbol, r.promoter]));
  const dividends = new Map<string, number>();
  for (const r of db.all("SELECT symbol, purpose FROM nse_corp_action WHERE ex_date >= date(?, '-365 day') AND ex_date <= ?", [lastDay, lastDay])) {
    dividends.set(r.symbol, (dividends.get(r.symbol) ?? 0) + dividendAmount(r.purpose));
  }
  const funds = new Map<string, Row[]>();
  const balance = new Map<string, Row[]>();
  for (const r of db.all("SELECT symbol, period_end, consolidated, revenue, total_expenses, finance_costs, depreciation, other_income, pbt, tax, pat, pat_owners, eps_basic, equity_capital, quality, parser_version, gross_profit, shares, equity, borrowings, report_format, xbrl_url FROM nse_fundamental WHERE quality IN ('ok', 'suspect') AND period_end != '' ORDER BY period_end")) {
    const row = { ...r };
    if (row.quality === "ok") funds.set(r.symbol, [...(funds.get(r.symbol) ?? []), row]);
    if (row.equity !== null) balance.set(r.symbol, [...(balance.get(r.symbol) ?? []), row]);
  }
  const holdingShares = new Map(db.all("SELECT d.symbol, d.total_shares, d.as_of_date FROM nse_shareholding_detail d JOIN (SELECT symbol, MAX(as_of_date) m FROM nse_shareholding_detail WHERE total_shares IS NOT NULL GROUP BY symbol) x ON x.symbol = d.symbol AND x.m = d.as_of_date").map((r) => [r.symbol, [r.total_shares as number, r.as_of_date as string] as const]));

  const out: Row[] = [];
  for (const sym of new Set([...symbols.keys(), ...day.keys()])) {
    const meta: Row = symbols.get(sym) ?? {};
    const px = day.get(sym);
    const close: number | null = px ? px.close : null;
    const isin = meta.isin ?? null;
    const [bseCode, bseMcap] = isin && bse.has(isin) ? bse.get(isin)! : [null, null];
    const rec: Row = {
      symbol: sym, company: meta.company ?? null, isin, series: meta.series || px?.series || null,
      industry: industry.get(sym) ?? null, indices: (indices.get(sym) ?? []).slice().sort().join(",") || null,
      bse_code: bseCode, face_value: meta.face_value ?? null, listing_date: meta.listing_date ?? null,
      trade_date: px ? lastDay : null, open: px?.open ?? null, high: px?.high ?? null, low: px?.low ?? null, close,
      prev_close: px?.prev_close ?? null, volume: px?.volume ?? null, turnover: px?.turnover ?? null, updated_at: ts,
    };
    if (px && px.prev_close) {
      rec.change = close! - px.prev_close;
      rec.pct_1d = pctChange(close, px.prev_close);
    }
    const [hi, lo] = w52.get(sym) ?? [null, null];
    rec.high_52w = hi; rec.low_52w = lo;
    rec.from_high = pctChange(close, hi); rec.from_low = pctChange(close, lo);
    rec.ret_1w = pctChange(close, c1w.get(sym)); rec.ret_6m = pctChange(close, c6m.get(sym));
    rec.ret_1m = pctChange(close, c1m.get(sym)); rec.ret_3m = pctChange(close, c3m.get(sym)); rec.ret_1y = pctChange(close, c1y.get(sym));
    rec.promoter = promoter.get(sym) ?? null;
    const div = dividends.get(sym) ?? 0;
    rec.div_ttm = div || null;
    rec.div_yield = div && close ? (div / close) * 100 : null;

    const [basis, , chosen] = pickBasis(funds.get(sym) ?? []);
    const a = adjusters.get(sym);
    const factor = (d: string) => (a ? a.factor(d) : 1);

    let shares: number | null = null;
    if (holdingShares.has(sym)) {
      const [n, asOf] = holdingShares.get(sym)!;
      shares = n / factor(asOf);
      rec.shares_source = "shareholding";
    } else {
      const q = [...(funds.get(sym) ?? []), ...(balance.get(sym) ?? [])].reverse().find((x) => x.shares);
      if (q) {
        shares = q.shares / factor(q.period_end);
        rec.shares_source = "results";
      }
    }
    rec.shares = shares;
    const qs: Row[] = a ? chosen.map((q): Row => ({ ...q, eps_basic: q.eps_basic != null ? q.eps_basic * a.factor(q.period_end) : null })) : chosen;
    rec.basis = qs.length ? basis : null;
    rec.quarters_available = qs.length;

    if (qs.length) {
      const latest = qs[qs.length - 1];
      rec.latest_quarter = latest.period_end;
      rec.sales_qtr_cr = latest.revenue == null ? null : latest.revenue / CR;
      rec.np_qtr_cr = latest.pat == null ? null : latest.pat / CR;
      const priorKey = `${parseInt(latest.period_end.slice(0, 4), 10) - 1}${latest.period_end.slice(4)}`;
      const prior = qs.find((q) => q.period_end === priorKey);
      if (prior) {
        rec.qtr_sales_var = pctChange(latest.revenue, prior.revenue);
        rec.qtr_profit_var = pctChange(latest.pat, prior.pat);
      }
      const last4 = ttm(qs);
      if (last4) {
        const gp = sumField(last4, "gross_profit"), sales = sumField(last4, "revenue");
        rec.gross_profit_ttm_cr = gp === null ? null : gp / CR;
        rec.gpm_ttm = gp !== null && sales ? (gp / sales) * 100 : null;
        const np = sumField(last4, "pat"), eps = sumField(last4, "eps_basic");
        rec.sales_ttm_cr = sales === null ? null : sales / CR;
        rec.np_ttm_cr = np === null ? null : np / CR;
        rec.eps_ttm = eps;
        rec.pe = close && eps && eps > 0 ? close / eps : null;
        if (sales) {
          const rows = last4.map(quarterRow);
          if (rows.every((r) => r.operating_profit !== null)) rec.opm_ttm = (rows.reduce((s, r) => s + r.operating_profit, 0) / (sales / CR)) * 100;
          if (np !== null) rec.net_margin_ttm = (np / sales) * 100;
        }
      }
      const years = annual(qs);
      const epsYears = years.map((y) => sumField(y.quarters, "eps_basic")).filter((e): e is number => e !== null);
      if (epsYears.length) {
        const avg = epsYears.reduce((s, e) => s + e, 0) / epsYears.length;
        rec.avg_eps_annual = avg;
        rec.earnings_years = epsYears.length;
        rec.price_to_avg_earnings = close && avg > 0 ? close / avg : null;
      }
      if (years.length >= 4) {
        const ya = years[years.length - 1].quarters, yb = years[years.length - 4].quarters;
        rec.sales_growth_3y = cagr(sumField(ya, "revenue"), sumField(yb, "revenue"), 3);
        rec.profit_growth_3y = cagr(sumField(ya, "pat"), sumField(yb, "pat"), 3);
      }
    }

    if (shares && close) {
      rec.market_cap_cr = (shares * close) / CR;
      rec.mcap_source = "filing";
    } else if (bseMcap) {
      rec.market_cap_cr = bseMcap;
      rec.mcap_source = "bse";
    }

    const rowsBs = balance.get(sym) ?? [];
    if (rowsBs.length) {
      const pref = rowsBs.filter((r) => String(r.consolidated).toLowerCase().startsWith((basis || "consolidated").slice(0, 5)));
      const bs = (pref.length ? pref : rowsBs)[(pref.length ? pref : rowsBs).length - 1];
      const equityCr = bs.equity / CR;
      rec.book_value_cr = equityCr;
      if (shares) {
        rec.bvps = bs.equity / shares;
        rec.pb = close && rec.bvps > 0 ? close / rec.bvps : null;
      }
      const last4 = qs.length ? ttm(qs) : null;
      if (last4 && equityCr > 0) {
        const owners = last4.map((q) => (q.pat_owners != null ? q.pat_owners : q.pat));
        if (owners.every((v) => v != null)) rec.roe = (owners.reduce((s, v) => s + v, 0) / CR / equityCr) * 100;
      }
      const isBank = bs.report_format ? bs.report_format === "bank" : String(bs.xbrl_url ?? "").toUpperCase().includes("BANKING");
      if (!isBank && bs.borrowings != null && equityCr > 0) rec.debt_to_equity = bs.borrowings / CR / equityCr;
    }
    out.push(rec);
  }

  const rows = out.map((r) => Object.fromEntries(COLS.map((c) => [c, r[c] ?? null])));
  db.transaction(() => {
    db.run("DELETE FROM company_metrics");
    db.upsert("company_metrics", rows);
  });
  log.info(`company metrics -> ${rows.length} rows (prices as of ${lastDay})`);
  return rows.length;
}
