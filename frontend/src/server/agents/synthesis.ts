// Persona synthesis (spec §3.9): read every report, weight it by the persona, and write the analysis.
//
// Code decides everything that is a number - the four category scores, the key numbers and their sources, the
// list of what is missing - and hands the model a numbered fact sheet to write from. The model writes the prose
// and may ask for one follow-up task. Its text is then checked: any number not present in a report triggers one
// regeneration, then removal (spec §8.1), and any sentence that reads as a trade instruction is removed (§8.3).
import type { Persona } from "./config";
import { DISCLAIMER, scrub } from "./compliance";
import type {
  FinalAnalysis, Intent, KeyNumber, QualitativeReport, RatioReport, RatioSeries, RawData, TechnicalReport, ValidationReport, ValuationReportOut,
} from "./state";
import { parseJson, type Trace } from "./trace";
import { contradictions, numberPool, ungroundedNumbers, wrongComparisons } from "./validator";

export interface CompanyReports {
  raw: RawData;
  ratios: RatioReport | null;
  valuation: ValuationReportOut | null;
  technical: TechnicalReport | null;
  qualitative: QualitativeReport | null;
}

export interface FollowUp { worker: "data_agent" | "news_moat_agent" | "valuation_agent" | "technical_agent"; questions?: string[]; growth?: number; reason: string }

// --- formatting (the one place decimals become percentages, spec §4.1) -----------------------

const percent = (v: number | null | undefined, d = 1) => (v == null ? "not available" : `${(v * 100).toFixed(d)}%`);
const times = (v: number | null | undefined, d = 2) => (v == null ? "not available" : `${v.toFixed(d)}x`);
type Currency = "INR" | "USD";
/** A price or per-share figure in the company's own currency. */
const money = (cur: Currency, v: number | null | undefined) => (v == null ? "not available"
  : cur === "USD" ? `$${v.toLocaleString("en-US", { maximumFractionDigits: 2 })}` : `₹${v.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`);
/** A large amount the way each market writes it: crore in India, millions and billions in the US (spec §5.0). */
const big = (cur: Currency, v: number | null | undefined) => {
  if (v == null) return "not available";
  if (cur === "INR") return `₹${Math.round(v / 1e7).toLocaleString("en-IN")} Cr`;
  return Math.abs(v) >= 1e9 ? `$${(v / 1e9).toFixed(1)}B` : `$${Math.round(v / 1e6).toLocaleString("en-US")}M`;
};

export function formatRatio(s: RatioSeries | undefined, v: number | null | undefined = s?.latest, cur: Currency = "INR"): string {
  if (!s) return "not available";
  if (s.unit === "percent") return percent(v);
  if (s.unit === "currency") return big(cur, v);
  if (s.unit === "days") return v == null ? "not available" : `${Math.round(v)} days`;
  return times(v);
}

export const findRatio = (r: RatioReport | null, key: string): RatioSeries | undefined =>
  r ? Object.values(r.categories).map((c) => c[key]).find(Boolean) : undefined;

const CATEGORY_SOURCE: Record<string, "income" | "balance" | "cashFlow"> = {
  profitability: "income", liquidity: "balance", solvency: "balance", efficiency: "balance", cashFlow: "cashFlow",
  dividends: "cashFlow", financial: "balance", growth: "income", valuation: "income",
};

/** The persona's key numbers, each with where it came from (spec §3.9). */
export function keyNumbers(c: CompanyReports, persona: Persona): KeyNumber[] {
  const cur = c.raw.currency;
  const out: KeyNumber[] = [];
  const latest = [...c.raw.annual].sort((a, b) => b.year - a.year)[0];
  for (const key of persona.keyMetrics) {
    if (key === "marginOfSafety") {
      const v = c.valuation;
      const base = v?.scenarios.find((s) => s.name === "base")?.intrinsicValuePerShare ?? null;
      out.push({ label: "Margin of safety (base case)", value: percent(v?.marginOfSafety ?? null), source: base === null ? "valuation agent: no intrinsic value" : `valuation agent: base-case value ${money(cur, base)} against price ${money(cur, v?.currentPrice)}` });
      continue;
    }
    if (!c.ratios) continue;
    const entry = Object.entries(c.ratios.categories).find(([, ratios]) => ratios[key]);
    if (!entry) continue;
    const [category, ratios] = entry;
    const s = ratios[key];
    const kind = CATEGORY_SOURCE[category] ?? "income";
    const year = s.series.at(-1)?.year;
    const url = latest?.sources[kind] ?? null;
    out.push({
      label: s.label,
      value: formatRatio(s, s.latest, cur),
      source: `${s.formulaId}${year ? `, FY${year}` : ""}${s.median10y !== null ? `; ${c.ratios.years.length}-year median ${formatRatio(s, s.median10y, cur)}` : ""}${category === "valuation" ? `; price ${c.raw.quote?.asOfTimestamp?.slice(0, 10) ?? ""}` : c.raw.market === "US" ? "; SEC EDGAR XBRL filing" : "; NSE XBRL filing"}`,
      url,
    });
  }
  return out;
}

// --- scores ------------------------------------------------------------------------------

