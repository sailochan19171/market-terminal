// Everything the research answers are allowed to use, each figure with the filing it came from.
//
// Nothing here is estimated: a number is either present in a filing (or a session's prices) or the field is
// null and the caller says "Data unavailable". Values are in the units the filings use; helpers convert.
import type { Db, Row } from "../db";
import { quoteFor, type PriceQuote } from "../core/price";
import { cagr, median, pctChange, toNum } from "../util";

export interface Fact<T = number | null> {
  value: T;
  unit?: "INR" | "INR_CR" | "percent" | "ratio" | "count" | "x";
  period?: string | null;
  source?: string;
  url?: string | null;
}

export interface Quarter {
  period: string;
  consolidated: boolean;
  revenue: number | null;
  pat: number | null;
  eps: number | null;
  margin: number | null;
  url: string | null;
}

export interface Filing {
  when: string;
  exchange: "NSE" | "BSE";
  subject: string;
  detail: string | null;
  url: string | null;
}

export interface Facts {
  symbol: string;
  company: string | null;
  industry: string | null;
  bank: boolean;
  price: Fact & { session: string | null };
  /** The canonical quote every surface shares, with its own "as of" stamp and live/end-of-day flag. */
  quote: PriceQuote | null;
  marketCapCr: Fact;
  quarters: Quarter[];
  growth: { revenueYoY: Fact; patYoY: Fact; revenueCagr3y: Fact; patCagr3y: Fact };
  margins: { operating: Fact; net: Fact; gross: Fact };
  returns: { roe: Fact; ret1y: Fact; ret1m: Fact };
  balance: { debtCr: Fact; cashCr: Fact; netDebtCr: Fact; debtToEquity: Fact; interestCover: Fact; period: string | null; url: string | null };
  cash: { cfoCr: Fact; capexCr: Fact; fcfCr: Fact; patCr: Fact; conversion: Fact; period: string | null; url: string | null };
  dividend: { perShare: Fact; yield: Fact; payout: Fact };
  shareholding: { promoter: Fact; fii: Fact; dii: Fact; public: Fact; promoterChange: Fact; fiiChange: Fact; asOf: string | null; url: string | null };
  filings: Filing[];
  actions: { purpose: string; exDate: string | null }[];
  asOf: string;
}

const CR = 1e7;
const r2 = (v: number | null | undefined, d = 2) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d : null);
const f = (value: number | null, unit?: Fact["unit"], period?: string | null, source?: string, url?: string | null): Fact =>
  ({ value: r2(value), unit, period: period ?? null, source, url: url ?? null });

/** Quarterly results on the company's preferred basis, newest first. */
function quarterRows(db: Db, symbol: string, limit = 20): Row[] {
  const rows = db.all("SELECT period_end, consolidated, revenue, pat_owners, pat, eps_basic, net_margin, gross_profit, pbt, finance_costs, depreciation, borrowings, equity, report_format, xbrl_url "
    + "FROM nse_fundamental WHERE symbol = ? AND quality IN ('ok','suspect') ORDER BY period_end DESC, CASE lower(consolidated) WHEN 'consolidated' THEN 0 ELSE 1 END LIMIT ?", [symbol, limit * 2]);
  const seen = new Set<string>();
  return rows.filter((q) => (seen.has(q.period_end) ? false : (seen.add(q.period_end), true))).slice(0, limit);
}

function statementValues(db: Db, symbol: string, kind: "balance_sheet" | "cash_flow", months?: number) {
  const row = db.get<Row>(`SELECT period_end, months, data, xbrl_url FROM nse_statement WHERE symbol = ? AND kind = ?${months ? " AND months = ?" : ""} ORDER BY period_end DESC LIMIT 1`,
    months ? [symbol, kind, months] : [symbol, kind]);
  if (!row) return null;
  try {
    return { period: String(row.period_end), url: (row.xbrl_url as string) ?? null, months: Number(row.months), values: JSON.parse(row.data) as Record<string, number | null> };
  } catch {
    return null;
  }
}

