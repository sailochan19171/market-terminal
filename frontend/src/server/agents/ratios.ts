// The ratio engine (spec §4). Plain code, no model anywhere near it.
//
// Every ratio follows the same rules: average balances where the formula says "avg", a null with a stated
// reason rather than a zero or an infinity when a denominator is missing, decimals rather than percentages,
// and each year carrying the raw numbers it was computed from so any figure can be checked by hand.
import type { Db } from "../db";
import { median } from "../util";
import { scoring } from "./config";
import type { AnnualFigures, RatioPoint, RatioReport, RatioSeries, RawData, QualityScores, Unavailable } from "./state";

type Getter = (y: AnnualFigures, prev: AnnualFigures | undefined) => { value: number | null; reason?: string; inputs: Record<string, number | null> };
interface Spec { id: string; key: string; label: string; unit: RatioSeries["unit"]; category: string; higherIsBetter: boolean; get: Getter }

/** Divide, but say why when it cannot be done (spec §4.1). */
function ratio(numerator: number | null, denominator: number | null, inputs: Record<string, number | null>, reason = "missing_input"):
{ value: number | null; reason?: string; inputs: Record<string, number | null> } {
  if (numerator === null || denominator === null) return { value: null, reason, inputs };
  if (denominator === 0) return { value: null, reason: "zero_denominator", inputs };
  return { value: numerator / denominator, inputs };
}

/** The average of the opening and closing balance, which is what a turnover or return ratio is measured against. */
const avg = (now: number | null, before: number | null | undefined): number | null =>
  now === null ? null : before === null || before === undefined ? now : (now + before) / 2;