const mean = (xs: (number | null)[]) => {
  const v = xs.filter((x): x is number => x !== null);
  return v.length ? Math.round(v.reduce((s, x) => s + x, 0) / v.length) : null;
};
const clamp = (v: number) => Math.max(0, Math.min(100, Math.round(v)));

export function scores(c: CompanyReports): FinalAnalysis["categoryScores"] {
  const r = c.ratios?.categoryScores;
  const mos = c.valuation?.marginOfSafety;
  const t = c.technical;
  let technical: number | null = null;
  if (t?.trendLabel) {
    technical = t.trendLabel === "uptrend" ? 70 : t.trendLabel === "downtrend" ? 30 : 50;
    if (t.rsi14 !== null) technical += t.rsi14 > 75 ? -5 : t.rsi14 < 25 ? 5 : 0;
    if (t.returns["1y"] !== null) technical += Math.max(-10, Math.min(10, t.returns["1y"] * 25));
    technical = clamp(technical);
  }
  const q = c.qualitative;
  let qualitative: number | null = null;
  if (q && q.moatSignals.length + q.managementSignals.length + q.risks.length > 0) {
    // Moat evidence and risks count in full; routine management items (a dividend, an appointment) count half.
    const weigh = (items: typeof q.risks, w: number) => items.reduce((s, i) => s + (i.sentiment === "positive" ? w : i.sentiment === "negative" ? -w : 0), 0);
    const balance = weigh(q.moatSignals, 1) + weigh(q.managementSignals, 0.5) + weigh(q.risks, 1);
    const count = q.moatSignals.length + q.managementSignals.length + q.risks.length;
    qualitative = clamp(50 + (30 * balance) / Math.max(4, count));
  }
  return {
    fundamental: mean([r?.fundamental ?? null, r?.financialHealth ?? null, r?.growth ?? null]),
    valuation: mean([r?.valuation ?? null, mos == null ? null : clamp(50 + mos * 100)]),
    technical,
    qualitative,
  };
}

/** The four scores weighted by the persona - how closely the company fits its principles, not a rating. */
export function personaFit(s: FinalAnalysis["categoryScores"], persona: Persona): number | null {
  let total = 0, used = 0;
  for (const k of ["fundamental", "valuation", "technical", "qualitative"] as const) {
    if (s[k] === null) continue;
    total += s[k]! * persona.weights[k];
    used += persona.weights[k];
  }
  return used >= 0.5 ? Math.round(total / used) : null;
}

// --- observations: rule-based strengths and concerns, used as hints and as the no-model answer ---

/**
 * Two points that say the same thing with the same figures are one point. For a services company the quick
 * ratio equals the current ratio, and both would otherwise be listed as separate strengths.
 */
function distinct(lines: string[]): string[] {
  const seen = new Map<string, string>();
  for (const line of lines) {
    const key = line.toLowerCase().replace(/\b(quick|current)\b/g, "").replace(/[^a-z0-9.%]+/g, "");
    if (!seen.has(key)) seen.set(key, line);
  }
  return [...seen.values()];
}

export function observations(c: CompanyReports, persona: Persona): { strengths: string[]; concerns: string[] } {
  const cur = c.raw.currency;
  const strengths: string[] = [], concerns: string[] = [];
  const th = persona.thresholds;
  const r = c.ratios;
  const roe = findRatio(r, "roe");
  if (roe?.latest != null && th.roe !== undefined) {
    const years = roe.series.filter((p) => p.value !== null);
    const above = years.filter((p) => p.value! >= th.roe).length;
    (roe.latest >= th.roe ? strengths : concerns).push(`Return on equity was ${percent(roe.latest)} in FY${roe.series.at(-1)?.year}; it reached the ${percent(th.roe, 0)} threshold in ${above} of ${years.length} years on record.`);
  }
  const de = findRatio(r, "debtToEquity");
  if (de?.latest != null && th.debtToEquity !== undefined && c.raw.sectorSet !== "financial") {
    (de.latest <= th.debtToEquity ? strengths : concerns).push(`Debt to equity is ${times(de.latest)}, against the ${times(th.debtToEquity, 1)} this persona treats as conservative.`);
  }
  const cover = findRatio(r, "interestCoverage");
  if (cover?.latest != null && th.interestCoverage !== undefined && c.raw.sectorSet !== "financial") {
    (cover.latest >= th.interestCoverage ? strengths : concerns).push(`Operating profit covers interest ${times(cover.latest, 1)}.`);
  }
  const fcf = findRatio(r, "freeCashFlow");
  if (fcf?.latest != null && c.raw.sectorSet !== "financial") {
    (fcf.latest > 0 ? strengths : concerns).push(`Free cash flow was ${big(cur, fcf.latest)} in FY${fcf.series.at(-1)?.year}.`);
  }
  const conv = findRatio(r, "cashConversion");
  if (conv?.latest != null && th.cashConversion !== undefined && c.raw.sectorSet !== "financial") {
    (conv.latest >= th.cashConversion ? strengths : concerns).push(`Operating cash flow was ${percent(conv.latest, 0)} of net profit.`);
  }
  const margin = findRatio(r, "netMargin");
  if (margin?.trend === "declining") concerns.push(`Net margin has been declining over the last five years (now ${percent(margin.latest)}).`);
  if (margin?.trend === "improving") strengths.push(`Net margin has been improving over the last five years (now ${percent(margin.latest)}).`);
  const peg = findRatio(r, "peg");
  if (peg?.latest != null && persona.keyMetrics.includes("peg")) {
    (peg.latest <= 1 ? strengths : peg.latest > 2 ? concerns : strengths).push(`The PEG ratio is ${times(peg.latest)}${peg.latest <= 1 ? ", meaning the P/E is no higher than the growth rate" : peg.latest > 2 ? ", meaning the P/E is more than twice the five-year EPS growth rate" : ""}.`);
  }
  const v = c.valuation;
  if (v?.marginOfSafety != null) {
    (v.meetsRequirement ? strengths : concerns).push(`The base-case valuation leaves a margin of safety of ${percent(v.marginOfSafety)}, against the ${percent(v.requiredMarginOfSafety, 0)} this persona requires.`);
  }
  const q = r?.qualityScores;
  if (q?.piotroski.score != null) (q.piotroski.score >= 7 ? strengths : q.piotroski.score <= 3 ? concerns : strengths).push(`Piotroski F-score of ${q.piotroski.score} out of 9.`);
  if (q?.altmanZ.zone === "distress") concerns.push(`The Altman Z'' score of ${q.altmanZ.score?.toFixed(2)} is in the distress zone.`);
  if (q?.beneishM.flag) concerns.push(`The Beneish M-score of ${q.beneishM.score?.toFixed(2)} is above -1.78, a pattern associated with earnings manipulation; worth checking the accounts.`);
  for (const risk of c.qualitative?.risks.slice(0, 2) ?? []) if (risk.sentiment === "negative") concerns.push(risk.summary);
  return { strengths: distinct(strengths).slice(0, 6), concerns: distinct(concerns).slice(0, 6) };
}

