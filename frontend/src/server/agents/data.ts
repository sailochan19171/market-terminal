// The data agent (spec §3.3): fetch once, normalise, and let every other agent read the same numbers.
//
// Nothing downstream knows where a figure came from or what the filing called it. Quarterly XBRL results are
// summed into fiscal years, the balance sheet and cash-flow statements are matched to those years, and every
// field carries the internal name from §5.2 - so a US provider can be added later behind the same shape without
// touching a single ratio.
import type { Db, Row } from "../db";
import { adjuster, priceRows, resolve } from "../core/analysis";
import { quoteFor } from "../core/price";
import { fiscalYear } from "../core/metrics";
import { median, toNum } from "../util";
import { fieldMapping } from "./config";
import type { AnnualFigures, RawData, SectorSet, Unavailable } from "./state";
import { ownershipReport, type OwnershipReport } from "./ownership";

const FINANCIAL = /bank|financial|finance|nbfc|insur|lending|housing finance/i;

const n = (v: unknown): number | null => {
  const x = toNum(v);
  return x === null || !Number.isFinite(x) ? null : x;
};
/** A fiscal-year total: all four quarters must carry the figure, or the total is not known. */
const sum = (values: (number | null)[]): number | null =>
  values.length === 4 && values.every((v) => v !== null) ? (values as number[]).reduce((s, v) => s + v, 0) : null;
/** For lines a filer leaves blank when they are nil (finance costs at a debt-free company): blanks count as zero. */
const sumNil = (values: (number | null)[]): number | null =>
  values.some((v) => v !== null) ? values.reduce<number>((s, v) => s + (v ?? 0), 0) : null;

/** Diluted EPS, falling back to basic. Some filings put 0 in the diluted field when they mean "not given". */
const epsOf = (q: Row): number | null => {
  const diluted = n(q.eps_diluted);
  const basic = n(q.eps_basic);
  return diluted !== null && !(diluted === 0 && basic !== null && basic !== 0) ? diluted : basic;
};

/** Quarterly results on one basis, consolidated preferred, newest first. */
function quarters(db: Db, symbol: string): Row[] {
  const rows = db.all<Row>(
    `SELECT period_end, consolidated, revenue, other_income, total_expenses, cogs, gross_profit, pbt, pat, pat_owners,
            eps_basic, eps_diluted, finance_costs, depreciation, tax, shares, equity, borrowings, total_assets, report_format, xbrl_url
     FROM nse_fundamental WHERE symbol = ? AND quality IN ('ok','suspect')
     ORDER BY period_end DESC, CASE lower(consolidated) WHEN 'consolidated' THEN 0 ELSE 1 END LIMIT 120`, [symbol]);
  const seen = new Set<string>();
  return rows.filter((r) => (seen.has(String(r.period_end)) ? false : (seen.add(String(r.period_end)), true)));
}

function statements(db: Db, symbol: string, kind: "balance_sheet" | "cash_flow"): Map<number, { values: Record<string, number | null>; url: string | null; periodEnd: string }> {
  const out = new Map<number, { values: Record<string, number | null>; url: string | null; periodEnd: string }>();
  const rows = db.all<Row>(
    `SELECT period_end, months, data, xbrl_url FROM nse_statement WHERE symbol = ? AND kind = ?
     ${kind === "cash_flow" ? "AND months = 12" : ""} ORDER BY period_end DESC`, [symbol, kind]);
  for (const r of rows) {
    const end = String(r.period_end);
    // Only March year-ends are a full Indian fiscal year; September rows are the half-year statement.
    if (!end.startsWith(`${end.slice(0, 4)}-03`)) continue;
    const fy = fiscalYear(end);
    if (fy === null || out.has(fy)) continue;
    try {
      out.set(fy, { values: JSON.parse(String(r.data)) as Record<string, number | null>, url: (r.xbrl_url as string) ?? null, periodEnd: end });
    } catch { /* a statement that will not parse is simply absent */ }
  }
  return out;
}