const SPECS: Spec[] = [
  // --- profitability ---------------------------------------------------------------------
  { id: "gross_margin_v1", key: "grossMargin", label: "Gross margin", unit: "percent", category: "profitability", higherIsBetter: true,
    get: (y) => ratio(y.grossProfit, y.revenue, { gross_profit: y.grossProfit, revenue: y.revenue }) },
  { id: "operating_margin_v1", key: "operatingMargin", label: "Operating margin", unit: "percent", category: "profitability", higherIsBetter: true,
    get: (y) => ratio(y.operatingIncome, y.revenue, { operating_income: y.operatingIncome, revenue: y.revenue }) },
  { id: "net_margin_v1", key: "netMargin", label: "Net profit margin", unit: "percent", category: "profitability", higherIsBetter: true,
    get: (y) => ratio(y.netIncome, y.revenue, { net_income: y.netIncome, revenue: y.revenue }) },
  { id: "ebitda_margin_v1", key: "ebitdaMargin", label: "EBITDA margin", unit: "percent", category: "profitability", higherIsBetter: true,
    get: (y) => ratio(y.ebitda, y.revenue, { ebitda: y.ebitda, revenue: y.revenue }) },
  { id: "roe_v1", key: "roe", label: "Return on equity", unit: "percent", category: "profitability", higherIsBetter: true,
    get: (y, p) => {
      const equity = avg(y.shareholdersEquity, p?.shareholdersEquity);
      if (equity !== null && equity < 0) return { value: null, reason: "negative_equity", inputs: { net_income: y.netIncome, avg_equity: equity } };
      return ratio(y.netIncome, equity, { net_income: y.netIncome, avg_equity: equity });
    } },
  { id: "roa_v1", key: "roa", label: "Return on assets", unit: "percent", category: "profitability", higherIsBetter: true,
    get: (y, p) => ratio(y.netIncome, avg(y.totalAssets, p?.totalAssets), { net_income: y.netIncome, avg_total_assets: avg(y.totalAssets, p?.totalAssets) }) },
  { id: "roce_v1", key: "roce", label: "Return on capital employed", unit: "percent", category: "profitability", higherIsBetter: true,
    get: (y) => {
      const capital = y.totalAssets === null || y.currentLiabilities === null ? null : y.totalAssets - y.currentLiabilities;
      return ratio(y.ebit, capital, { ebit: y.ebit, total_assets: y.totalAssets, current_liabilities: y.currentLiabilities });
    } },
  { id: "roic_v1", key: "roic", label: "Return on invested capital", unit: "percent", category: "profitability", higherIsBetter: true,
    get: (y) => {
      const taxRate = y.taxExpense !== null && y.ebit !== null && y.ebit !== 0 && y.taxExpense >= 0
        ? Math.min(0.6, y.taxExpense / Math.max(1, y.ebit - (y.interestExpense ?? 0)))
        : 0.25;
      const nopat = y.ebit === null ? null : y.ebit * (1 - taxRate);
      const invested = y.shareholdersEquity === null ? null : (y.totalDebt ?? 0) + y.shareholdersEquity - (y.cash ?? 0);
      return ratio(nopat, invested, { ebit: y.ebit, tax_rate: taxRate, total_debt: y.totalDebt, equity: y.shareholdersEquity, cash: y.cash });
    } },

  // --- liquidity -------------------------------------------------------------------------
  { id: "current_ratio_v1", key: "currentRatio", label: "Current ratio", unit: "times", category: "liquidity", higherIsBetter: true,
    get: (y) => ratio(y.currentAssets, y.currentLiabilities, { current_assets: y.currentAssets, current_liabilities: y.currentLiabilities }) },
  { id: "quick_ratio_v1", key: "quickRatio", label: "Quick ratio", unit: "times", category: "liquidity", higherIsBetter: true,
    get: (y) => ratio(y.currentAssets === null ? null : y.currentAssets - (y.inventory ?? 0), y.currentLiabilities,
      { current_assets: y.currentAssets, inventory: y.inventory, current_liabilities: y.currentLiabilities }) },
  { id: "cash_ratio_v1", key: "cashRatio", label: "Cash ratio", unit: "times", category: "liquidity", higherIsBetter: true,
    get: (y) => ratio(y.cash, y.currentLiabilities, { cash: y.cash, current_liabilities: y.currentLiabilities }) },
  { id: "ocf_ratio_v1", key: "operatingCashFlowRatio", label: "Operating cash flow ratio", unit: "times", category: "liquidity", higherIsBetter: true,
    get: (y) => ratio(y.operatingCashFlow, y.currentLiabilities, { operating_cash_flow: y.operatingCashFlow, current_liabilities: y.currentLiabilities }) },

  // --- solvency --------------------------------------------------------------------------
  { id: "debt_to_equity_v1", key: "debtToEquity", label: "Debt to equity", unit: "times", category: "solvency", higherIsBetter: false,
    get: (y) => {
      if (y.shareholdersEquity !== null && y.shareholdersEquity < 0) return { value: null, reason: "negative_equity", inputs: { total_debt: y.totalDebt, equity: y.shareholdersEquity } };
      return ratio(y.totalDebt, y.shareholdersEquity, { total_debt: y.totalDebt, equity: y.shareholdersEquity });
    } },
  { id: "debt_to_assets_v1", key: "debtToAssets", label: "Debt to assets", unit: "times", category: "solvency", higherIsBetter: false,
    get: (y) => ratio(y.totalDebt, y.totalAssets, { total_debt: y.totalDebt, total_assets: y.totalAssets }) },
  { id: "interest_cover_v1", key: "interestCoverage", label: "Interest coverage", unit: "times", category: "solvency", higherIsBetter: true,
    get: (y) => ratio(y.ebit, y.interestExpense, { ebit: y.ebit, interest_expense: y.interestExpense }) },
  { id: "net_debt_ebitda_v1", key: "netDebtToEbitda", label: "Net debt to EBITDA", unit: "times", category: "solvency", higherIsBetter: false,
    get: (y) => ratio(y.totalDebt === null ? null : y.totalDebt - (y.cash ?? 0), y.ebitda, { total_debt: y.totalDebt, cash: y.cash, ebitda: y.ebitda }) },
  { id: "equity_multiplier_v1", key: "equityMultiplier", label: "Equity multiplier", unit: "times", category: "solvency", higherIsBetter: false,
    get: (y) => ratio(y.totalAssets, y.shareholdersEquity, { total_assets: y.totalAssets, equity: y.shareholdersEquity }) },

  // --- efficiency ------------------------------------------------------------------------
  { id: "asset_turnover_v1", key: "assetTurnover", label: "Asset turnover", unit: "times", category: "efficiency", higherIsBetter: true,
    get: (y, p) => ratio(y.revenue, avg(y.totalAssets, p?.totalAssets), { revenue: y.revenue, avg_total_assets: avg(y.totalAssets, p?.totalAssets) }) },
  { id: "inventory_turnover_v1", key: "inventoryTurnover", label: "Inventory turnover", unit: "times", category: "efficiency", higherIsBetter: true,
    get: (y, p) => ratio(y.costOfGoodsSold, avg(y.inventory, p?.inventory), { cogs: y.costOfGoodsSold, avg_inventory: avg(y.inventory, p?.inventory) }, "missing_inventory") },
  { id: "receivables_turnover_v1", key: "receivablesTurnover", label: "Receivables turnover", unit: "times", category: "efficiency", higherIsBetter: true,
    get: (y, p) => ratio(y.revenue, avg(y.receivables, p?.receivables), { revenue: y.revenue, avg_receivables: avg(y.receivables, p?.receivables) }) },
  { id: "dso_v1", key: "daysSalesOutstanding", label: "Days sales outstanding", unit: "days", category: "efficiency", higherIsBetter: false,
    get: (y, p) => {
      const turns = ratio(y.revenue, avg(y.receivables, p?.receivables), {});
      return { value: turns.value === null || turns.value === 0 ? null : 365 / turns.value, reason: turns.reason, inputs: { revenue: y.revenue, avg_receivables: avg(y.receivables, p?.receivables) } };
    } },
  { id: "dio_v1", key: "daysInventoryOutstanding", label: "Days inventory outstanding", unit: "days", category: "efficiency", higherIsBetter: false,
    get: (y, p) => {
      const turns = ratio(y.costOfGoodsSold, avg(y.inventory, p?.inventory), {});
      return { value: turns.value === null || turns.value === 0 ? null : 365 / turns.value, reason: turns.reason ?? undefined, inputs: { cogs: y.costOfGoodsSold, avg_inventory: avg(y.inventory, p?.inventory) } };
    } },
  { id: "dpo_v1", key: "daysPayablesOutstanding", label: "Days payables outstanding", unit: "days", category: "efficiency", higherIsBetter: true,
    get: (y, p) => {
      const payables = avg(y.payables, p?.payables);
      const r = ratio(payables === null ? null : 365 * payables, y.costOfGoodsSold, { avg_payables: payables, cogs: y.costOfGoodsSold });
      return r;
    } },

  { id: "ccc_v1", key: "cashConversionCycle", label: "Cash conversion cycle", unit: "days", category: "efficiency", higherIsBetter: false,
    get: (y, p) => {
      const receivables = avg(y.receivables, p?.receivables);
      const inventory = avg(y.inventory, p?.inventory);
      const payables = avg(y.payables, p?.payables);
      const inputs = { revenue: y.revenue, cogs: y.costOfGoodsSold, avg_receivables: receivables, avg_inventory: inventory, avg_payables: payables };
      if (!y.revenue || !y.costOfGoodsSold || receivables === null || inventory === null || payables === null) return { value: null, reason: "missing_input", inputs };
      return { value: (365 * receivables) / y.revenue + (365 * inventory) / y.costOfGoodsSold - (365 * payables) / y.costOfGoodsSold, inputs };
    } },

  // --- cash flow quality -----------------------------------------------------------------
  { id: "fcf_v1", key: "freeCashFlow", label: "Free cash flow", unit: "currency", category: "cashFlow", higherIsBetter: true,
    get: (y) => ({
      value: y.operatingCashFlow === null ? null : y.operatingCashFlow - Math.abs(y.capitalExpenditure ?? 0),
      reason: y.operatingCashFlow === null ? "missing_operating_cash_flow" : undefined,
      inputs: { operating_cash_flow: y.operatingCashFlow, capital_expenditure: y.capitalExpenditure },
    }) },
  { id: "fcf_margin_v1", key: "fcfMargin", label: "Free cash flow margin", unit: "percent", category: "cashFlow", higherIsBetter: true,
    get: (y) => ratio(y.operatingCashFlow === null ? null : y.operatingCashFlow - Math.abs(y.capitalExpenditure ?? 0), y.revenue,
      { operating_cash_flow: y.operatingCashFlow, capital_expenditure: y.capitalExpenditure, revenue: y.revenue }) },
  { id: "cash_conversion_v1", key: "cashConversion", label: "Cash conversion", unit: "percent", category: "cashFlow", higherIsBetter: true,
    get: (y) => ratio(y.operatingCashFlow, y.netIncome, { operating_cash_flow: y.operatingCashFlow, net_income: y.netIncome }) },
  { id: "capex_intensity_v1", key: "capexIntensity", label: "Capex intensity", unit: "percent", category: "cashFlow", higherIsBetter: false,
    get: (y) => ratio(y.capitalExpenditure === null ? null : Math.abs(y.capitalExpenditure), y.revenue, { capital_expenditure: y.capitalExpenditure, revenue: y.revenue }) },

  // --- dividends -------------------------------------------------------------------------
  { id: "payout_ratio_v1", key: "payoutRatio", label: "Payout ratio", unit: "percent", category: "dividends", higherIsBetter: false,
    get: (y) => ratio(y.dividendsPaid === null ? null : Math.abs(y.dividendsPaid), y.netIncome, { dividends_paid: y.dividendsPaid, net_income: y.netIncome }) },

  // --- financial sector (spec §4.4) ------------------------------------------------------
  { id: "nim_v1", key: "netInterestMargin", label: "Net interest margin", unit: "percent", category: "financial", higherIsBetter: true,
    get: (y, p) => ratio(y.netInterestIncome, avg(y.interestEarningAssets, p?.interestEarningAssets),
      { net_interest_income: y.netInterestIncome, avg_interest_earning_assets: avg(y.interestEarningAssets, p?.interestEarningAssets) }) },
  { id: "cost_to_income_v1", key: "costToIncome", label: "Cost to income", unit: "percent", category: "financial", higherIsBetter: false,
    get: (y) => ratio(y.operatingExpenses, y.netInterestIncome === null ? null : y.netInterestIncome + (y.otherIncome ?? 0),
      { operating_expenses: y.operatingExpenses, net_interest_income: y.netInterestIncome, other_income: y.otherIncome }) },
  { id: "credit_deposit_v1", key: "creditToDeposit", label: "Credit to deposit", unit: "percent", category: "financial", higherIsBetter: false,
    get: (y) => ratio(y.advances, y.deposits, { advances: y.advances, deposits: y.deposits }) },
];