// --- the fact sheet the model writes from ---------------------------------------------------

/** "above", "below" or "in line with" - worked out here so the writer never has to compare two numbers itself. */
const relation = (value: number | null, reference: number | null) => {
  if (value === null || reference === null) return "compared with";
  const gap = reference === 0 ? value : (value - reference) / Math.abs(reference);
  return Math.abs(gap) < 0.02 ? "in line with" : value > reference ? "above" : "below";
};

/**
 * Which company is stronger on each measure, worked out here (design principle 1: code calculates, the model
 * explains). Without this the writer compares the numbers itself, and a sentence such as "its liquidity is
 * higher" can come out backwards even though both figures are on the fact sheet.
 *
 * Only ratios, percentages and multiples are compared. Absolute amounts are never compared across companies in
 * different currencies: ₹42,516 Cr of free cash flow is not "larger" than $10.9bn (spec §5.0).
 */
export interface ComparisonFact {
  key: string; label: string; better: "higher" | "lower";
  values: { symbol: string; company: string; value: number; shown: string }[];
  /** The symbol that is stronger on this measure, or null when the two are within 2% of each other. */
  leader: string | null;
  sentence: string;
}

const COMPARABLE: { key: string; better: "higher" | "lower" }[] = [
  { key: "grossMargin", better: "higher" }, { key: "operatingMargin", better: "higher" }, { key: "netMargin", better: "higher" },
  { key: "ebitdaMargin", better: "higher" }, { key: "roe", better: "higher" }, { key: "roa", better: "higher" },
  { key: "roce", better: "higher" }, { key: "roic", better: "higher" }, { key: "currentRatio", better: "higher" },
  { key: "quickRatio", better: "higher" }, { key: "cashRatio", better: "higher" }, { key: "debtToEquity", better: "lower" },
  { key: "interestCoverage", better: "higher" }, { key: "netDebtToEbitda", better: "lower" }, { key: "assetTurnover", better: "higher" },
  { key: "cashConversion", better: "higher" }, { key: "fcfMargin", better: "higher" }, { key: "fcfYield", better: "higher" },
  { key: "revenueCagr3y", better: "higher" }, { key: "revenueCagr5y", better: "higher" }, { key: "epsCagr3y", better: "higher" },
  { key: "epsCagr5y", better: "higher" }, { key: "pe", better: "lower" }, { key: "pb", better: "lower" },
  { key: "evEbitda", better: "lower" }, { key: "peg", better: "lower" }, { key: "dividendYield", better: "higher" },
  { key: "payoutRatio", better: "higher" }, { key: "netInterestMargin", better: "higher" }, { key: "costToIncome", better: "lower" },
];

