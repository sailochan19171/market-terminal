// The valuation agent (spec §3.5): discounted cash flow in three scenarios, multiples against the company's own
// history and its sector, and a margin of safety against the persona's requirement.
//
// A model may suggest assumptions, but the arithmetic is here and every assumption is clamped to a range before
// it is used - a suggestion of 40% growth for ten years becomes the persona's cap, and says so.
import { median } from "../util";
import type { Persona } from "./config";
import type { RatioReport, RawData, Unavailable, ValuationReportOut, ValuationScenario } from "./state";
import { parseJson, type Trace } from "./trace";

export interface Suggested { growth?: number; discountRate?: number; terminalGrowth?: number; rationale?: string; by?: "model" | "plan" }

/** The allowed ranges. Whatever a model suggests, the arithmetic only ever sees values inside these. */
export const RANGES = {
  growth: [0, 0.25] as const,
  discountRate: { INR: [0.1, 0.16] as const, USD: [0.07, 0.13] as const },
  terminalGrowth: { INR: [0.03, 0.06] as const, USD: [0.015, 0.035] as const },
};

/**
 * The model may suggest assumptions (spec §3.5); it sees the measured history and the persona's cap, and must
 * explain itself. Its numbers are clamped by `valuationReport` before any arithmetic, and the clamp is recorded.
 */
export async function suggestAssumptions(trace: Trace, raw: RawData, ratios: RatioReport, persona: Persona): Promise<Suggested> {
  const find = (key: string) => Object.values(ratios.categories).map((c) => c[key]).find(Boolean)?.latest ?? null;
  const pct = (v: number | null) => (v === null ? "not available" : `${(v * 100).toFixed(1)}%`);
  const history = [
    `revenue CAGR 3y ${pct(find("revenueCagr3y"))}, 5y ${pct(find("revenueCagr5y"))}, 10y ${pct(find("revenueCagr10y"))}`,
    `EPS CAGR 3y ${pct(find("epsCagr3y"))}, 5y ${pct(find("epsCagr5y"))}`,
    `free cash flow CAGR 3y ${pct(find("fcfCagr3y"))}, 5y ${pct(find("fcfCagr5y"))}`,
    `return on equity ${pct(find("roe"))}, net margin ${pct(find("netMargin"))}, debt to equity ${find("debtToEquity")?.toFixed(2) ?? "not available"}`,
  ].join("; ");
  const cur = raw.currency;
  const reply = await trace.llm("valuation_agent", {
    system: [
      `Suggest discounted-cash-flow assumptions for an analysis inspired by ${persona.inspiredBy}'s principles. You suggest; code does all arithmetic.`,
      `Return JSON only: {"growth": starting annual free-cash-flow growth as a decimal, "discount_rate": decimal, "terminal_growth": decimal, "rationale": one sentence}.`,
      `Growth may not exceed the persona's cap of ${persona.dcfGrowthCap}. The company reports in ${cur}; a sensible discount rate range is ${RANGES.discountRate[cur].join("-")} and terminal growth ${RANGES.terminalGrowth[cur].join("-")}.`,
      "Be conservative where history is short, volatile or declining. Base the suggestion only on the history given.",
    ].join(" "),
    user: `COMPANY: ${raw.company ?? raw.symbol} (${raw.ticker}), ${raw.industry ?? "industry not on record"}, ${raw.sectorSet} ratio set
HISTORY: ${history}`,
    json: true, temperature: 0, maxTokens: 500,
  });
  const got = parseJson<{ growth?: unknown; discount_rate?: unknown; terminal_growth?: unknown; rationale?: unknown }>(reply.text);
  if (!got) return {};
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? (Math.abs(v) > 1 ? v / 100 : v) : undefined);
  return { growth: num(got.growth), discountRate: num(got.discount_rate), terminalGrowth: num(got.terminal_growth), rationale: String(got.rationale ?? "").slice(0, 300), by: "model" };
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Present value per share of a cash stream that fades linearly from `growth` to `terminal` over ten years. */
export function dcf(base: number, growth: number, discountRate: number, terminal: number, netDebt: number, shares: number, years = 10): number | null {
  if (!(base > 0) || !(shares > 0) || discountRate <= terminal) return null;
  let pv = 0;
  let cash = base;
  for (let y = 1; y <= years; y++) {
    cash *= 1 + growth + ((terminal - growth) * (y - 1)) / (years - 1);
    pv += cash / (1 + discountRate) ** y;
  }
  pv += (cash * (1 + terminal)) / (discountRate - terminal) / (1 + discountRate) ** years;
  return (pv - netDebt) / shares;
}

/** Justified price-to-book for a lender: (ROE − g) ÷ (r − g), times book value per share. */
export function justifiedPb(roe: number, growth: number, discountRate: number, bvps: number): number | null {
  if (!(bvps > 0) || discountRate <= growth || roe <= growth) return null;
  return ((roe - growth) / (discountRate - growth)) * bvps;
}