const STANDARD_ONLY = new Set(["profitability", "liquidity", "solvency", "efficiency", "cashFlow"]);
const FINANCIAL_ONLY = new Set(["financial"]);
/** Standard-set ratios that also belong to the financial set (spec §4.4: "ROA / ROE - same formulas as 4.3"). */
const SHARED_WITH_FINANCIAL = new Set(["roe", "roa", "payoutRatio", "equityMultiplier"]);

/** Least-squares slope over the last five points, used only for its sign (spec §4.5). */
function slope(values: number[]): number | null {
  if (values.length < 3) return null;
  const n = values.length;
  const meanX = (n - 1) / 2;
  const meanY = values.reduce((s, v) => s + v, 0) / n;
  let num = 0, den = 0;
  values.forEach((v, i) => {
    num += (i - meanX) * (v - meanY);
    den += (i - meanX) ** 2;
  });
  return den === 0 ? null : num / den;
}

const std = (values: number[]): number | null => {
  if (values.length < 2) return null;
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  return Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / (values.length - 1));
};

/** Percentile of a value within a set of peers (spec §4.5). */
const percentile = (value: number, pool: number[]): number =>
  Math.round((pool.filter((v) => v <= value).length / pool.length) * 1000) / 10;

function buildSeries(spec: Spec, annual: AnnualFigures[], threshold: number | null, ttm: AnnualFigures | null = null): RatioSeries {
  const oldestFirst = [...annual].sort((a, b) => a.year - b.year);
  const series: RatioPoint[] = oldestFirst.map((y, i) => {
    const out = spec.get(y, oldestFirst[i - 1]);
    return { year: y.year, value: out.value === null || !Number.isFinite(out.value) ? null : out.value, reason: out.reason, inputs: out.inputs };
  });
  const values = series.map((p) => p.value).filter((v): v is number => v !== null);
  const last5 = series.slice(-5).map((p) => p.value).filter((v): v is number => v !== null);
  const med = values.length ? median(values) : null;
  const s = slope(last5);
  // "Stable" when the drift across the window is inside ±5% of the median (spec §4.5).
  let trend: RatioSeries["trend"] = null;
  if (s !== null && med !== null && med !== 0) {
    const drift = (s * (last5.length - 1)) / Math.abs(med);
    trend = Math.abs(drift) <= 0.05 ? "stable" : (s > 0) === spec.higherIsBetter ? "improving" : "declining";
  }
  // The same formula on trailing-twelve-month figures, against the latest year-end as the opening balance.
  let ttmPoint: RatioPoint | null = null;
  if (ttm && oldestFirst.length) {
    const out = spec.get(ttm, oldestFirst[oldestFirst.length - 1]);
    if (out.value !== null && Number.isFinite(out.value)) ttmPoint = { year: ttm.year, value: out.value, inputs: { ...out.inputs } };
  }
  return {
    ttm: ttmPoint,
    formulaId: spec.id, label: spec.label, unit: spec.unit, series,
    latest: series.length ? series[series.length - 1].value : null,
    median10y: med, min10y: values.length ? Math.min(...values) : null, max10y: values.length ? Math.max(...values) : null,
    std10y: std(values), trend,
    consistency: threshold !== null && values.length ? values.filter((v) => (spec.higherIsBetter ? v >= threshold : v <= threshold)).length / values.length : null,
    sectorMedian: null, percentileInSector: null,
  };
}

