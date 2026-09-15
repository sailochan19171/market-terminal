export interface Metrics {
  symbol: string; company: string | null; isin: string | null; series: string | null;
  industry: string | null; indices: string | null; bse_code: string | null;
  face_value: number | null; listing_date: string | null; trade_date: string | null;
  open: number | null; high: number | null; low: number | null; close: number | null; prev_close: number | null;
  change: number | null; pct_1d: number | null; volume: number | null; turnover: number | null;
  high_52w: number | null; low_52w: number | null; from_high: number | null; from_low: number | null;
  ret_1m: number | null; ret_3m: number | null; ret_1y: number | null;
  market_cap_cr: number | null; mcap_source: string | null;
  basis: string | null; quarters_available: number | null; latest_quarter: string | null;
  sales_qtr_cr: number | null; np_qtr_cr: number | null; qtr_sales_var: number | null; qtr_profit_var: number | null;
  sales_ttm_cr: number | null; np_ttm_cr: number | null; eps_ttm: number | null; pe: number | null;
  opm_ttm: number | null; net_margin_ttm: number | null; promoter: number | null;
  div_ttm: number | null; div_yield: number | null; avg_eps_annual: number | null;
  earnings_years: number | null; price_to_avg_earnings: number | null;
  sales_growth_3y: number | null; profit_growth_3y: number | null;
}

export interface CompanySummary {
  metrics: Metrics;
  basisAvailable: { consolidated: boolean; standalone: boolean };
  indices: { slug: string; name: string }[];
  /** True for instruments without company data (bonds, G-secs, gold bonds...). */
  limited: boolean;
  instrumentType: string;
}

export interface QuarterRow {
  period_end: string; sales: number | null; expenses: number | null; operating_profit: number | null;
  opm: number | null; other_income: number | null; interest: number | null; depreciation: number | null;
  pbt: number | null; tax_pct: number | null; net_profit: number | null; eps: number | null;
  quality: string | null; xbrl_url: string | null; complete: boolean;
}

export interface AnnualRow {
  label: string; sales: number | null; expenses: number | null; operating_profit: number | null;
  opm: number | null; other_income: number | null; interest: number | null; depreciation: number | null;
  pbt: number | null; tax_pct: number | null; net_profit: number | null; eps: number | null;
}

export type Basis = "auto" | "consolidated" | "standalone";

export interface SavedScreen {
  key: string; theme: string; title: string; description: string;
  filters: { field: string; op: string; value: number }[]; sort: string; order: "asc" | "desc";
}
export interface ScreensMeta {
  screens: SavedScreen[];
  columns: Record<string, string>;
  sectors: { name: string; companies: number }[];
}
