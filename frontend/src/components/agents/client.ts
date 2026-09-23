// Shapes and helpers shared by the analyst workspace, its reports panel and the company-page embed.
// Types mirror src/server/agents/state.ts and graph.ts; formatting is the Response layer's job (spec §4.1).

export type Market = "IN" | "US";
export type Currency = "INR" | "USD";

export interface RatioPoint { year: number; value: number | null; reason?: string; inputs: Record<string, number | null> }
export interface RatioSeries {
  formulaId: string; label: string; unit: "ratio" | "percent" | "days" | "times" | "currency"; series: RatioPoint[]; ttm?: RatioPoint | null;
  latest: number | null; median10y: number | null; min10y: number | null; max10y: number | null; std10y: number | null;
  trend: "improving" | "stable" | "declining" | null; consistency: number | null; sectorMedian: number | null; percentileInSector: number | null;
}
export interface RatioReport {
  sectorSet: string; industry: string | null; years: number[]; currency: Currency;
  categories: Record<string, Record<string, RatioSeries>>;
  qualityScores: {
    dupont: { year: number; netMargin: number | null; assetTurnover: number | null; equityMultiplier: number | null; roe: number | null }[];
    piotroski: { score: number | null; tests: { name: string; passed: boolean | null; detail: string }[] };
    altmanZ: { score: number | null; zone: string | null; variant: string; reason?: string };
    beneishM: { score: number | null; flag: boolean | null; reason?: string };
  };
  categoryScores: Record<string, number | null>;
  unavailable: { key: string; reason: string }[];
  peers: { count: number; industry: string | null };
}
export interface Valuation {
  currentPrice: number | null; marginOfSafety: number | null; requiredMarginOfSafety: number; meetsRequirement: boolean | null;
  scenarios: { name: string; intrinsicValuePerShare: number | null; assumptions: Record<string, number | string | null> }[];
  relativeMultiples: Record<string, number | null>;
  models: { key: string; label: string; fairValue: number | null; basis: string }[];
  assumptionNotes?: string[];
  unavailable: { key: string; reason: string }[];
}
export interface Technical {
  ma50: number | null; ma200: number | null; priceVsMa50: number | null; priceVsMa200: number | null; high52w: number | null; low52w: number | null;
  returns: Record<string, number | null>; volatility: number | null; rsi14: number | null; trendLabel: string | null; asOf: string | null;
  unavailable: { key: string; reason: string }[];
}
export interface QItem { summary: string; sentiment: string; sourceUrl: string | null; sourceLabel: string; date: string | null }
export interface Qualitative { moatSignals: QItem[]; managementSignals: QItem[]; risks: QItem[]; unavailable: { key: string; reason: string }[] }
export interface Quarter { periodEnd: string; revenue: number | null; netIncome: number | null; epsDiluted: number | null; operatingIncome: number | null; source: string | null }
export interface Company {
  symbol: string; ticker: string; exchange: string; market: Market; currency: Currency;
  company: string | null; industry: string | null; sectorSet: string; fiscalYearEnd: string | null;
  quote: { lastPrice: number | null; changePct: number | null; asOfTimestamp: string | null; source: string; currency: Currency } | null;
  marketCap: number | null; years: number[]; quarterly: Quarter[]; ttmPeriodEnd: string | null;
  ratios: RatioReport | null; valuation: Valuation | null; technical: Technical | null; qualitative: Qualitative | null;
  sources: { dataset: string; source: string; fetchedAt: string }[]; filingLinks: { label: string; url: string }[];
}
export interface Final {
  personaId: string; personaName: string; summary: string; strengths: string[]; concerns: string[];
  keyNumbers: { label: string; value: string; source: string; url?: string | null }[];
  categoryScores: Record<"fundamental" | "valuation" | "technical" | "qualitative", number | null>;
  personaFit: number | null; missingData: string[]; writtenBy: "data" | "model"; model?: string; note?: string; removed: string[]; disclaimer: string;
  /** In a comparison: each company's own scores and key numbers, and the comparison worked out in code. */
  companies?: { symbol: string; company: string; currency: Currency; categoryScores: Final["categoryScores"]; personaFit: number | null; keyNumbers: Final["keyNumbers"] }[];
  comparison?: string[];
  sections?: { title: string; body: string }[];
}
export interface StepDetail {
  headline: string;
  items?: { label: string; value: string }[];
  lists?: { title: string; rows: string[] }[];
  tables?: { title: string; columns: string[]; rows: string[][] }[];
}
export interface Step { agent: string; stage: string; durationMs: number | null; detail?: StepDetail | null }
export interface Analysis {
  requestId: string; question: string; intent: string; at?: string;
  persona: { id: string; name: string; inspiredBy: string; weights: Record<string, number>; requiredMarginOfSafety: number; dcfGrowthCap: number };
  status: "answered" | "blocked" | "ambiguous" | "concept" | "no_data"; message: string | null;
  options: { symbol: string; company: string; industry: string | null; market: Market }[];
  companies: Company[];
  plan: { tasks: { worker: string; focus?: string[]; questions?: string[]; priority?: string }[]; reasoning: string; plannedBy: string } | null;
  validation: { passed: boolean; warnings: { check: string; detail: string }[]; failedItems: { check: string; detail: string }[]; lowConfidence: string[] } | null;
  final: Final | null;
  concept: { concept: { name: string; formula: string } | null; text: string; writtenBy: string } | null;
  steps: Step[];
  errors: { agent: string; stage?: string; message: string }[];
  llmCalls: number; loops: number; durationMs: number; disclaimer: string;
  path?: string[];
}
export interface PersonaInfo { id: string; name: string; inspiredBy: string; tagline: string; keyMetrics: string[]; weights: Record<string, number>; dcfGrowthCap: number; requiredMarginOfSafety: number }