// --- quality scores (spec §4.6) -----------------------------------------------------------

function dupont(annual: AnnualFigures[]): QualityScores["dupont"] {
  const oldestFirst = [...annual].sort((a, b) => a.year - b.year);
  return oldestFirst.map((y, i) => {
    const p = oldestFirst[i - 1];
    const netMargin = y.netIncome !== null && y.revenue ? y.netIncome / y.revenue : null;
    const assets = avg(y.totalAssets, p?.totalAssets);
    const assetTurnover = y.revenue !== null && assets ? y.revenue / assets : null;
    const equity = avg(y.shareholdersEquity, p?.shareholdersEquity);
    const equityMultiplier = assets !== null && equity ? assets / equity : null;
    return {
      year: y.year, netMargin, assetTurnover, equityMultiplier,
      roe: netMargin !== null && assetTurnover !== null && equityMultiplier !== null ? netMargin * assetTurnover * equityMultiplier : null,
    };
  }).slice(-10);
}

/** Piotroski's nine tests, exactly as published: profitability, leverage and efficiency, this year against last. */
function piotroski(annual: AnnualFigures[]): QualityScores["piotroski"] {
  const sorted = [...annual].sort((a, b) => b.year - a.year);
  const [now, prev] = sorted;
  if (!now || !prev) return { score: null, tests: [{ name: "two years of accounts", passed: null, detail: "needs this year and last" }] };
  const roa = (y: AnnualFigures) => (y.netIncome !== null && y.totalAssets ? y.netIncome / y.totalAssets : null);
  const fcf = (y: AnnualFigures) => (y.operatingCashFlow === null ? null : y.operatingCashFlow);
  const lev = (y: AnnualFigures) => (y.totalDebt !== null && y.totalAssets ? y.totalDebt / y.totalAssets : null);
  const cur = (y: AnnualFigures) => (y.currentAssets !== null && y.currentLiabilities ? y.currentAssets / y.currentLiabilities : null);
  const marg = (y: AnnualFigures) => (y.grossProfit !== null && y.revenue ? y.grossProfit / y.revenue : null);
  const turn = (y: AnnualFigures) => (y.revenue !== null && y.totalAssets ? y.revenue / y.totalAssets : null);

  const cmp = (a: number | null, b: number | null, better: "higher" | "lower"): boolean | null =>
    a === null || b === null ? null : better === "higher" ? a > b : a < b;

  const tests = [
    { name: "Positive return on assets", passed: roa(now) === null ? null : roa(now)! > 0, detail: "net income against total assets" },
    { name: "Positive operating cash flow", passed: fcf(now) === null ? null : fcf(now)! > 0, detail: "cash from operations" },
    { name: "Return on assets improved", passed: cmp(roa(now), roa(prev), "higher"), detail: "this year against last" },
    { name: "Cash flow exceeds profit", passed: fcf(now) === null || now.netIncome === null ? null : fcf(now)! > now.netIncome, detail: "accruals check" },
    { name: "Leverage fell", passed: lev(now) === 0 && lev(prev) === 0 ? true : cmp(lev(now), lev(prev), "lower"), detail: "debt as a share of assets (no debt in either year passes)" },
    { name: "Current ratio improved", passed: cmp(cur(now), cur(prev), "higher"), detail: "short-term solvency" },
    { name: "No new shares issued", passed: now.sharesDiluted === null || prev.sharesDiluted === null ? null : now.sharesDiluted <= prev.sharesDiluted * 1.01, detail: "share count" },
    { name: "Gross margin improved", passed: cmp(marg(now), marg(prev), "higher"), detail: "pricing power" },
    { name: "Asset turnover improved", passed: cmp(turn(now), turn(prev), "higher"), detail: "sales per rupee of assets" },
  ];
  const known = tests.filter((t) => t.passed !== null);
  return { score: known.length >= 5 ? tests.filter((t) => t.passed === true).length : null, tests };
}

