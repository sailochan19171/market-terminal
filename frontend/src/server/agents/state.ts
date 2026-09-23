// The one typed object every agent reads from and writes to (spec §6.1).
//
// No agent calls another. The data agent fills `raw`, the workers each write their own report block, the
// validator writes its verdict, and synthesis reads all of it. That is what makes an answer traceable: given a
// request id, every number in it can be followed back to the report that produced it and the filing under that.
/** A last price from any market's provider (the India price service's quote fits this shape). */
export interface MarketQuote {
  lastPrice: number | null;
  changeAbs: number | null;
  changePct: number | null;
  asOfTimestamp: string | null;
  session?: string | null;
  source: string;
  isLive: boolean;
  currency: "INR" | "USD";
}

export type Market = "IN" | "US";
export type SectorSet = "standard" | "financial";
export type Intent = "full_analysis" | "single_metric" | "comparison" | "explain_concept" | "out_of_scope";

/** A figure that is missing, and why - never a zero standing in for one (spec §4.1). */
export interface Unavailable { key: string; reason: string }

/** One year of one ratio, with the numbers it was built from (spec §4.1, §6.3). */
export interface RatioPoint {
  year: number;
  value: number | null;
  reason?: string;
  inputs: Record<string, number | null>;
}

export interface RatioSeries {
  /** The same formula on trailing-twelve-month figures, where quarterly data allows (spec §4). */
  ttm?: RatioPoint | null;
  formulaId: string;
  label: string;
  unit: "ratio" | "percent" | "days" | "times" | "currency";
  series: RatioPoint[];
  latest: number | null;
  median10y: number | null;
  min10y: number | null;
  max10y: number | null;
  std10y: number | null;
  trend: "improving" | "stable" | "declining" | null;
  consistency: number | null;
  sectorMedian: number | null;
  percentileInSector: number | null;
}

export interface QualityScores {
  dupont: { year: number; netMargin: number | null; assetTurnover: number | null; equityMultiplier: number | null; roe: number | null }[];
  piotroski: { score: number | null; tests: { name: string; passed: boolean | null; detail: string }[] };
  altmanZ: { score: number | null; zone: "safe" | "grey" | "distress" | null; variant: string; reason?: string };
  beneishM: { score: number | null; flag: boolean | null; reason?: string };
}

export interface RatioReport {
  symbol: string;
  company: string | null;
  market: Market;
  currency: "INR" | "USD";
  sectorSet: SectorSet;
  industry: string | null;
  years: number[];
  categories: Record<string, Record<string, RatioSeries>>;
  qualityScores: QualityScores;
  categoryScores: { fundamental: number | null; growth: number | null; valuation: number | null; financialHealth: number | null };
  unavailable: Unavailable[];
  peers: { count: number; industry: string | null };
}

export interface TechnicalReport {
  symbol: string;
  ma50: number | null;
  ma200: number | null;
  priceVsMa50: number | null;
  priceVsMa200: number | null;
  high52w: number | null;
  low52w: number | null;
  returns: { "1y": number | null; "3y": number | null; "5y": number | null };
  volatility: number | null;
  rsi14: number | null;
  trendLabel: "uptrend" | "downtrend" | "sideways" | null;
  asOf: string | null;
  unavailable: Unavailable[];
}

export interface QualitativeItem {
  summary: string;
  sentiment: "positive" | "negative" | "neutral";
  sourceUrl: string | null;
  sourceLabel: string;
  date: string | null;
}

export interface QualitativeReport {
  symbol: string;
  moatSignals: QualitativeItem[];
  managementSignals: QualitativeItem[];
  risks: QualitativeItem[];
  unavailable: Unavailable[];
}

export interface ValidationIssue { check: string; severity: "warning" | "failure"; detail: string; worker?: string }
export interface ValidationReport { passed: boolean; warnings: ValidationIssue[]; failedItems: ValidationIssue[]; lowConfidence: string[] }

export interface KeyNumber { label: string; value: string; source: string; url?: string | null }

export interface FinalAnalysis {
  personaId: string;
  personaName: string;
  summary: string;
  strengths: string[];
  concerns: string[];
  keyNumbers: KeyNumber[];
  categoryScores: { fundamental: number | null; valuation: number | null; technical: number | null; qualitative: number | null };
  /** The four scores weighted by the persona: how closely the company fits its principles. Not a rating. */
  personaFit: number | null;
  /**
   * In a comparison, each company's own scores and key numbers: a single persona score for two companies says
   * nothing about either of them (spec §3.9).
   */
  companies?: {
    symbol: string; company: string; currency: "INR" | "USD";
    categoryScores: { fundamental: number | null; valuation: number | null; technical: number | null; qualitative: number | null };
    personaFit: number | null; keyNumbers: KeyNumber[];
  }[];
  /** Which company is stronger on each measure, worked out in code before the analysis was written. */
  comparison?: string[];
  missingData: string[];
  writtenBy: "data" | "model";
  model?: string;
  note?: string;
  /** The long-form analysis, section by section, each checked like the summary. */
  sections?: { title: string; body: string }[];
  /** Sentences the checks removed: ungrounded numbers and advice language. Kept for the trace. */
  removed: string[];
  disclaimer: string;
}

