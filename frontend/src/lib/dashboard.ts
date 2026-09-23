// Types and shared helpers for the company dashboard (GET /api/v2/company/<id>/dashboard).

import type { PriceQuote } from "@/components/AsOf";
import { countIN, inr, inrCrore, isNum, num, pct, percent, shiftDate, type Num } from "./format";

export type Exchange = "NSE" | "BSE";
export type ViewMode = "summary" | "detailed" | "agents" | "versions";

export interface Identity {
  key: string; symbol: string | null; bseCode: string | null; bseTicker: string | null; isin: string | null;
  company: string; industry: string | null; indices: { slug: string; name: string }[]; series: string | null;
  faceValue: number | null; listingDate: string | null; exchanges: Record<Exchange, boolean>;
  instrumentType: string; limited: boolean;
}

export interface Quote {
  exchange: Exchange; session: string; open: Num; high: Num; low: Num; close: number; prevClose: Num;
  change: Num; changePct: Num; volume: Num; high52w: Num; low52w: Num; fromHigh: Num; fromLow: Num;
}

export interface QuarterLine {
  period_end: string; sales: Num; expenses: Num; operating_profit: Num; opm: Num; other_income: Num;
  interest: Num; depreciation: Num; pbt: Num; tax_pct: Num; net_profit: Num; eps: Num; eps_reported: Num;
  gross_profit: Num; gpm: Num; npm: Num; shares: Num; filed_at: string | null; xbrl_url: string | null;
  quality: string | null; complete: boolean;
}

export interface AnnualLine {
  label: string; sales: Num; expenses: Num; operating_profit: Num; opm: Num; gross_profit: Num; gpm: Num;
  other_income: Num; interest: Num; depreciation: Num; pbt: Num; tax_pct: Num; net_profit: Num; npm: Num; eps: Num;
}

export interface HoldingRow {
  as_of_date: string; promoter: Num; fii: Num; dii: Num; government: Num; public: Num; others: Num;
  shareholders: Num; total_shares: Num; source: "xbrl" | "summary"; filed_at: string | null;
}

export interface VersionMeta {
  id: number; company_key: string; symbol: string | null; bse_code: string | null; company: string;
  exchange: Exchange; analysis_date: string; version: number; status: string;
  kind: "scheduled" | "on_demand" | "point_in_time" | "sync"; data_from: string | null; data_to: string | null;
  results_as_of: string | null; shareholding_as_of: string | null; summary: string; created_at: string; updated_at: string;
  versions?: number;
}

export interface SyncStatus {
  symbol: string; status: "idle" | "running" | "done" | "error"; stage?: string | null;
  done?: number; total?: number; error?: string | null; pendingResults: number; running: boolean;
}

export interface StatementBlock {
  lines: { key: string; label: string; level: number }[];
  periods: { periodEnd: string; basis: string; months: number | null; values: Record<string, number>; filedAt: string | null; xbrl_url: string | null }[];
}

export interface Dashboard {
  identity: Identity;
  exchange: Exchange;
  mode: "latest" | "historical" | "version";
  version: VersionMeta | null;
  quote: Quote | null;
  /** The shared price service's answer for this company: what every surface must display. */
  price: PriceQuote | null;
  metrics: Record<string, Num | string>;
  reasons: Record<string, string>;
  sources: Record<string, string>;
  basis: { used: string | null; available: { consolidated: boolean; standalone: boolean } };
  reportFormat: "bank" | "corporate" | null;
  quarters: QuarterLine[];
  quartersInRange: QuarterLine[];
  annual: AnnualLine[];
  ttm: AnnualLine | null;
  growth: Record<"sales" | "profit" | "eps", Record<string, Num>>;
  balance: { periodEnd: string; basis: string; equity: Num; borrowings: Num; totalAssets: Num } | null;
  sharesInfo: { value: number; asOf: string; source: string } | null;
  statements: { format: "bank" | "corporate" | null; balanceSheet: StatementBlock; cashFlow: StatementBlock };
  dividends: { exDate: string; purpose: string; amount: Num; source: string }[];
  shareholding: HoldingRow[];
  shareholdingInRange: HoldingRow[];
  freshness: {
    status: "end_of_day" | "delayed" | "historical"; asOf: string | null;
    prices: { session: string | null; latestStored: string | null; source: string };
    results: { latestQuarter: string | null; filedAt: string | null; source: string | null; pendingFilings: number };
    shareholding: { asOf: string | null; filedAt: string | null; source: string | null };
    computedAt: string; notes: string[];
  };
  dataPeriod: { pricesFrom: string | null; pricesTo: string | null; resultsFrom: string | null; resultsTo: string | null };
  noResultsReason: string | null;
  analysis: { pros: string[]; cons: string[]; basis: string };
  range: { from: string | null; to: string | null };
  prices: { t: string; o: Num; h: Num; l: Num; c: number; v: Num }[];
  valuationSeries: { t: string; pe: number }[];
  sync: SyncStatus | null;
  versions: { id: number; version: number; analysis_date: string; kind: VersionMeta["kind"]; exchange: Exchange; created_at: string; summary: string }[];
}