/** Altman Z'' - the variant for non-manufacturers, which is what most of this market is (spec §4.6). */
function altman(annual: AnnualFigures[], marketCap: number | null, sectorSet: string): QualityScores["altmanZ"] {
  if (sectorSet === "financial") return { score: null, zone: null, variant: "Z''", reason: "not meaningful for a lender; the spec skips it for financial companies" };
  const y = [...annual].sort((a, b) => b.year - a.year)[0];
  if (!y || y.totalAssets === null || y.totalAssets === 0) return { score: null, zone: null, variant: "Z''", reason: "no balance sheet on record" };
  const workingCapital = y.currentAssets !== null && y.currentLiabilities !== null ? y.currentAssets - y.currentLiabilities : null;
  const retained = y.shareholdersEquity; // retained earnings are not reported separately in these filings
  const x1 = workingCapital === null ? null : workingCapital / y.totalAssets;
  const x2 = retained === null ? null : retained / y.totalAssets;
  const x3 = y.ebit === null ? null : y.ebit / y.totalAssets;
  const x4 = y.totalLiabilities && marketCap !== null ? marketCap / y.totalLiabilities : null;
  if ([x1, x2, x3, x4].some((v) => v === null)) return { score: null, zone: null, variant: "Z''", reason: "missing working capital, equity or liabilities" };
  const score = 6.56 * x1! + 3.26 * x2! + 6.72 * x3! + 1.05 * x4!;
  return { score, zone: score > 2.6 ? "safe" : score > 1.1 ? "grey" : "distress", variant: "Z''" };
}

/** Beneish M: eight variables comparing this year with last. Above -1.78 is the published flag. */
function beneish(annual: AnnualFigures[]): QualityScores["beneishM"] {
  const [now, prev] = [...annual].sort((a, b) => b.year - a.year);
  if (!now || !prev) return { score: null, flag: null, reason: "needs two consecutive years" };
  const need = (v: number | null | undefined): number | null => (v === null || v === undefined || v === 0 ? null : v);
  const dsri = need(prev.receivables) && need(now.revenue) && need(prev.revenue) && now.receivables !== null
    ? (now.receivables / now.revenue!) / (prev.receivables! / prev.revenue!) : null;
  const gmi = need(now.revenue) && need(prev.revenue) && now.grossProfit !== null && prev.grossProfit !== null
    ? (prev.grossProfit / prev.revenue!) / (now.grossProfit / now.revenue!) : null;
  const sgi = need(prev.revenue) && now.revenue !== null ? now.revenue / prev.revenue! : null;
  const depi = need(now.depreciation) && need(prev.depreciation) ? prev.depreciation! / now.depreciation! : null;
  const lvgi = need(now.totalAssets) && need(prev.totalAssets) && now.totalLiabilities !== null && prev.totalLiabilities !== null
    ? (now.totalLiabilities / now.totalAssets!) / (prev.totalLiabilities / prev.totalAssets!) : null;
  const tata = need(now.totalAssets) && now.netIncome !== null && now.operatingCashFlow !== null
    ? (now.netIncome - now.operatingCashFlow) / now.totalAssets! : null;
  const parts = { dsri, gmi, sgi, depi, lvgi, tata };
  const missing = Object.entries(parts).filter(([, v]) => v === null).map(([k]) => k);
  if (missing.length > 2) return { score: null, flag: null, reason: `missing ${missing.join(", ")}` };
  // Published coefficients; the two variables this data cannot support (SGAI, AQI) are left at their neutral 1.
  const score = -4.84 + 0.92 * (dsri ?? 1) + 0.528 * (gmi ?? 1) + 0.404 * 1 + 0.892 * (sgi ?? 1)
    + 0.115 * (depi ?? 1) - 0.172 * 1 + 4.679 * (tata ?? 0) - 0.327 * (lvgi ?? 1);
  return { score, flag: score > -1.78 };
}