/** Everything known about one company, ready to be quoted with its source. */
export function facts(db: Db, symbol: string): Facts {
  const sym = symbol.toUpperCase();
  const m = db.get<Row>("SELECT * FROM company_metrics WHERE symbol = ?", [sym]) ?? {};
  const qs = quarterRows(db, sym);
  const bank = String(qs[0]?.report_format ?? "") === "bank" || /bank|financial|finance|nbfc|insur/i.test(String(m.industry ?? ""));
  const bs = statementValues(db, sym, "balance_sheet");
  const cf = statementValues(db, sym, "cash_flow", 12);
  const pq = quoteFor(db, sym); // the shared price service, not company_metrics, so every surface agrees

  const quarters: Quarter[] = qs.map((q) => ({
    period: String(q.period_end),
    consolidated: Boolean(q.consolidated),
    revenue: r2(toNum(q.revenue) === null ? null : toNum(q.revenue)! / CR),
    pat: r2((toNum(q.pat_owners) ?? toNum(q.pat)) === null ? null : (toNum(q.pat_owners) ?? toNum(q.pat))! / CR),
    eps: r2(toNum(q.eps_basic)),
    margin: r2(toNum(q.net_margin)),
    url: (q.xbrl_url as string) ?? null,
  }));

  // Year on year compares like quarters (Q1 with Q1), which is how Indian companies report.
  const yoy = (pick: (q: Quarter) => number | null) => (quarters.length >= 5 ? pctChange(pick(quarters[0]), pick(quarters[4])) : null);
  const cagr3 = (pick: (q: Quarter) => number | null) => {
    const latest = quarters.slice(0, 4).reduce((s, q) => s + (pick(q) ?? 0), 0);
    const older = quarters.slice(12, 16);
    if (older.length < 4 || !latest) return null;
    return cagr(latest, older.reduce((s, q) => s + (pick(q) ?? 0), 0), 3);
  };

  const bsv = bs?.values ?? {};
  const debt = bank ? toNum(bsv.borrowings) : (toNum(bsv.borrowings_noncurrent) ?? 0) + (toNum(bsv.borrowings_current) ?? 0);
  const cashOnHand = bank ? (toNum(bsv.cash_rbi) ?? 0) + (toNum(bsv.bank_balances) ?? 0) : (toNum(bsv.cash) ?? 0) + (toNum(bsv.current_investments) ?? 0);
  const ttmPat = quarters.slice(0, 4).length === 4 ? quarters.slice(0, 4).reduce((s, q) => s + (q.pat ?? 0), 0) : null;
  const ttmEbit = qs.slice(0, 4).length === 4 ? qs.slice(0, 4).reduce((s, q) => s + (toNum(q.pbt) ?? 0) + (toNum(q.finance_costs) ?? 0), 0) : null;
  const ttmInterest = qs.slice(0, 4).length === 4 ? qs.slice(0, 4).reduce((s, q) => s + (toNum(q.finance_costs) ?? 0), 0) : null;

  const cfv = cf?.values ?? {};
  const cfo = toNum(cfv.cfo);
  const capex = toNum(cfv.capex);
  const fcf = toNum(cfv.fcf);

  const sh = db.all<Row>("SELECT as_of_date, promoter, fii, dii, public, xbrl_url FROM nse_shareholding_detail WHERE symbol = ? ORDER BY as_of_date DESC LIMIT 5", [sym]);
  const filings = db.all<Row>("SELECT ann_dt, subject, details, pdf_url FROM nse_announcement WHERE symbol = ? ORDER BY ann_dt DESC LIMIT 25", [sym])
    .map((a): Filing => ({ when: String(a.ann_dt), exchange: "NSE", subject: String(a.subject ?? ""), detail: (a.details as string) ?? null, url: (a.pdf_url as string) ?? null }));
  if (m.bse_code) {
    for (const a of db.all<Row>("SELECT news_dt, headline, category, pdf_url FROM announcement WHERE scrip_cd = ? ORDER BY news_dt DESC LIMIT 15", [String(m.bse_code)])) {
      filings.push({ when: String(a.news_dt), exchange: "BSE", subject: String(a.headline ?? ""), detail: (a.category as string) ?? null, url: (a.pdf_url as string) ?? null });
    }
    filings.sort((a, b) => b.when.localeCompare(a.when));
  }

  const actions = db.all<Row>("SELECT purpose, ex_date FROM nse_corp_action WHERE symbol = ? AND ex_date >= date('now', '-2 years') ORDER BY ex_date DESC LIMIT 10", [sym])
    .map((a) => ({ purpose: String(a.purpose), exDate: (a.ex_date as string) ?? null }));

  const epsTtm = toNum(m.eps_ttm);
  const dps = toNum(m.div_ttm);
  const resultPeriod = quarters[0]?.period ?? null;
  const resultUrl = quarters[0]?.url ?? null;

  return {
    symbol: sym,
    company: (m.company as string) ?? null,
    industry: (m.industry as string) ?? null,
    bank,
    price: { ...f(pq?.lastPrice ?? toNum(m.close), "INR", pq?.session ?? null, pq?.source ?? "NSE bhavcopy"), session: pq?.session ?? (m.trade_date as string) ?? null },
    quote: pq,
    marketCapCr: f(toNum(m.market_cap_cr), "INR_CR", null, `market cap (${m.mcap_source ?? "shares × price"})`),
    quarters,
    growth: {
      revenueYoY: f(yoy((q) => q.revenue), "percent", resultPeriod, "quarterly results", resultUrl),
      patYoY: f(yoy((q) => q.pat), "percent", resultPeriod, "quarterly results", resultUrl),
      revenueCagr3y: f(cagr3((q) => q.revenue), "percent", resultPeriod, "quarterly results", resultUrl),
      patCagr3y: f(cagr3((q) => q.pat), "percent", resultPeriod, "quarterly results", resultUrl),
    },
    margins: {
      operating: f(toNum(m.opm_ttm), "percent", resultPeriod, "quarterly results", resultUrl),
      net: f(toNum(m.net_margin_ttm), "percent", resultPeriod, "quarterly results", resultUrl),
      gross: f(toNum(m.gpm_ttm), "percent", resultPeriod, "quarterly results", resultUrl),
    },
    returns: { roe: f(toNum(m.roe), "percent", resultPeriod, "results and balance sheet"), ret1y: f(toNum(m.ret_1y), "percent", null, "prices"), ret1m: f(toNum(m.ret_1m), "percent", null, "prices") },
    balance: {
      debtCr: f(debt === null ? null : debt / CR, "INR_CR", bs?.period, "balance sheet", bs?.url),
      cashCr: f(cashOnHand === null ? null : cashOnHand / CR, "INR_CR", bs?.period, "balance sheet", bs?.url),
      netDebtCr: f(debt === null ? null : (debt - (cashOnHand ?? 0)) / CR, "INR_CR", bs?.period, "balance sheet", bs?.url),
      debtToEquity: f(toNum(m.debt_to_equity), "ratio", bs?.period, "balance sheet", bs?.url),
      // Interest is a lender's cost of funds, not a burden to cover, so the ratio is left out for banks.
      interestCover: f(!bank && ttmEbit !== null && ttmInterest ? ttmEbit / ttmInterest : null, "x", resultPeriod, "quarterly results", resultUrl),
      period: bs?.period ?? null,
      url: bs?.url ?? null,
    },
    cash: {
      cfoCr: f(cfo === null ? null : cfo / CR, "INR_CR", cf?.period, "cash flow statement", cf?.url),
      capexCr: f(capex === null ? null : capex / CR, "INR_CR", cf?.period, "cash flow statement", cf?.url),
      fcfCr: f(fcf === null ? null : fcf / CR, "INR_CR", cf?.period, "cash flow statement", cf?.url),
      patCr: f(ttmPat, "INR_CR", resultPeriod, "quarterly results", resultUrl),
      conversion: f(cfo !== null && ttmPat ? (cfo / CR) / ttmPat * 100 : null, "percent", cf?.period, "cash flow vs results"),
      period: cf?.period ?? null,
      url: cf?.url ?? null,
    },
    dividend: {
      perShare: f(dps, "INR", null, "corporate actions"),
      yield: f(toNum(m.div_yield), "percent", null, "corporate actions and price"),
      payout: f(dps && epsTtm ? (dps / epsTtm) * 100 : null, "percent", resultPeriod, "dividends vs earnings"),
    },
    shareholding: {
      promoter: f(toNum(sh[0]?.promoter), "percent", sh[0]?.as_of_date as string, "shareholding pattern", sh[0]?.xbrl_url as string),
      fii: f(toNum(sh[0]?.fii), "percent", sh[0]?.as_of_date as string, "shareholding pattern", sh[0]?.xbrl_url as string),
      dii: f(toNum(sh[0]?.dii), "percent", sh[0]?.as_of_date as string, "shareholding pattern", sh[0]?.xbrl_url as string),
      public: f(toNum(sh[0]?.public), "percent", sh[0]?.as_of_date as string, "shareholding pattern", sh[0]?.xbrl_url as string),
      promoterChange: f(sh.length >= 2 ? (toNum(sh[0].promoter) ?? 0) - (toNum(sh[1].promoter) ?? 0) : null, "percent", sh[1]?.as_of_date as string, "shareholding pattern"),
      fiiChange: f(sh.length >= 2 ? (toNum(sh[0].fii) ?? 0) - (toNum(sh[1].fii) ?? 0) : null, "percent", sh[1]?.as_of_date as string, "shareholding pattern"),
      asOf: (sh[0]?.as_of_date as string) ?? null,
      url: (sh[0]?.xbrl_url as string) ?? null,
    },
    filings: filings.slice(0, 25),
    actions,
    asOf: new Date().toISOString(),
  };
}

/** Median of a numeric field across an industry, for peer comparisons in answers. */
export function industryMedian(db: Db, industry: string | null, column: string): number | null {
  if (!industry) return null;
  const rows = db.all<{ v: number | null }>(`SELECT ${column} AS v FROM company_metrics WHERE industry = ? AND ${column} IS NOT NULL`, [industry]);
  return r2(median(rows.map((r) => r.v)));
}