export function comparisonFacts(companies: CompanyReports[]): ComparisonFact[] {
  if (companies.length < 2) return [];
  const name = (c: CompanyReports) => c.raw.company ?? c.raw.symbol;
  const out: ComparisonFact[] = [];

  for (const { key, better } of COMPARABLE) {
    const values = companies.flatMap((c) => {
      const s = findRatio(c.ratios, key);
      // An amount in rupees and an amount in dollars are not comparable; a ratio or a percentage is.
      if (!s || s.latest === null || s.unit === "currency") return [];
      return [{ symbol: c.raw.symbol, company: name(c), value: s.latest, shown: formatRatio(s, s.latest, c.raw.currency), label: s.label }];
    });
    if (values.length < 2) continue;
    const label = values[0].label;
    const sorted = [...values].sort((a, b) => (better === "higher" ? b.value - a.value : a.value - b.value));
    const [first, second] = sorted;
    const gap = Math.abs(second.value) < 1e-9 ? Math.abs(first.value) : Math.abs((first.value - second.value) / second.value);
    const leader = gap < 0.02 ? null : first.symbol;
    out.push({
      key, label, better, leader,
      values: values.map(({ symbol, company, value, shown }) => ({ symbol, company, value, shown })),
      sentence: leader === null
        ? `${label}: ${values.map((v) => `${v.company} ${v.shown}`).join(" and ")} - the two are in line with each other.`
        : `${label}: ${sorted.map((v) => `${v.company} ${v.shown}`).join(" vs ")}; ${first.company} is ${better === "higher" ? "higher" : "lower"}, which is the stronger of the two on this measure.`,
    });
  }

  // Margin of safety is a pass or fail against the persona's requirement, not a ranking.
  for (const c of companies) {
    const v = c.valuation;
    if (!v || v.marginOfSafety === null) continue;
    out.push({
      key: `marginOfSafety:${c.raw.symbol}`, label: "Margin of safety", better: "higher", leader: null,
      values: [{ symbol: c.raw.symbol, company: name(c), value: v.marginOfSafety, shown: percent(v.marginOfSafety) }],
      sentence: `Margin of safety for ${name(c)}: ${percent(v.marginOfSafety)} against the ${percent(v.requiredMarginOfSafety, 0)} this persona requires - it ${v.meetsRequirement ? "meets" : "does NOT meet"} the requirement.`,
    });
  }
  return out;
}

/** Ratios whose names invite a wrong reading get their formula beside them in the facts. */
const EASY_TO_MISREAD: Record<string, string> = {
  operatingCashFlowRatio: "operating cash flow ÷ current liabilities",
  cashConversion: "operating cash flow ÷ net income",
  cashRatio: "cash ÷ current liabilities",
  equityMultiplier: "total assets ÷ equity",
  cashConversionCycle: "days receivable + days inventory − days payable",
  capexIntensity: "capital expenditure ÷ revenue",
  earningsYield: "EPS ÷ price",
  netDebtToEbitda: "(debt − cash) ÷ EBITDA; negative means net cash",
  roic: "after-tax EBIT ÷ (debt + equity − cash)",
};