/** Everything in section 4, for one company. */
export function ratioReport(db: Db, raw: RawData, personaThresholds: Record<string, number> = {}): RatioReport {
  const unavailable: Unavailable[] = [...raw.unavailable];
  const categories: Record<string, Record<string, RatioSeries>> = {};
  const financial = raw.sectorSet === "financial";
  const applicable = SPECS.filter((s) => (financial ? !STANDARD_ONLY.has(s.category) || SHARED_WITH_FINANCIAL.has(s.key) : !FINANCIAL_ONLY.has(s.category)));

  for (const spec of applicable) {
    const series = buildSeries(spec, raw.annual, personaThresholds[spec.key] ?? null, raw.ttm);
    // A lender's ROE and ROA sit with its sector set rather than under industrial profitability.
    const category = financial && SHARED_WITH_FINANCIAL.has(spec.key) && (spec.category === "profitability" || spec.category === "solvency") ? "financial" : spec.category;
    (categories[category] ??= {})[spec.key] = series;
    if (series.latest === null) {
      const why = series.series[series.series.length - 1]?.reason ?? "no data";
      unavailable.push({ key: spec.key, reason: why });
    }
  }

  // Growth (spec §4.3) is a family rather than a per-year ratio: CAGR over 3, 5 and 10 years.
  const growth: Record<string, RatioSeries> = {};
  const oldestFirst = [...raw.annual].sort((a, b) => a.year - b.year);
  const cagrOf = (pick: (y: AnnualFigures) => number | null, years: number, key: string, label: string) => {
    const end = oldestFirst[oldestFirst.length - 1];
    const start = oldestFirst[oldestFirst.length - 1 - years];
    const endValue = end ? pick(end) : null;
    const startValue = start ? pick(start) : null;
    const value = startValue === null || endValue === null ? null : startValue <= 0 ? null : (endValue / startValue) ** (1 / years) - 1;
    const reason = startValue !== null && startValue <= 0 ? "non_positive_base" : value === null ? "insufficient_history" : undefined;
    growth[key] = {
      formulaId: `cagr_${years}y_v1`, label, unit: "percent",
      series: [{ year: end?.year ?? 0, value: value !== null && Number.isFinite(value) ? value : null, reason, inputs: { start: startValue, end: endValue, years } }],
      latest: value !== null && Number.isFinite(value) ? value : null,
      median10y: null, min10y: null, max10y: null, std10y: null, trend: null, consistency: null, sectorMedian: null, percentileInSector: null,
    };
    if (growth[key].latest === null) unavailable.push({ key, reason: reason ?? "insufficient_history" });
  };
  for (const years of [3, 5, 10] as const) {
    cagrOf((y) => y.revenue, years, `revenueCagr${years}y`, `Revenue CAGR ${years}Y`);
    cagrOf((y) => y.epsDiluted, years, `epsCagr${years}y`, `EPS CAGR ${years}Y`);
    cagrOf((y) => y.operatingIncome, years, `operatingIncomeCagr${years}y`, `Operating income CAGR ${years}Y`);
    cagrOf((y) => (y.operatingCashFlow === null ? null : y.operatingCashFlow - Math.abs(y.capitalExpenditure ?? 0)), years, `fcfCagr${years}y`, `Free cash flow CAGR ${years}Y`);
    cagrOf((y) => (y.shareholdersEquity !== null && y.sharesDiluted ? y.shareholdersEquity / y.sharesDiluted : null), years, `bvpsCagr${years}y`, `Book value per share CAGR ${years}Y`);
  }
  categories.growth = growth;

  // Valuation ratios use today's price against the latest reported figures (spec §4.3).
  const latest = [...raw.annual].sort((a, b) => b.year - a.year)[0];
  const price = raw.quote?.lastPrice ?? null;
  const single = (key: string, label: string, value: number | null, unit: RatioSeries["unit"], inputs: Record<string, number | null>, reason?: string): RatioSeries => ({
    formulaId: `${key}_v1`, label, unit,
    series: [{ year: latest?.year ?? 0, value: value !== null && Number.isFinite(value) ? value : null, reason, inputs }],
    latest: value !== null && Number.isFinite(value) ? value : null,
    median10y: null, min10y: null, max10y: null, std10y: null, trend: null, consistency: null, sectorMedian: null, percentileInSector: null,
  });
  // Price on the calculation date against the most recent twelve months of earnings where quarters allow.
  const eps = raw.ttm?.epsDiluted ?? latest?.epsDiluted ?? null;
  const epsBasis = raw.ttm?.epsDiluted != null ? 1 : 0; // 1 = trailing twelve months, 0 = latest fiscal year
  const fcfLatest = latest?.operatingCashFlow === null || latest === undefined ? null : latest.operatingCashFlow! - Math.abs(latest.capitalExpenditure ?? 0);
  categories.valuation = {
    pe: single("pe", "Price to earnings", eps !== null && eps > 0 && price !== null ? price / eps : null, "times",
      { price, eps_diluted: eps, eps_is_ttm: epsBasis }, eps !== null && eps <= 0 ? "negative_earnings" : undefined),
    pb: single("pb", "Price to book", raw.bookValuePerShare && price !== null ? price / raw.bookValuePerShare : null, "times", { price, book_value_per_share: raw.bookValuePerShare }),
    ps: single("ps", "Price to sales", raw.marketCap !== null && latest?.revenue ? raw.marketCap / latest.revenue : null, "times", { market_cap: raw.marketCap, revenue: latest?.revenue ?? null }),
    evEbitda: single("evEbitda", "EV to EBITDA",
      raw.marketCap !== null && latest?.ebitda ? (raw.marketCap + (latest.totalDebt ?? 0) - (latest.cash ?? 0)) / latest.ebitda : null, "times",
      { market_cap: raw.marketCap, total_debt: latest?.totalDebt ?? null, cash: latest?.cash ?? null, ebitda: latest?.ebitda ?? null }),
    earningsYield: single("earningsYield", "Earnings yield", eps !== null && price ? eps / price : null, "percent", { eps_diluted: eps, price }),
    fcfYield: single("fcfYield", "Free cash flow yield", fcfLatest !== null && raw.marketCap ? fcfLatest / raw.marketCap : null, "percent", { free_cash_flow: fcfLatest, market_cap: raw.marketCap }),
    dividendYield: single("dividendYield", "Dividend yield", raw.dividendPerShare !== null && price ? raw.dividendPerShare / price : null, "percent", { dividend_per_share: raw.dividendPerShare, price }),
  };
  if (raw.quote && raw.quote.currency !== raw.currency) {
    // spec §5.4: never mix currencies inside a ratio - a foreign filer's ADR trades in dollars against rupee accounts.
    for (const key of Object.keys(categories.valuation)) {
      const series = categories.valuation[key];
      categories.valuation[key] = { ...series, latest: null, series: series.series.map((p) => ({ ...p, value: null, reason: "currency_mismatch" })) };
      unavailable.push({ key, reason: `price is in ${raw.quote.currency} but the accounts are in ${raw.currency}` });
    }
  }
  if (financial) {
    // spec §4.2: EV/EBITDA is not meaningful for a lender, and neither is free cash flow, whose raw material is money.
    delete categories.valuation.evEbitda;
    delete categories.valuation.fcfYield;
    for (const key of ["gross_npa_ratio", "net_npa_ratio", "provision_coverage_ratio", "capital_adequacy_ratio", "casa_ratio"]) {
      if (!unavailable.some((u) => u.key === key)) unavailable.push({ key, reason: "reported only in the results annexure, which is not parsed yet (spec §4.4)" });
    }
    if (/insur/i.test(raw.industry ?? "")) unavailable.push({ key: "combined_ratio", reason: "claims and earned premium are not in the parsed filings" });
  }
  const epsCagr5 = growth.epsCagr5y?.latest ?? null;
  categories.valuation.peg = single("peg", "PEG",
    categories.valuation.pe.latest !== null && epsCagr5 !== null && epsCagr5 > 0 ? categories.valuation.pe.latest / (epsCagr5 * 100) : null, "times",
    { pe: categories.valuation.pe.latest, eps_cagr_5y: epsCagr5 },
    eps !== null && eps <= 0 ? "negative_earnings" : epsCagr5 !== null && epsCagr5 <= 0 ? "non_positive_growth" : undefined);

  // Dividend growth and share count change sit beside the payout ratio (spec §4.3).
  categories.dividends ??= {};
  const fiveBack = oldestFirst[oldestFirst.length - 6];
  categories.dividends.shareCountChange = single("shareCountChange", "Share count change (5Y)",
    latest?.sharesDiluted && fiveBack?.sharesDiluted ? (latest.sharesDiluted - fiveBack.sharesDiluted) / fiveBack.sharesDiluted : null, "percent",
    { shares_now: latest?.sharesDiluted ?? null, shares_5y_ago: fiveBack?.sharesDiluted ?? null });
  // Dividend per share for a year = dividends paid that year over the shares then in issue.
  const dps = (y: AnnualFigures | undefined) => (y?.dividendsPaid != null && y.sharesDiluted ? Math.abs(y.dividendsPaid) / y.sharesDiluted : null);
  const dpsNow = dps(latest);
  const dpsThen = dps(fiveBack);
  const dividendGrowth = dpsNow !== null && dpsThen !== null && dpsThen > 0 ? (dpsNow / dpsThen) ** (1 / 5) - 1 : null;
  categories.dividends.dividendGrowth = single("dividendGrowth", "Dividend growth (5Y CAGR)", dividendGrowth, "percent",
    { dps_now: dpsNow, dps_5y_ago: dpsThen },
    dividendGrowth !== null ? undefined : dpsThen !== null && dpsThen <= 0 ? "non_positive_base" : fiveBack ? "missing_input" : "insufficient_history");

  // Peer comparison (spec §4.5): the same engine, run over the peer list, compared only within this market.
  attachPeerComparison(db, raw, categories);

  const scores = categoryScores(categories, financial);
  return {
    symbol: raw.symbol, company: raw.company, market: raw.market, currency: raw.currency,
    sectorSet: raw.sectorSet, industry: raw.industry,
    years: raw.annual.map((a) => a.year).sort((a, b) => a - b),
    categories,
    qualityScores: {
      dupont: dupont(raw.annual),
      piotroski: piotroski(raw.annual),
      altmanZ: altman(raw.annual, raw.marketCap, raw.sectorSet),
      beneishM: beneish(raw.annual),
    },
    categoryScores: scores,
    unavailable,
    peers: { count: raw.market === "IN" ? raw.peers.length : raw.peerMultiples.count, industry: raw.industry },
  };
}