export function valuationReport(raw: RawData, ratios: RatioReport, persona: Persona, suggested: Suggested = {}): ValuationReportOut {
  const unavailable: Unavailable[] = [];
  const price = raw.quote?.lastPrice ?? null;
  const newestFirst = [...raw.annual].sort((a, b) => b.year - a.year);
  const latest = newestFirst[0];
  const shares = raw.sharesOutstanding ?? latest?.sharesDiluted ?? null;
  const find = (key: string) => Object.values(ratios.categories).map((c) => c[key]).find(Boolean);

  // Growth: the measured five-year free cash flow CAGR, else revenue, clamped to [0, persona cap].
  const measured = find("fcfCagr5y")?.latest ?? find("revenueCagr5y")?.latest ?? find("revenueCagr3y")?.latest ?? null;
  const growthSource = find("fcfCagr5y")?.latest != null ? "5-year free cash flow CAGR" : find("revenueCagr5y")?.latest != null ? "5-year revenue CAGR" : find("revenueCagr3y")?.latest != null ? "3-year revenue CAGR" : "none measured; 5% assumed";
  const cur = raw.currency;
  const notes: string[] = [];
  const wanted = suggested.growth ?? measured ?? 0.05;
  const growth = clamp(wanted, RANGES.growth[0], Math.min(RANGES.growth[1], persona.dcfGrowthCap));
  const capped = wanted > persona.dcfGrowthCap;
  const wantedRate = suggested.discountRate ?? (cur === "USD" ? 0.09 : 0.12);
  const discountRate = clamp(wantedRate, RANGES.discountRate[cur][0], RANGES.discountRate[cur][1]);
  const wantedTerminal = suggested.terminalGrowth ?? (cur === "USD" ? 0.025 : 0.04);
  const terminal = clamp(wantedTerminal, RANGES.terminalGrowth[cur][0], RANGES.terminalGrowth[cur][1]);
  if (suggested.by) {
    notes.push(`Assumptions suggested by the ${suggested.by === "model" ? "model" : "research plan"}${suggested.rationale ? `: ${suggested.rationale}` : ""}`);
    if (suggested.growth !== undefined && growth !== suggested.growth) notes.push(`suggested growth ${(suggested.growth * 100).toFixed(1)}% clamped to ${(growth * 100).toFixed(1)}%`);
    if (suggested.discountRate !== undefined && discountRate !== suggested.discountRate) notes.push(`suggested discount rate ${(suggested.discountRate * 100).toFixed(1)}% clamped to ${(discountRate * 100).toFixed(1)}%`);
    if (suggested.terminalGrowth !== undefined && terminal !== suggested.terminalGrowth) notes.push(`suggested terminal growth ${(suggested.terminalGrowth * 100).toFixed(1)}% clamped to ${(terminal * 100).toFixed(1)}%`);
  } else {
    notes.push(`Growth from the ${growthSource}; discount and terminal rates are the defaults for ${cur} companies`);
  }

  const scenarios: ValuationScenario[] = [];
  const models: ValuationReportOut["models"] = [];

  if (raw.sectorSet === "financial") {
    // Free cash flow means little for a lender, whose raw material is money. Value the book instead.
    const roe = find("roe")?.median10y ?? find("roe")?.latest ?? null;
    const bvps = raw.bookValuePerShare;
    if (roe === null || bvps === null) unavailable.push({ key: "intrinsic_value", reason: "needs return on equity and book value per share" });
    const plan: [ValuationScenario["name"], number, number, number][] = [
      ["bear", (roe ?? 0) * 0.8, discountRate + 0.01, Math.max(RANGES.terminalGrowth[cur][0], terminal - 0.01)],
      ["base", roe ?? 0, discountRate, terminal],
      ["bull", (roe ?? 0) * 1.1, discountRate - 0.01, Math.min(RANGES.terminalGrowth[cur][1], terminal + 0.01)],
    ];
    for (const [name, r, k, g] of plan) {
      scenarios.push({
        name,
        intrinsicValuePerShare: roe === null || bvps === null ? null : justifiedPb(r, g, k, bvps),
        assumptions: { method: "justified price-to-book", roe: r, cost_of_equity: k, long_run_growth: g, book_value_per_share: bvps },
      });
    }
    models.push({ key: "justified_pb", label: "Justified price-to-book", fairValue: scenarios[1].intrinsicValuePerShare, basis: "(ROE − g) ÷ (r − g) × book value per share, using the 10-year median ROE" });
  } else {
    // Normalise: the median of the last three years' free cash flow, so one lumpy capex year does not set the value.
    const recentFcf = newestFirst.slice(0, 3)
      .map((y) => (y.operatingCashFlow === null ? null : y.operatingCashFlow - Math.abs(y.capitalExpenditure ?? 0)))
      .filter((v): v is number => v !== null);
    const base = recentFcf.length ? median(recentFcf) : null;
    const netDebt = latest ? (latest.totalDebt ?? 0) - (latest.cash ?? 0) : 0;
    if (base === null) unavailable.push({ key: "dcf", reason: "no cash flow statements on record" });
    else if (base <= 0) unavailable.push({ key: "dcf", reason: "free cash flow over the last three years is negative; a DCF on it is not meaningful" });
    if (shares === null) unavailable.push({ key: "dcf", reason: "shares outstanding not on record" });

    const plan: [ValuationScenario["name"], number, number, number][] = [
      ["bear", growth * 0.5, discountRate + 0.01, Math.max(RANGES.terminalGrowth[cur][0], terminal - 0.01)],
      ["base", growth, discountRate, terminal],
      ["bull", Math.min(persona.dcfGrowthCap, growth * 1.3 + 0.01), discountRate - 0.01, Math.min(RANGES.terminalGrowth[cur][1], terminal + 0.01)],
    ];
    for (const [name, g, r, t] of plan) {
      scenarios.push({
        name,
        intrinsicValuePerShare: base !== null && shares !== null ? dcf(base, g, r, t, netDebt, shares) : null,
        assumptions: {
          method: "10-year discounted free cash flow", base_free_cash_flow: base, growth_start: g, discount_rate: r,
          terminal_growth: t, net_debt: netDebt, shares, growth_source: growthSource,
          ...(name === "base" && capped ? { growth_capped_at: persona.dcfGrowthCap } : {}),
        },
      });
    }
    models.push({ key: "dcf", label: "Discounted free cash flow", fairValue: scenarios[1].intrinsicValuePerShare, basis: `median FCF of last 3 years, ${(growth * 100).toFixed(1)}% growth fading to ${(terminal * 100).toFixed(1)}%, discounted at ${(discountRate * 100).toFixed(1)}%` });
  }

  // Relative multiples against the company's own history (year-end prices) and the sector.
  const history = newestFirst.map((y) => {
    const p = raw.yearEndPrices[y.year];
    const pe = p && y.epsDiluted && y.epsDiluted > 0 ? p / y.epsDiluted : null;
    const cap = p && y.sharesDiluted ? p * y.sharesDiluted : null;
    const ev = cap !== null && y.ebitda && y.ebitda > 0 ? (cap + (y.totalDebt ?? 0) - (y.cash ?? 0)) / y.ebitda : null;
    return { pe, ev };
  });
  const own = (xs: (number | null)[], cap: number) => {
    const vals = xs.filter((v): v is number => v !== null && v > 0 && v < cap);
    return vals.length >= 3 ? median(vals) : null;
  };
  const pe = find("pe")?.latest ?? null;
  const peOwnMedian = own(history.map((h) => h.pe), 300);
  const evEbitda = find("evEbitda")?.latest ?? null;
  const evEbitdaReference = raw.sectorSet === "financial" ? null : own(history.map((h) => h.ev), 200);
  if (peOwnMedian === null) unavailable.push({ key: "pe_own_median", reason: "fewer than three fiscal years with a year-end price and positive EPS" });
  if (raw.peerMultiples.pe === null) unavailable.push({ key: "sector_multiples", reason: `${raw.peerMultiples.count} peers on record, fewer than 5` });

  if (pe !== null && peOwnMedian !== null && latest?.epsDiluted) {
    models.push({ key: "own_pe", label: "P/E at its own median", fairValue: peOwnMedian * latest.epsDiluted, basis: `latest EPS × the ${history.filter((h) => h.pe).length}-year median P/E of ${peOwnMedian.toFixed(1)}` });
  }
  if (raw.peerMultiples.pe !== null && latest?.epsDiluted && latest.epsDiluted > 0) {
    models.push({ key: "sector_pe", label: "P/E at the sector median", fairValue: raw.peerMultiples.pe * latest.epsDiluted, basis: `latest EPS × the median P/E of ${raw.peerMultiples.count} ${raw.industry ?? "sector"} peers` });
  }

  const base = scenarios.find((s) => s.name === "base")?.intrinsicValuePerShare ?? null;
  const marginOfSafety = base !== null && base > 0 && price !== null ? (base - price) / base : null;
  if (marginOfSafety === null) unavailable.push({ key: "margin_of_safety", reason: base === null ? "no intrinsic value could be computed" : "no current price" });

  return {
    symbol: raw.symbol,
    currentPrice: price,
    scenarios,
    marginOfSafety,
    requiredMarginOfSafety: persona.requiredMarginOfSafety,
    meetsRequirement: marginOfSafety === null ? null : marginOfSafety >= persona.requiredMarginOfSafety,
    relativeMultiples: {
      pe, peOwnMedian, peSector: raw.peerMultiples.pe,
      pb: find("pb")?.latest ?? null, pbSector: raw.peerMultiples.pb,
      evEbitda, evEbitdaReference,
    },
    models,
    assumptionNotes: notes,
    unavailable,
  };
}