export interface ResearchTask { worker: string; focus?: string[]; years?: number; methods?: string[]; questions?: string[]; priority?: "low" | "normal" | "high"; growthSuggestion?: number }
export interface ResearchPlan { symbol: string; tasks: ResearchTask[]; reasoning: string; plannedBy: "model" | "default" }

export interface AgentError { agent: string; stage: string; message: string; retryable: boolean; at: string }

/** Everything one request needs, and everything it produced (spec §6.1). */
export interface AnalysisState {
  requestId: string;
  userMessage: string;
  personaId: string;
  symbol: string | null;
  market: Market;
  intent: Intent;
  isAllowed: boolean;
  blockedReason?: string;
  plan?: ResearchPlan;
  raw?: RawData;
  ratioReport?: RatioReport;
  valuationReport?: ValuationReportOut;
  technicalReport?: TechnicalReport;
  qualitativeReport?: QualitativeReport;
  validationReport?: ValidationReport;
  finalAnalysis?: FinalAnalysis;
  loopCount: number;
  errors: AgentError[];
  startedAt: number;
}

export interface ValuationScenario {
  name: "bear" | "base" | "bull";
  intrinsicValuePerShare: number | null;
  assumptions: Record<string, number | string | null>;
}

export interface ValuationReportOut {
  symbol: string;
  currentPrice: number | null;
  scenarios: ValuationScenario[];
  marginOfSafety: number | null;
  requiredMarginOfSafety: number;
  meetsRequirement: boolean | null;
  relativeMultiples: {
    pe: number | null; peOwnMedian: number | null; peSector: number | null;
    pb: number | null; pbSector: number | null;
    evEbitda: number | null; evEbitdaReference: number | null; // reference = the company's own median
  };
  models: { key: string; label: string; fairValue: number | null; basis: string; unavailable?: string }[];
  /** Where the assumptions came from, and any value the code clamped (spec §3.5). */
  assumptionNotes: string[];
  unavailable: Unavailable[];
}

// --- what the data agent loads once, and everyone else reads ------------------------------

/** One fiscal year, normalised to the internal schema (spec §5.2) whatever the filing called it. */
export interface AnnualFigures {
  year: number;                 // Indian fiscal year label: FY2026 = April 2025 to March 2026
  periodEnd: string;
  consolidated: boolean;
  revenue: number | null;
  costOfGoodsSold: number | null;
  grossProfit: number | null;
  operatingIncome: number | null;
  ebit: number | null;
  ebitda: number | null;
  interestExpense: number | null;
  taxExpense: number | null;
  netIncome: number | null;
  epsDiluted: number | null;
  sharesDiluted: number | null;
  depreciation: number | null;
  // Balance sheet at the year end
  cash: number | null;
  receivables: number | null;
  inventory: number | null;
  currentAssets: number | null;
  totalAssets: number | null;
  payables: number | null;
  currentLiabilities: number | null;
  totalDebt: number | null;
  totalLiabilities: number | null;
  shareholdersEquity: number | null;
  // Cash flow for the year
  shareBuybacks?: number | null;
  operatingCashFlow: number | null;
  capitalExpenditure: number | null;
  dividendsPaid: number | null;
  // Financial-sector extras (spec §5.2)
  netInterestIncome: number | null;
  interestEarningAssets: number | null;
  advances: number | null;
  deposits: number | null;
  otherIncome: number | null;
  operatingExpenses: number | null;
  sources: { income?: string | null; balance?: string | null; cashFlow?: string | null };
  /** The per-share figures as first filed, when they were later restated for a split or bonus (spec §5.4). */
  asReported?: { epsDiluted: number | null; sharesDiluted: number | null } | null;
}

export interface QuarterFigures { periodEnd: string; revenue: number | null; netIncome: number | null; epsDiluted: number | null; operatingIncome: number | null; source: string | null }

export interface RawData {
  symbol: string;
  company: string | null;
  market: Market;
  currency: "INR" | "USD";
  industry: string | null;
  sectorSet: SectorSet;
  quote: MarketQuote | null;
  exchange: string;                  // NSE, BSE, NASDAQ, NYSE
  ticker: string;                    // RELIANCE.NS, AAPL (spec §5.0)
  fiscalYearEnd: string | null;      // MM-DD
  quarterly: QuarterFigures[];       // newest first, up to 8 (spec §3.3)
  ttm: AnnualFigures | null;         // trailing twelve months where quarterly data exists (spec §4)
  marketCap: number | null;          // rupees
  sharesOutstanding: number | null;
  referencePe: number | null;        // trailing-twelve-month P/E computed independently, for the cross-check
  bookValuePerShare: number | null;
  dividendPerShare: number | null;
  annual: AnnualFigures[];           // newest first
  prices: { t: string; c: number }[]; // oldest first, up to 10 years, split- and bonus-adjusted
  yearEndPrices: Record<number, number>; // unadjusted close at each fiscal year end
  peerMultiples: { count: number; pe: number | null; pb: number | null };
  /** Peer values for sector comparison when they come from the provider rather than the database (US, as decimals). */
  peerValues?: { basis: string; values: Record<string, number[]> };
  filings: { when: string; title: string; detail: string | null; url: string | null; source: string }[]; // last 90 days, newest first
  peers: string[];
  fetchedAt: string;
  sources: { dataset: string; source: string; fetchedAt: string }[];
  unavailable: Unavailable[];
}