/** Sector medians and percentiles, from the ratios already stored for the peer list (spec §4.5). */
function attachPeerComparison(db: Db, raw: RawData, categories: Record<string, Record<string, RatioSeries>>) {
  // Peers from the provider (US): values already in decimals, and only ever from the company's own market (§5.0).
  if (raw.market !== "IN") {
    for (const [category, ratios] of Object.entries(categories)) {
      for (const [key, series] of Object.entries(ratios)) {
        const pool = (raw.peerValues?.values[key] ?? []).filter((v) => Number.isFinite(v));
        if (series.latest === null || pool.length < 5) continue;
        categories[category][key] = { ...series, sectorMedian: median(pool), percentileInSector: percentile(series.latest, pool) };
      }
    }
    return;
  }
  if (raw.peers.length < 5 || !raw.industry) return; // fewer than five peers is not a comparison (spec §4.5)
  const column: Record<string, string> = {
    roe: "roe", netMargin: "net_margin_ttm", operatingMargin: "opm_ttm", grossMargin: "gpm_ttm",
    debtToEquity: "debt_to_equity", pe: "pe", pb: "pb", dividendYield: "div_yield",
    revenueCagr3y: "sales_growth_3y", operatingIncomeCagr3y: "profit_growth_3y",
  };
  for (const [category, ratios] of Object.entries(categories)) {
    for (const [key, series] of Object.entries(ratios)) {
      const col = column[key];
      if (!col || series.latest === null) continue;
      const pool = db.all<{ v: number }>(
        `SELECT ${col} AS v FROM company_metrics WHERE industry = ? AND symbol != ? AND ${col} IS NOT NULL`, [raw.industry, raw.symbol])
        .map((r) => Number(r.v)).filter((v) => Number.isFinite(v));
      if (pool.length < 5) continue;
      // company_metrics keeps percentages as whole numbers; the engine keeps decimals.
      const scale = series.unit === "percent" && key !== "debtToEquity" ? 100 : 1;
      categories[category][key] = { ...series, sectorMedian: (median(pool) ?? 0) / scale, percentileInSector: percentile(series.latest * scale, pool) };
    }
  }
}