// --- metrics ------------------------------------------------------------------
type Kind = "inr" | "crore" | "ratio" | "percent" | "change" | "count";

export const METRICS: Record<string, { label: string; kind: Kind; hint?: string }> = {
  close: { label: "Price", kind: "inr" },
  market_cap: { label: "Market cap", kind: "crore", hint: "Shares outstanding × close" },
  revenue_ttm: { label: "Revenue (TTM)", kind: "crore", hint: "Last four quarters" },
  gross_profit_ttm: { label: "Gross profit (TTM)", kind: "crore", hint: "Revenue − cost of materials, purchases and inventory change" },
  net_profit_ttm: { label: "Net profit (TTM)", kind: "crore" },
  eps_ttm: { label: "EPS (TTM)", kind: "inr", hint: "Adjusted for splits and bonuses" },
  pe: { label: "P/E", kind: "ratio" },
  pb: { label: "P/B", kind: "ratio" },
  bvps: { label: "Book value / share", kind: "inr" },
  book_value: { label: "Book value", kind: "crore" },
  roe: { label: "ROE", kind: "percent", hint: "TTM profit ÷ book value" },
  debt_to_equity: { label: "Debt / equity", kind: "ratio" },
  shares: { label: "Shares outstanding", kind: "count" },
  dividend_ttm: { label: "Dividend (12M)", kind: "inr" },
  cash: { label: "Cash and equivalents", kind: "crore", hint: "Latest balance sheet" },
  current_ratio: { label: "Current ratio", kind: "ratio", hint: "Current assets ÷ current liabilities" },
  cfo_fy: { label: "Operating cash flow (FY)", kind: "crore", hint: "Latest full-year cash flow statement" },
  capex_fy: { label: "Capex (FY)", kind: "crore" },
  fcf_fy: { label: "Free cash flow (FY)", kind: "crore", hint: "Operating cash flow − capex" },
  dividend_yield: { label: "Dividend yield", kind: "percent" },
  opm_ttm: { label: "Operating margin", kind: "percent" },
  npm_ttm: { label: "Net margin", kind: "percent" },
  gpm_ttm: { label: "Gross margin", kind: "percent" },
  sales_qtr_yoy: { label: "Sales growth (qtr YoY)", kind: "change" },
  profit_qtr_yoy: { label: "Profit growth (qtr YoY)", kind: "change" },
  revenue_ttm_growth: { label: "Revenue growth (TTM)", kind: "change" },
  profit_ttm_growth: { label: "Profit growth (TTM)", kind: "change" },
  eps_ttm_growth: { label: "EPS growth (TTM)", kind: "change" },
  sales_cagr_3y: { label: "Sales CAGR (3Y)", kind: "change" },
  profit_cagr_3y: { label: "Profit CAGR (3Y)", kind: "change" },
  promoter: { label: "Promoter holding", kind: "percent" },
  fii: { label: "FII holding", kind: "percent" },
  dii: { label: "DII holding", kind: "percent" },
  high_52w: { label: "52-week high", kind: "inr" },
  low_52w: { label: "52-week low", kind: "inr" },
  volume: { label: "Volume", kind: "count" },
  ret_1w: { label: "1 week", kind: "change" }, ret_1m: { label: "1 month", kind: "change" },
  ret_3m: { label: "3 months", kind: "change" }, ret_6m: { label: "6 months", kind: "change" },
  ret_1y: { label: "1 year", kind: "change" }, ret_3y: { label: "3 years", kind: "change" },
  ret_5y: { label: "5 years", kind: "change" },
};

export function formatMetric(key: string, v: Num | string): string {
  if (typeof v === "string") return v;
  if (!isNum(v)) return "—";
  switch (METRICS[key]?.kind) {
    case "inr": return inr(v);
    case "crore": return inrCrore(v);
    case "ratio": return num(v, key === "debt_to_equity" || key === "current_ratio" ? 2 : 1);
    case "percent": return percent(v, 2);
    case "change": return pct(v, 1);
    case "count": return countIN(v);
    default: return num(v);
  }
}

// --- date range presets -----------------------------------------------------------
export const PRESETS = [
  { value: "1D", label: "Today", days: 0 },
  { value: "1W", label: "1W", days: 7 },
  { value: "1M", label: "1M", days: 30 },
  { value: "3M", label: "3M", days: 91 },
  { value: "6M", label: "6M", days: 182 },
  { value: "1Y", label: "1Y", days: 365 },
  { value: "3Y", label: "3Y", days: 1095 },
  { value: "5Y", label: "5Y", days: 1826 },
] as const;
export type Preset = (typeof PRESETS)[number]["value"] | "custom";

/** Resolve a preset against the anchor session (latest data, or the chosen version date). */
export function presetRange(preset: Preset, anchor: string): { from: string; to: string } | null {
  const p = PRESETS.find((x) => x.value === preset);
  return p ? { from: shiftDate(anchor, -p.days), to: anchor } : null;
}

export const KIND_LABEL: Record<VersionMeta["kind"], string> = {
  scheduled: "Scheduled", on_demand: "On demand", point_in_time: "Point in time", sync: "After data sync",
};