/** Everything one request needs about one company, fetched once (spec §3.3). */
export function loadRawData(db: Db, symbol: string, years = 10): RawData {
  const sym = symbol.toUpperCase();
  const m = db.get<Row>("SELECT * FROM company_metrics WHERE symbol = ?", [sym]) ?? {};
  const industry = (m.industry as string | null) ?? null;
  const qs = quarters(db, sym);
  const format = String(qs[0]?.report_format ?? "");
  const sectorSet: SectorSet = format === "bank" || FINANCIAL.test(industry ?? "") ? "financial" : "standard";
  const unavailable: Unavailable[] = [];

  // Per-share history restated for bonuses and splits (spec §5.4: ratios use restated values). A filing made
  // after a bonus often restates the earlier quarter itself, so the date alone cannot decide: the share count
  // implied by each quarter (profit ÷ EPS) has to show the jump.
  let adj: ReturnType<typeof adjuster> | null = null;
  try {
    adj = adjuster(db, resolve(db, sym));
  } catch { /* no identity, no corporate actions */ }
  const implied = (q: Row) => {
    const profit = n(q.pat_owners) ?? n(q.pat);
    const eps = epsOf(q);
    return profit !== null && eps ? profit / eps : null;
  };
  // Walk from the newest quarter back. Where a bonus or split falls between two quarters and the share count
  // implied by the older one jumps by that factor, the older figures were not restated: carry the factor back
  // from there. Real dilution with no corporate action (a merger, a QIP) is left as it is.
  let restated = 0;
  let multiplier = 1;
  for (let i = 1; i < qs.length && adj?.active; i++) {
    const step = adj.factor(String(qs[i].period_end)) / adj.factor(String(qs[i - 1].period_end));
    if (step !== 1) {
      const newer = implied(qs[i - 1]);
      const older = implied(qs[i]);
      // `newer` has already been restated by `multiplier`; undo that to compare the counts as filed.
      if (newer !== null && older !== null && older > 0 && Math.abs((newer * multiplier) / older - 1 / step) / (1 / step) < 0.25) multiplier *= step;
    }
    if (multiplier === 1) continue;
    restated++;
    qs[i].__eps_as_filed = epsOf(qs[i]);
    qs[i].__shares_as_filed = n(qs[i].shares);
    for (const k of ["eps_diluted", "eps_basic"]) if (n(qs[i][k]) !== null) qs[i][k] = n(qs[i][k])! * multiplier;
    if (n(qs[i].shares) !== null) qs[i].shares = n(qs[i].shares)! / multiplier;
  }

  const balance = statements(db, sym, "balance_sheet");
  const cashFlow = statements(db, sym, "cash_flow");

  // Group quarters into fiscal years; a year needs all four to be summed honestly.
  const byYear = new Map<number, Row[]>();
  for (const q of qs) {
    const fy = fiscalYear(String(q.period_end));
    if (fy === null) continue;
    byYear.set(fy, [...(byYear.get(fy) ?? []), q]);
  }

  const bank = sectorSet === "financial";
  const map = fieldMapping("in_xbrl") as Record<string, Record<string, string[]>>;
  /** The first mapped key present in a statement (config/field_mapping/in_xbrl.yaml). */
  const pick = (values: Record<string, number | null>, section: "balance_sheet" | "cash_flow", field: string): number | null => {
    for (const key of map[section]?.[field] ?? [field]) {
      const v = n(values[key]);
      if (v !== null) return v;
    }
    return null;
  };
  const has = (values: Record<string, number | null>, section: "balance_sheet" | "cash_flow", field: string) =>
    (map[section]?.[field] ?? [field]).some((k) => values[k] !== undefined && values[k] !== null);

  /** Four quarters plus the balance sheet and cash flow that go with them, in the internal schema. */
  const figures = (year: number, rows: Row[], bv: Record<string, number | null>, cv: Record<string, number | null>, urls: AnnualFigures["sources"]): AnnualFigures => {
    const bsv = (f: string) => pick(bv, "balance_sheet", f);
    const cfv = (f: string) => pick(cv, "cash_flow", f);
    const revenue = sum(rows.map((r) => n(r.revenue)));
    const interestExpense = sumNil(rows.map((r) => n(r.finance_costs)));
    const pbt = sum(rows.map((r) => n(r.pbt)));
    const depreciation = sumNil(rows.map((r) => n(r.depreciation)));
    const otherIncome = sumNil(rows.map((r) => n(r.other_income)));
    const totalExpenses = sum(rows.map((r) => n(r.total_expenses)));
    // A lender's interest cost is the cost of its raw material, so it is not added back into operating profit.
    const ebit = pbt === null ? null : bank ? pbt : pbt + (interestExpense ?? 0);
    const totalDebt = bank
      ? bsv("borrowings")
      : !has(bv, "balance_sheet", "borrowings_noncurrent") && !has(bv, "balance_sheet", "borrowings_current") ? null : (bsv("borrowings_noncurrent") ?? 0) + (bsv("borrowings_current") ?? 0);
    const eps = sum(rows.map(epsOf));
    const filedEps = sum(rows.map((r) => (r.__eps_as_filed === undefined ? epsOf(r) : n(r.__eps_as_filed))));
    return {
      year,
      periodEnd: String(rows[0].period_end),
      consolidated: String(rows[0].consolidated ?? "").toLowerCase() === "consolidated",
      revenue,
      costOfGoodsSold: sum(rows.map((r) => n(r.cogs))),
      grossProfit: sum(rows.map((r) => n(r.gross_profit))),
      // Operating income and EBITDA leave out other income (treasury gains, interest received), as the companies
      // themselves report them; EBIT keeps it, because it is what covers interest.
      operatingIncome: ebit === null ? null : bank ? ebit : ebit - (otherIncome ?? 0),
      ebit,
      ebitda: ebit === null ? null : (bank ? ebit : ebit - (otherIncome ?? 0)) + (depreciation ?? 0),
      interestExpense,
      taxExpense: sum(rows.map((r) => n(r.tax))),
      netIncome: sum(rows.map((r) => n(r.pat_owners) ?? n(r.pat))),
      epsDiluted: eps,
      sharesDiluted: n(rows[0].shares),
      depreciation,
      cash: bank ? (bsv("bank_cash") ?? 0) + (bsv("bank_balances") ?? 0) || null : (bsv("cash") ?? 0) + (bsv("current_investments") ?? 0) || null,
      receivables: bsv("receivables"),
      inventory: bsv("inventory"),
      currentAssets: bsv("current_assets"),
      totalAssets: bsv("total_assets"),
      payables: bsv("payables"),
      currentLiabilities: bsv("current_liabilities"),
      totalDebt,
      totalLiabilities: bsv("total_liabilities"),
      shareholdersEquity: bsv("shareholders_equity") ?? ((bsv("share_capital") ?? 0) + (bsv("reserves") ?? 0) || null),
      operatingCashFlow: cfv("operating_cash_flow"),
      capitalExpenditure: cfv("capital_expenditure"),
      dividendsPaid: cfv("dividends_paid"),
      shareBuybacks: cfv("share_buybacks"),
      // A bank's "revenue" in these filings is interest earned; what it pays out is the finance cost.
      netInterestIncome: bank && revenue !== null && interestExpense !== null ? revenue - interestExpense : null,
      interestEarningAssets: bank ? (bsv("advances") ?? 0) + (bsv("investments") ?? 0) || null : null,
      advances: bank ? bsv("advances") : null,
      deposits: bank ? bsv("deposits") : null,
      otherIncome,
      operatingExpenses: bank && totalExpenses !== null && interestExpense !== null ? totalExpenses - interestExpense : null,
      sources: urls,
      asReported: filedEps !== null && eps !== null && Math.abs(filedEps - eps) > 1e-6
        ? { epsDiluted: filedEps, sharesDiluted: n(rows[0].__shares_as_filed ?? rows[0].shares) }
        : null,
    };
  };

  const annual: AnnualFigures[] = [];
  // A year still in progress (one or two quarters filed) is not a fiscal year; it would blank every "latest" ratio.
  const inProgress = [...byYear.entries()].filter(([, rows]) => rows.length < 4).map(([y]) => y);
  for (const [year, rows] of [...byYear.entries()].filter(([, r]) => r.length === 4).sort((a, b) => b[0] - a[0]).slice(0, years)) {
    const bs = balance.get(year);
    const cf = cashFlow.get(year);
    annual.push(figures(year, rows, bs?.values ?? {}, cf?.values ?? {}, { income: (rows[0].xbrl_url as string) ?? null, balance: bs?.url ?? null, cashFlow: cf?.url ?? null }));
  }

  // The last eight quarters (spec §3.3) and a trailing-twelve-month year from the latest four, when those four
  // are consecutive. The balance sheet is the latest year-end; cash flow is filed only for the year, so TTM leaves it out.
  const quarterly: RawData["quarterly"] = qs.slice(0, 8).map((q) => ({
    periodEnd: String(q.period_end), revenue: n(q.revenue), netIncome: n(q.pat_owners) ?? n(q.pat), epsDiluted: epsOf(q),
    operatingIncome: n(q.pbt) === null ? null : n(q.pbt)! + (bank ? 0 : (n(q.finance_costs) ?? 0) - (n(q.other_income) ?? 0)), source: (q.xbrl_url as string) ?? null,
  }));
  let ttm: AnnualFigures | null = null;
  const last4 = qs.slice(0, 4);
  const DAY = 86_400_000;
  const consecutive = last4.length === 4 && last4.every((q, i) => i === 0
    || Math.abs(new Date(String(last4[i - 1].period_end)).getTime() - new Date(String(q.period_end)).getTime() - 91.5 * DAY) < 20 * DAY);
  if (consecutive && annual.length && String(last4[0].period_end) > annual[0].periodEnd) {
    const bs = balance.get(annual[0].year);
    ttm = {
      ...figures(annual[0].year + 1, last4, bs?.values ?? {}, {}, { income: (last4[0].xbrl_url as string) ?? null, balance: bs?.url ?? null, cashFlow: null }),
      periodEnd: String(last4[0].period_end),
    };
  }

  if (restated) unavailable.push({ key: "restated_per_share", reason: `EPS and share counts for ${restated} quarter${restated > 1 ? "s" : ""} restated for bonus or split issues (not missing; noted for transparency)` });
  const gapYears = inProgress.filter((y) => annual.some((a) => a.year > y));
  if (gapYears.length) unavailable.push({ key: "incomplete_years", reason: `FY${gapYears.join(", FY")} ${gapYears.length > 1 ? "have" : "has"} fewer than four quarters on record and ${gapYears.length > 1 ? "are" : "is"} left out` });
  if (!annual.length) unavailable.push({ key: "annual_statements", reason: "no parsed results on record for this company" });
  if (annual.length < years) unavailable.push({ key: "history_depth", reason: `${annual.length} fiscal years on record, fewer than the ${years} the analysis asks for` });
  if (sectorSet === "financial") {
    for (const key of ["gross_npa", "net_npa", "provision_coverage", "capital_adequacy_ratio", "casa_deposits"]) {
      unavailable.push({ key, reason: "not reported in the XBRL filings; it appears only in the results annexure, which is not parsed yet" });
    }
  }

  const quote = quoteFor(db, sym);
  const pricesFrom = new Date(Date.now() - years * 365 * 86_400_000).toISOString().slice(0, 10);
  // Adjusted for splits and bonuses, so a five-year return is not halved by a 1:1 bonus issue.
  let prices: { t: string; c: number }[] = [];
  let filings: RawData["filings"] = [];
  try {
    const identity = resolve(db, sym);
    prices = priceRows(db, identity, "NSE", pricesFrom, null, adjuster(db, identity)).map((b) => ({ t: b.t, c: b.c }));
    const since = new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10);
    filings = db.all<Row>("SELECT ann_dt, subject, details, pdf_url FROM nse_announcement WHERE symbol = ? AND ann_dt >= ? ORDER BY ann_dt DESC LIMIT 150", [sym, since])
      .map((r) => ({ when: String(r.ann_dt), title: String(r.subject ?? "").trim(), detail: (r.details as string | null) ?? null, url: (r.pdf_url as string | null) ?? null, source: "NSE announcement" }));
    if (identity.bseCode) {
      filings.push(...db.all<Row>("SELECT news_dt, headline, category, pdf_url FROM announcement WHERE scrip_cd = ? AND news_dt >= ? ORDER BY news_dt DESC LIMIT 150", [identity.bseCode, since])
        .map((r) => ({ when: String(r.news_dt), title: String(r.headline ?? "").trim(), detail: (r.category as string | null) ?? null, url: (r.pdf_url as string | null) ?? null, source: "BSE filing" })));
    }
    filings.sort((a, b) => b.when.localeCompare(a.when));
  } catch {
    unavailable.push({ key: "prices", reason: "the company could not be resolved to an exchange listing" });
  }
  if (!filings.length) unavailable.push({ key: "news", reason: "no exchange filings in the last 90 days" });

  // Who owns the company: the quarterly shareholding patterns and insider dealings already on record. A US
  // ticker could collide with an NSE symbol, so this is read for Indian listings only.
  let ownership: OwnershipReport | null = null;
  try {
    ownership = ownershipReport(db, sym);
    unavailable.push(...ownership.unavailable);
  } catch (e) {
    unavailable.push({ key: "shareholding", reason: `the shareholding pattern could not be read: ${(e as Error).message}` });
  }

  // The close on the last session of each fiscal year, as traded - not adjusted - so it pairs with the EPS and
  // share count that were reported at the time (spec §4.3: historical years use the fiscal year-end price).
  const yearEndPrices: Record<number, number> = {};
  for (const a of annual) {
    const row = db.get<{ c: number }>(
      "SELECT close c FROM nse_bhavcopy WHERE symbol = ? AND series IN ('EQ','BE','BZ') AND trade_date <= ? AND trade_date >= ? AND close > 0 ORDER BY trade_date DESC LIMIT 1",
      [sym, `${a.year}-03-31`, `${a.year}-03-01`]);
    if (row) yearEndPrices[a.year] = Number(row.c);
  }
  const peerRows = industry
    ? db.all<{ pe: number | null; pb: number | null }>("SELECT pe, pb FROM company_metrics WHERE industry = ? AND symbol != ? AND close IS NOT NULL", [industry, sym])
    : [];
  const positive = (xs: (number | null)[], cap: number) => xs.map((v) => n(v)).filter((v): v is number => v !== null && v > 0 && v < cap);
  const peerMultiples = {
    count: peerRows.length,
    pe: peerRows.length >= 5 ? median(positive(peerRows.map((r) => r.pe), 200)) : null,
    pb: peerRows.length >= 5 ? median(positive(peerRows.map((r) => r.pb), 30)) : null,
  };
  const peers = industry
    ? db.all<{ symbol: string }>("SELECT symbol FROM company_metrics WHERE industry = ? AND symbol != ? AND close IS NOT NULL ORDER BY market_cap_cr DESC NULLS LAST LIMIT 30", [industry, sym]).map((r) => r.symbol)
    : [];

  const now = new Date().toISOString();
  return {
    symbol: sym,
    company: (m.company as string | null) ?? null,
    market: "IN",
    currency: "INR",
    exchange: "NSE",
    ticker: `${sym}.NS`,
    fiscalYearEnd: "03-31",
    quarterly,
    ttm,
    industry,
    sectorSet,
    quote,
    marketCap: n(m.market_cap_cr) === null ? null : n(m.market_cap_cr)! * 1e7,
    sharesOutstanding: n(m.shares),
    referencePe: n(m.pe),
    bookValuePerShare: n(m.bvps),
    dividendPerShare: n(m.div_ttm),
    annual,
    prices,
    yearEndPrices,
    peerMultiples,
    filings,
    ownership,
    peers,
    fetchedAt: now,
    sources: [
      { dataset: "results", source: `NSE XBRL result filings (${annual[0] && !annual[0].consolidated ? "standalone - no consolidated results filed" : "consolidated"})`, fetchedAt: String(m.updated_at ?? now) },
      { dataset: "balance_sheet", source: "NSE XBRL annual filings", fetchedAt: String(m.updated_at ?? now) },
      { dataset: "cash_flow", source: "NSE XBRL annual filings", fetchedAt: String(m.updated_at ?? now) },
      { dataset: "prices", source: quote?.source ?? "NSE bhavcopy", fetchedAt: quote?.asOfTimestamp ?? now },
      { dataset: "peers", source: `company_metrics, ${peers.length} companies in ${industry ?? "no industry"}`, fetchedAt: String(m.updated_at ?? now) },
    ],
    unavailable,
  };
}