/** Four 0-100 scores from where each ratio sits against its sector (spec §4.7). */
function categoryScores(categories: Record<string, Record<string, RatioSeries>>, financial: boolean): RatioReport["categoryScores"] {
  const config = scoring();
  const { lowerIsBetter } = config;
  const weights = financial ? { ...config.categories, ...config.financial } : config.categories;
  const find = (key: string): RatioSeries | undefined => Object.values(categories).map((c) => c[key]).find(Boolean);
  const score = (config: Record<string, number>): number | null => {
    const parts = Object.entries(config).map(([key, weight]) => ({ key, weight }));
    let total = 0, used = 0;
    for (const part of parts) {
      const series = find(part.key);
      if (!series || series.latest === null) continue;
      // A percentile against the sector when there is one; otherwise a plain judgement against the median.
      let pct = series.percentileInSector;
      if (pct === null && series.median10y !== null && series.median10y !== 0) {
        pct = Math.max(0, Math.min(100, 50 + ((series.latest - series.median10y) / Math.abs(series.median10y)) * 50));
      }
      if (pct === null) continue;
      const cheapIsBetter = lowerIsBetter.includes(part.key);
      total += (cheapIsBetter ? 100 - pct : pct) * part.weight;
      used += part.weight;
    }
    return used >= 0.4 ? Math.round(total / used) : null;
  };
  return {
    fundamental: score(weights.fundamental),
    growth: score(weights.growth),
    valuation: score(weights.valuation),
    financialHealth: score(weights.financialHealth),
  };
}