// --- formatting ---------------------------------------------------------------------------------

export const pct = (v: number | null | undefined, d = 1) => (v == null ? "—" : `${(v * 100).toFixed(d)}%`);
export const times = (v: number | null | undefined, d = 2) => (v == null ? "—" : `${v.toFixed(d)}x`);
export const money = (cur: Currency, v: number | null | undefined) => (v == null ? "—"
  : cur === "USD" ? `$${v.toLocaleString("en-US", { maximumFractionDigits: 2 })}` : `₹${v.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`);
/** Crore for India, millions and billions for the US (spec §5.0). */
export const big = (cur: Currency, v: number | null | undefined) => {
  if (v == null) return "—";
  if (cur === "INR") return `₹${Math.round(v / 1e7).toLocaleString("en-IN")} Cr`;
  return Math.abs(v) >= 1e9 ? `$${(v / 1e9).toFixed(1)}B` : `$${Math.round(v / 1e6).toLocaleString("en-US")}M`;
};
export function fmt(s: RatioSeries, v: number | null | undefined = s.latest, cur: Currency = "INR") {
  if (v == null) return "—";
  if (s.unit === "percent") return pct(v);
  if (s.unit === "currency") return big(cur, v);
  if (s.unit === "days") return `${Math.round(v)}d`;
  return times(v);
}
export const marketLabel = (c: { market: Market; exchange: string }) => `${c.market === "US" ? "US" : "India"} · ${c.exchange}`;

export const CATEGORY_LABEL: Record<string, string> = {
  profitability: "Profitability", liquidity: "Liquidity", solvency: "Solvency", efficiency: "Efficiency", valuation: "Valuation",
  cashFlow: "Cash flow quality", growth: "Growth", dividends: "Dividends and shareholder returns", financial: "Financial sector",
};

// --- the stream -----------------------------------------------------------------------------------

export interface RunRequest { message: string; persona: string; symbol?: string | null; market?: Market | null }

/** Send a question to the graph and follow its progress; resolves with the finished analysis. */
export async function streamAnalysis(req: RunRequest, onStep: (s: Step) => void, signal?: AbortSignal): Promise<Analysis> {
  const res = await fetch("/api/v2/agents/analyze", {
    method: "POST", signal, headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...req, stream: true }),
  });
  if (!res.ok || !res.body) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.message ?? `The analysis failed (HTTP ${res.status}).`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      const event = JSON.parse(line);
      if (event.type === "step") onStep({ agent: event.agent, stage: event.stage, durationMs: event.durationMs, detail: event.detail ?? null });
      else if (event.type === "result") return event.data as Analysis;
      else if (event.type === "error") throw new Error(event.message);
    }
  }
  throw new Error("The analysis ended without a result. Please try again.");
}

/** Follow-up questions shaped by the persona and what the answer was about. */
export function followUps(a: Analysis): string[] {
  const c = a.companies[0];
  if (!c) return [];
  const name = c.company?.split(" ").slice(0, 2).join(" ") ?? c.symbol;
  const bank = c.sectorSet === "financial";
  const lynch = a.persona.id === "lynch";
  const out = [
    lynch ? `Is ${name}'s P/E reasonable for its growth?` : `What is ${name}'s margin of safety?`,
    bank ? `How is ${name}'s net interest margin trending?` : `How consistent is ${name}'s return on equity?`,
    bank ? `Is ${name}'s leverage a concern?` : `Is ${name}'s debt a concern?`,
    lynch ? `Are inventories growing faster than sales at ${name}?` : `What are ${name}'s biggest risks?`,
  ];
  out.push(lynch ? "What is the PEG ratio and why does it matter?" : "What is ROCE and why does it matter?");
  return out.filter((q) => q !== a.question);
}