function factSheet(c: CompanyReports, persona: Persona): string {
  const cur = c.raw.currency;
  const lines: string[] = [];
  const r = c.ratios;
  lines.push(`COMPANY: ${c.raw.company ?? c.raw.symbol} (${c.raw.ticker}, ${c.raw.exchange}, ${c.raw.market === "US" ? "United States" : "India"}), ${c.raw.industry ?? "industry not on record"}, ${c.raw.sectorSet === "financial" ? "financial-sector ratio set" : "standard ratio set"}; amounts in ${cur}; fiscal year ends ${c.raw.fiscalYearEnd ?? "unknown"}`);
  lines.push(`PRICE: ${money(cur, c.raw.quote?.lastPrice)} as of ${c.raw.quote?.asOfTimestamp?.slice(0, 10) ?? "unknown"}; market cap ${big(cur, c.raw.marketCap)}`);
  if (r) {
    lines.push(`FISCAL YEARS ON RECORD: FY${r.years[0]}-FY${r.years.at(-1)} (${r.years.length})`);
    for (const [category, ratios] of Object.entries(r.categories)) {
      const parts = Object.entries(ratios).filter(([, s]) => s.latest !== null).map(([key, s]) =>
        `${s.label}${EASY_TO_MISREAD[key] ? ` (${EASY_TO_MISREAD[key]})` : ""} ${formatRatio(s, s.latest, cur)}${s.median10y !== null && s.series.length > 1 ? ` (${relation(s.latest, s.median10y)} the company's own ${s.series.length}-year median ${formatRatio(s, s.median10y, cur)}` + `${s.trend ? `; trend ${s.trend}` : ""})` : ""}${s.sectorMedian !== null ? ` [${relation(s.latest, s.sectorMedian)} the median of sector peers ${formatRatio(s, s.sectorMedian, cur)}]` : " [no sector comparison]"}`);
      if (parts.length) lines.push(`${category.toUpperCase()}: ${parts.join("; ")}`);
    }
    const q = r.qualityScores;
    lines.push(`QUALITY: Piotroski ${q.piotroski.score ?? "not available"}/9; Altman Z'' ${q.altmanZ.score?.toFixed(2) ?? `not available (${q.altmanZ.reason})`}${q.altmanZ.zone ? ` ${q.altmanZ.zone}` : ""}; Beneish M ${q.beneishM.score?.toFixed(2) ?? "not available"}${q.beneishM.flag ? " (flag)" : ""}`);
  }
  const v = c.valuation;
  if (v) {
    lines.push(`VALUATION: ${v.scenarios.map((s) => `${s.name} ${money(cur, s.intrinsicValuePerShare)}`).join(", ")} per share; margin of safety ${percent(v.marginOfSafety)} vs required ${percent(v.requiredMarginOfSafety, 0)}; P/E ${times(v.relativeMultiples.pe, 1)} vs own median ${times(v.relativeMultiples.peOwnMedian, 1)} and sector ${times(v.relativeMultiples.peSector, 1)}; P/B ${times(v.relativeMultiples.pb, 1)} vs sector ${times(v.relativeMultiples.pbSector, 1)}`);
  }
  const t = c.technical;
  if (t) lines.push(`PRICE TREND: ${t.trendLabel ?? "not available"}; 50-day average ${money(cur, t.ma50)}, 200-day ${money(cur, t.ma200)}; 52-week range ${money(cur, t.low52w)}-${money(cur, t.high52w)}; returns 1y ${percent(t.returns["1y"])}, 3y ${percent(t.returns["3y"])}, 5y ${percent(t.returns["5y"])}; RSI(14) ${t.rsi14?.toFixed(0) ?? "not available"}`);
  const q = c.qualitative;
  if (q) {
    const items = [...q.moatSignals.map((i) => ["MOAT", i] as const), ...q.managementSignals.map((i) => ["MANAGEMENT", i] as const), ...q.risks.map((i) => ["RISK", i] as const)];
    for (const [kind, i] of items.slice(0, 15)) lines.push(`${kind} (${i.sentiment}, ${i.date ?? "undated"}): ${i.summary}`);
  }
  const obs = observations(c, persona);
  if (obs.strengths.length) lines.push(`RULE-BASED STRENGTHS: ${obs.strengths.join(" ")}`);
  if (obs.concerns.length) lines.push(`RULE-BASED CONCERNS: ${obs.concerns.join(" ")}`);
  return lines.join("\n");
}

/** The spec asks for ten years; a shorter history is a gap in the analysis and is listed as one (spec §4.1). */
const YEARS_WANTED = 10;

function missing(c: CompanyReports): string[] {
  const own: { key: string; reason: string }[] = [];
  const years = c.ratios?.years.length ?? c.raw.annual.length;
  if (years > 0 && years < YEARS_WANTED) {
    own.push({ key: "history", reason: `only ${years} complete fiscal years are on record for ${c.raw.symbol}, not the ${YEARS_WANTED} the medians and trends are meant to use` });
  }
  // The filings reader produced nothing at all: say so, rather than leaving the qualitative score blank.
  const q = c.qualitative;
  if (!q || q.moatSignals.length + q.managementSignals.length + q.risks.length === 0) {
    own.push({ key: "moat, management and risk signals", reason: `no signals were read from ${c.raw.symbol}'s filings, so the qualitative score is not available` });
  }
  const all = [...own, ...c.raw.unavailable, ...(c.ratios?.unavailable ?? []), ...(c.valuation?.unavailable ?? []), ...(c.technical?.unavailable ?? []), ...(c.qualitative?.unavailable ?? [])];
  const seen = new Set<string>();
  return all.filter((u) => (seen.has(u.key) ? false : (seen.add(u.key), true))).map((u) => `${u.key.replace(/_/g, " ")}: ${u.reason.replace(/_/g, " ")}`);
}

/**
 * How a persona is named in the writing. A persona named after a person is "inspired by the principles of Peter
 * Lynch"; one named after a framework is "inspired by the CANSLIM growth framework" - "the CANSLIM growth
 * framework-inspired principles" is not English.
 */
const named = (persona: Persona) => /^the /i.test(persona.inspiredBy);
const inspiredBy = (persona: Persona) => (named(persona)
  ? `inspired by ${persona.inspiredBy}`
  : `"inspired by the investing principles of ${persona.inspiredBy}"`);
const against = (persona: Persona) => (named(persona)
  ? `against ${persona.inspiredBy}`
  : `against ${persona.inspiredBy}-inspired principles`);

// --- the writer --------------------------------------------------------------------------

export interface SynthesisInput {
  question: string;
  intent: Intent;
  persona: Persona;
  companies: CompanyReports[];
  validation: ValidationReport;
  metric: string | null;
  allowFollowUp: boolean;
}

interface Draft { summary?: unknown; strengths?: unknown; concerns?: unknown; sections?: unknown; follow_up?: unknown }

const asList = (v: unknown) => (Array.isArray(v) ? v.map((s) => String(s).trim()).filter(Boolean).slice(0, 8) : []);

/** The sections the long-form analysis is written in, by the kind of question. */
function sectionTitles(intent: Intent): string[] {
  if (intent === "comparison") return ["Profitability and returns", "Balance sheet and cash flow", "Growth", "Valuation", "Price trend", "Where each is stronger"];
  if (intent === "single_metric") return ["The direct answer", "Ten-year history", "Against sector peers", "Related measures", "What would change the picture"];
  return ["Business quality and moat", "Profitability and returns", "Balance sheet and cash flow", "Growth", "Valuation and margin of safety", "Price trend", "Management and risks", "What would change the picture"];
}

const asSections = (v: unknown): { title: string; body: string }[] =>
  (Array.isArray(v) ? v : []).map((x) => ({ title: String((x as { title?: unknown })?.title ?? "").trim(), body: String((x as { body?: unknown })?.body ?? "").trim() }))
    .filter((x) => x.title && x.body).slice(0, 10);

/**
 * The same sections written from the reports alone: every sentence is a figure from a report with the comparison
 * worked out in code. Used when no model is available, and to fill any section the model left out.
 */
function dataSections(companies: CompanyReports[], persona: Persona, intent: Intent): { title: string; body: string }[] {
  const lines = (c: CompanyReports, keys: string[]) => keys.flatMap((key) => {
    const r = findRatio(c.ratios, key);
    if (!r || r.latest === null) return [];
    const cur = c.raw.currency;
    const own = r.series.length > 1 && r.median10y !== null ? `, ${relation(r.latest, r.median10y)} its own ${r.series.length}-year median of ${formatRatio(r, r.median10y, cur)}` : "";
    const peers = r.sectorMedian !== null ? ` and ${relation(r.latest, r.sectorMedian)} the sector median of ${formatRatio(r, r.sectorMedian, cur)}` : "";
    const trend = r.trend ? ` (trend ${r.trend})` : "";
    return [`${r.label} is ${formatRatio(r, r.latest, cur)}${own}${peers}${trend}.`];
  });
  const name = (c: CompanyReports) => (companies.length > 1 ? `${c.raw.company ?? c.raw.symbol}: ` : "");
  const each = (keys: string[]) => companies.map((c) => `${name(c)}${lines(c, keys).join(" ")}`).filter((t) => t.replace(/^[^:]*: /, "").trim()).join(" ");
  const bank = companies[0].raw.sectorSet === "financial";
  const out: { title: string; body: string }[] = [];
  const add = (title: string, body: string) => { if (body.trim()) out.push({ title, body: body.trim() }); };

  const primary = companies[0];
  const q = primary.qualitative;
  add("Business quality and moat", [
    each(bank ? ["roe", "roa", "netInterestMargin"] : ["roce", "roic", "grossMargin", "operatingMargin"]),
    q?.moatSignals.length ? `Moat evidence from filings: ${q.moatSignals.slice(0, 3).map((i) => i.summary.replace(/\.$/, "")).join("; ")}.` : "No moat evidence was found in the filings read.",
  ].join(" "));
  add("Profitability and returns", each(bank ? ["roe", "roa", "netInterestMargin", "costToIncome"] : ["operatingMargin", "netMargin", "ebitdaMargin", "roe", "roa"]));
  add("Balance sheet and cash flow", each(bank ? ["equityMultiplier", "creditToDeposit", "payoutRatio"] : ["debtToEquity", "interestCoverage", "netDebtToEbitda", "currentRatio", "freeCashFlow", "cashConversion", "fcfMargin"]));
  add("Growth", each(["revenueCagr3y", "revenueCagr5y", "epsCagr3y", "epsCagr5y", "fcfCagr5y", "bvpsCagr5y"]));
  add(intent === "comparison" ? "Valuation" : "Valuation and margin of safety", [
    each(["pe", "pb", "evEbitda", "peg", "dividendYield", "fcfYield"]),
    ...companies.map((c) => {
      const v = c.valuation;
      if (!v) return "";
      const base = v.scenarios.find((x) => x.name === "base")?.intrinsicValuePerShare ?? null;
      return base === null ? "" : `${name(c)}The base-case value is ${money(c.raw.currency, base)} per share against a price of ${money(c.raw.currency, v.currentPrice)}, a margin of safety of ${percent(v.marginOfSafety)} ${v.meetsRequirement ? "which meets" : "which is short of"} the ${percent(persona.requiredMarginOfSafety, 0)} this persona requires.`;
    }),
  ].join(" "));
  add("Price trend", companies.map((c) => {
    const t = c.technical;
    if (!t) return "";
    return `${name(c)}The price trend is ${t.trendLabel ?? "not classified"}, with the 50-day average at ${money(c.raw.currency, t.ma50)} and the 200-day at ${money(c.raw.currency, t.ma200)}. The 52-week range is ${money(c.raw.currency, t.low52w)} to ${money(c.raw.currency, t.high52w)}; returns are ${percent(t.returns["1y"])} over one year and ${percent(t.returns["3y"])} over three.`;
  }).join(" "));
  if (intent !== "comparison") {
    add("Management and risks", [
      q?.managementSignals.length ? `Management: ${q.managementSignals.slice(0, 3).map((i) => i.summary.replace(/\.$/, "")).join("; ")}.` : "",
      q?.risks.length ? `Risks: ${q.risks.slice(0, 4).map((i) => i.summary.replace(/\.$/, "")).join("; ")}.` : "No risk signals were found in the filings read.",
      primary.ratios?.qualityScores.piotroski.score != null ? `The Piotroski F-score is ${primary.ratios.qualityScores.piotroski.score} out of 9.` : "",
      primary.ratios?.qualityScores.beneishM.flag ? `The Beneish M-score of ${primary.ratios.qualityScores.beneishM.score?.toFixed(2)} is above -1.78, which calls for a closer reading of the accounts.` : "",
    ].join(" "));
  }
  return out;
}

export async function synthesise(trace: Trace, input: SynthesisInput): Promise<{ final: FinalAnalysis; followUp: FollowUp | null }> {
  const { persona, companies } = input;
  const primary = companies[0];
  const categoryScores = scores(primary);
  const missingData = [...new Set(companies.flatMap(missing))];
  const reports = companies.map((c) => ({ ratios: c.ratios, valuation: c.valuation, technical: c.technical, qualitative: c.qualitative, quote: c.raw.quote, marketCap: c.raw.marketCap, years: c.raw.annual.map((a) => a.year) }));
  // Plus the fixed reference points the writing may name: "out of 100", "the 50-day average", Beneish's -1.78.
  const conventions = [100, 50, 200, 52, 14, 9, 1.78, 2.6, 1.1, 365];
  const pool = numberPool([reports, categoryScores, persona.thresholds, persona.requiredMarginOfSafety, persona.dcfGrowthCap, conventions.map((n) => n / 100)]);
  // US amounts are written in millions and billions.
  for (const v of numberPool(reports)) if (Math.abs(v) >= 1e6) pool.push(v / 1e6, v / 1e9);
  const facts = companies.map((c) => factSheet(c, persona)).join("\n\n");
  // In a comparison the arithmetic is done here, not by the writer (spec principle 1).
  const compared = comparisonFacts(companies);
  const warnings = input.validation.warnings.map((w) => w.detail);

  const perCompany = companies.map((c) => {
    const cs = scores(c);
    return {
      symbol: c.raw.symbol, company: c.raw.company ?? c.raw.symbol, currency: c.raw.currency,
      categoryScores: cs, personaFit: personaFit(cs, persona), keyNumbers: keyNumbers(c, persona),
    };
  });

  const base: Omit<FinalAnalysis, "summary" | "strengths" | "concerns" | "writtenBy"> = {
    personaId: persona.id,
    personaName: persona.name,
    keyNumbers: keyNumbers(primary, persona),
    categoryScores,
    personaFit: personaFit(categoryScores, persona),
    // Every company in the answer gets its own scores and key numbers; one persona score for two companies
    // says nothing about either.
    companies: companies.length > 1 ? perCompany : undefined,
    comparison: compared.length ? compared.map((f) => f.sentence) : undefined,
    missingData,
    disclaimer: DISCLAIMER,
    removed: [],
  };

  const lenderLeverage = primary.raw.sectorSet === "financial" && /debt|leverage|borrow/i.test(`${input.metric ?? ""} ${input.question}`)
    ? " This is a lender: deposits and borrowings are its raw material, not debt in the industrial sense, so debt to equity does not apply. Judge its leverage from the equity multiplier (assets per rupee of equity) and the credit-to-deposit ratio in the FACTS, and say that the capital adequacy ratio, the regulator's measure, is not available here."
    : "";
  const focus = input.intent === "single_metric" ? `Answer the specific question about ${input.metric ?? "the metric asked"} first and directly; keep the rest brief.${lenderLeverage}`
    : input.intent === "comparison" ? `Compare the two companies ratio by ratio, never by absolute amounts, and say where each is stronger. The block "COMPARISON WORKED OUT HERE" already says which company is stronger on each measure and whether each meets the persona's margin of safety: repeat what it says and never work a comparison out yourself. Strengths and concerns may name either company.${new Set(companies.map((c) => c.raw.market)).size > 1 ? " They are listed in different markets and report in different currencies: compare only ratios, name both currencies, and never compare a company with the other market's sector medians." : ""}`
    : "Give a full analysis.";

  const system = [
    persona.systemPrompt.replace(/\s+/g, " "),
    `You write an analysis ${inspiredBy(persona)}. Never write as if you are ${persona.inspiredBy}, never use "I", and never quote or paraphrase anyone.`,
    "Use ONLY the FACTS supplied. Every number you write must appear in the FACTS exactly as written there. Never calculate a new number, never round differently, never estimate.",
    "When you compare a figure with a median or with peers, use the word the FACTS give (above, below, in line with); never decide the direction yourself.",
    "If something important is not in the FACTS, say it is not available. Keep the company's own history and its sector peers distinct: never call an own median a sector median.",
    "Never tell the reader to buy, sell, hold, accumulate or exit, never give a price target or entry level, and never predict the share price. Describe what the figures show against the persona's principles and let the reader judge.",
    focus,
    `Write a thorough analysis. Return JSON only: {"summary": 5-7 plain sentences that answer the question, "strengths": [up to 7 one-sentence points, each with its figure], "concerns": [up to 7 one-sentence points, each with its figure], "sections": [{"title": one of ${JSON.stringify(sectionTitles(input.intent))}, "body": 3-5 sentences using the FACTS}, one object for every title, in that order]` +
      (input.allowFollowUp ? ", \"follow_up\": null or {\"worker\": \"data_agent\"|\"news_moat_agent\"|\"valuation_agent\"|\"technical_agent\", \"questions\": [for news_moat_agent or data_agent], \"reason\": why this is essential}" : "") + "}.",
    input.allowFollowUp ? "Ask for a follow_up only if something essential to this persona's judgement is missing and that worker could supply it: data_agent fetches the company's recent filing documents (annual report, presentations) for more evidence on moat and management; otherwise null." : "",
    "Plain sentences, no markdown.",
  ].filter(Boolean).join(" ");
  const user = `QUESTION: ${input.question}\n\nFACTS\n${facts}${compared.length ? `\n\nCOMPARISON WORKED OUT HERE (use these, never compare the numbers yourself)\n${compared.map((f) => f.sentence).join("\n")}` : ""}${warnings.length ? `\n\nDATA WARNINGS (mention any that matter)\n${warnings.join("\n")}` : ""}\n\nMISSING DATA\n${missingData.slice(0, 15).join("\n") || "none"}`;

  const fallback = () => {
    const obs = observations(primary, persona);
    const sections = dataSections(companies, persona, input.intent);
    const s = categoryScores;
    const summary = [
      `This is a rule-based reading of ${primary.raw.company ?? primary.raw.symbol} ${against(persona)}, written from the reports without a language model.`,
      s.fundamental !== null ? `Fundamentals score ${s.fundamental} out of 100 against sector peers and its own history.` : "",
      s.valuation !== null ? `Valuation scores ${s.valuation} out of 100.` : "",
      primary.valuation?.marginOfSafety != null ? `The base-case margin of safety is ${percent(primary.valuation.marginOfSafety)} against the ${percent(persona.requiredMarginOfSafety, 0)} required.` : "",
    ].filter(Boolean).join(" ");
    return { summary, strengths: obs.strengths, concerns: obs.concerns, sections };
  };

  let reply = await trace.llm("synthesis", { system, user, json: true, temperature: 0.3, maxTokens: 3200 });
  let draft = parseJson<Draft>(reply.text);
  if (reply.text && !draft) {
    reply = await trace.llm("synthesis", { system, json: true, temperature: 0.2, maxTokens: 3200, user: `${user}\n\nYour previous reply was not valid JSON. Return only the JSON object.` });
    draft = parseJson<Draft>(reply.text);
  }
  if (!draft) {
    const f = fallback();
    return { final: { ...base, ...f, writtenBy: "data", note: reply.error && reply.error !== "no key configured" ? `The model was unavailable (${reply.error}); written from the data.` : undefined }, followUp: null };
  }

  const textOf = (d: Draft) => [String(d.summary ?? ""), ...asList(d.strengths), ...asList(d.concerns), ...asSections(d.sections).map((x) => x.body)].join(" ");
  const problemsIn = (d: Draft) => [
    ...ungroundedNumbers(textOf(d), pool),
    ...contradictions(textOf(d)).map((c) => `wrong direction in "${c}"`),
    ...wrongComparisons(textOf(d), compared).map((c) => `contradicts the worked-out comparison: "${c}"`),
  ];
  let bad = problemsIn(draft);
  if (bad.length) {
    // Regenerate once, naming the numbers that were not in the facts (spec §8.1).
    const again = await trace.llm("synthesis", {
      system, json: true, temperature: 0.1, maxTokens: 3200,
      user: `${user}\n\nYour previous draft had problems: ${bad.join("; ")}. Rewrite it using only numbers that appear in the FACTS, and use the comparison words the FACTS give.`,
    });
    const redraft = parseJson<Draft>(again.text);
    if (redraft) {
      draft = { ...redraft, follow_up: redraft.follow_up ?? draft.follow_up };
      bad = problemsIn(draft);
    }
  }

  // Strip what is still ungrounded, then anything that reads as advice.
  const removed: string[] = [];
  const clean = (s: string) => {
    let out = s;
    if (ungroundedNumbers(out, pool).length) {
      const sentences = out.match(/[^.!?]+[.!?]*\s*/g) ?? [out];
      out = sentences.filter((x) => {
        const drop = ungroundedNumbers(x, pool).length > 0;
        if (drop) removed.push(`ungrounded number: ${x.trim()}`);
        return !drop;
      }).join("").trim();
    }
    for (const wrong of contradictions(out)) {
      removed.push(`wrong comparison: ${wrong}`);
      out = out.replace(wrong, "").replace(/\s{2,}/g, " ").trim();
    }
    // A sentence that claims the opposite of the comparison worked out in code goes too.
    for (const wrong of wrongComparisons(out, compared)) {
      removed.push(`contradicts the data: ${wrong}`);
      out = out.replace(wrong, "").replace(/\s{2,}/g, " ").trim();
    }
    const scrubbed = scrub(out);
    removed.push(...scrubbed.removed.map((x) => `advice language: ${x}`));
    return scrubbed.text;
  };
  const summary = clean(String(draft.summary ?? ""));
  const strengths = asList(draft.strengths).map(clean).filter(Boolean);
  const concerns = asList(draft.concerns).map(clean).filter(Boolean);
  const f = fallback();
  // The model's sections, checked like the rest; any section it left out or that the checks emptied comes from the data.
  const written = asSections(draft.sections).map((x) => ({ title: x.title, body: clean(x.body) })).filter((x) => x.body);
  const sections = [
    ...written,
    ...f.sections.filter((d) => !written.some((w) => w.title.toLowerCase() === d.title.toLowerCase())),
  ];

  let followUp: FollowUp | null = null;
  const fu = draft.follow_up as Record<string, unknown> | null | undefined;
  if (input.allowFollowUp && fu && typeof fu === "object" && ["data_agent", "news_moat_agent", "valuation_agent", "technical_agent"].includes(String(fu.worker))) {
    followUp = { worker: fu.worker as FollowUp["worker"], questions: asList(fu.questions).slice(0, 3), growth: typeof fu.growth === "number" ? fu.growth : undefined, reason: String(fu.reason ?? "").slice(0, 200) };
  }

  return {
    final: {
      ...base,
      summary: summary || f.summary,
      strengths: strengths.length ? strengths : f.strengths,
      concerns: concerns.length ? concerns : f.concerns,
      sections,
      writtenBy: "model",
      model: reply.model,
      removed,
    },
    followUp,
  };
}
