// A readable account of what each agent received and produced, streamed to the workspace as the graph runs.
//
// The trace keeps every input and output in full for review; this is the part a reader follows live - the plan, the
// data fetched, every ratio, the valuation and its assumptions, the signals and their sources, the checks - in plain
// labels and formatted numbers, so each of the eleven phases can be opened and read on its own.
import type { InputResult } from "./input";
import type {
  FinalAnalysis, QualitativeReport, RatioReport, RawData, ResearchPlan, TechnicalReport, ValidationReport, ValuationReportOut,
} from "./state";

export interface StepDetail {
  headline: string;
  items?: { label: string; value: string }[];
  lists?: { title: string; rows: string[] }[];
  tables?: { title: string; columns: string[]; rows: string[][] }[];
}

type Cur = "INR" | "USD";
const pct = (v: number | null | undefined, d = 1) => (v == null ? "—" : `${(v * 100).toFixed(d)}%`);
const x = (v: number | null | undefined, d = 2) => (v == null ? "—" : `${v.toFixed(d)}x`);
const money = (cur: Cur, v: number | null | undefined) => (v == null ? "—" : cur === "USD" ? `$${v.toLocaleString("en-US", { maximumFractionDigits: 2 })}` : `₹${v.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`);
const big = (cur: Cur, v: number | null | undefined) => {
  if (v == null) return "—";
  if (cur === "INR") return `₹${Math.round(v / 1e7).toLocaleString("en-IN")} Cr`;
  return Math.abs(v) >= 1e9 ? `$${(v / 1e9).toFixed(1)}B` : `$${Math.round(v / 1e6).toLocaleString("en-US")}M`;
};
const fmtRatio = (unit: string, v: number | null | undefined, cur: Cur) =>
  v == null ? "—" : unit === "percent" ? pct(v) : unit === "currency" ? big(cur, v) : unit === "days" ? `${Math.round(v)} days` : x(v);
const words = (s: string) => s.replace(/_/g, " ");
const is = <T>(v: unknown, key: string): v is T => Boolean(v) && typeof v === "object" && key in (v as object);

const CATEGORY: Record<string, string> = {
  profitability: "Profitability", liquidity: "Liquidity", solvency: "Solvency", efficiency: "Efficiency", valuation: "Valuation",
  cashFlow: "Cash flow quality", growth: "Growth", dividends: "Dividends and shareholder returns", financial: "Financial sector",
};

function inputLayer(o: InputResult): StepDetail {
  const companies = o.companies.map((c) => `${c.company} (${c.symbol}, ${c.market === "US" ? "US" : "India"})`);
  return {
    headline: !o.isAllowed ? `Refused: ${o.blockedReason ?? "outside research"}`
      : o.ambiguous ? `Needs a choice: "${o.ambiguous.name}" matches ${o.ambiguous.options.length} listings`
        : `${words(o.intent)}${companies.length ? ` · ${companies.join(" vs ")}` : ""}`,
    items: [
      { label: "Intent", value: words(o.intent) },
      { label: "Guardrails", value: o.isAllowed ? "passed - no price prediction, target or off-topic request" : `refused - ${o.blockedReason}` },
      ...(companies.length ? [{ label: companies.length > 1 ? "Companies" : "Company", value: companies.join("; ") }] : []),
      ...(o.metric ? [{ label: "Measure asked about", value: o.metric }] : []),
      ...(o.note ? [{ label: "Note", value: o.note }] : []),
    ],
    lists: o.ambiguous ? [{ title: "Listings that match", rows: o.ambiguous.options.map((m) => `${m.company} - ${m.symbol} (${m.market === "US" ? "US-listed" : "NSE/BSE"})`) }] : undefined,
  };
}

function plan(o: ResearchPlan): StepDetail {
  return {
    headline: `${o.plannedBy === "model" ? "Plan written by the persona model" : "Default plan"} · ${o.tasks.length} workers`,
    items: [{ label: "Reasoning", value: o.reasoning || "—" }],
    tables: [{
      title: "Research plan",
      columns: ["Worker", "Focus / questions", "Priority"],
      rows: o.tasks.map((t) => [words(t.worker), [...(t.focus ?? []), ...(t.methods ?? []), ...(t.questions ?? [])].join(", ") || "all", t.priority ?? "normal"]),
    }],
  };
}

function rawData(o: RawData): StepDetail {
  const cur = o.currency;
  const newest = [...o.annual].sort((a, b) => b.year - a.year);
  return {
    headline: `${o.company ?? o.symbol} (${o.ticker}, ${o.exchange}) · ${o.annual.length} fiscal years · ${o.quarterly.length} quarters · ${o.prices.length.toLocaleString("en-US")} daily prices · ${o.filings.length} filings`,
    items: [
      { label: "Industry", value: o.industry ?? "not on record" },
      { label: "Ratio set", value: o.sectorSet === "financial" ? "financial sector (banks, NBFCs, insurers)" : "standard" },
      { label: "Price", value: `${money(cur, o.quote?.lastPrice)}${o.quote?.asOfTimestamp ? ` as of ${o.quote.asOfTimestamp.slice(0, 10)}` : ""}` },
      { label: "Market cap", value: big(cur, o.marketCap) },
      { label: "Fiscal year ends", value: o.fiscalYearEnd ?? "—" },
      { label: "Trailing twelve months", value: o.ttm ? `to ${o.ttm.periodEnd}` : "not available" },
      { label: "Peers in the same market", value: String(o.peerMultiples.count || o.peers.length) },
    ],
    tables: newest.length ? [{
      title: "Annual figures (restated)",
      columns: ["Year", "Revenue", "Net income", "Diluted EPS", "Equity", "Total debt", "Operating cash flow"],
      rows: newest.map((a) => [`FY${a.year}`, big(cur, a.revenue), big(cur, a.netIncome), money(cur, a.epsDiluted), big(cur, a.shareholdersEquity), big(cur, a.totalDebt), big(cur, a.operatingCashFlow)]),
    }] : undefined,
    lists: [
      { title: "Sources", rows: o.sources.map((s) => `${words(s.dataset)}: ${s.source} (fetched ${s.fetchedAt.slice(0, 10)})`) },
      ...(o.filings.length ? [{ title: "Recent filings read", rows: o.filings.slice(0, 12).map((f) => `${f.when.slice(0, 10)} · ${f.title.slice(0, 120)}`) }] : []),
      ...(o.unavailable.length ? [{ title: "Not available", rows: o.unavailable.map((u) => `${words(u.key)}: ${u.reason}`) }] : []),
    ],
  };
}

function ratios(o: RatioReport): StepDetail {
  const all = Object.entries(o.categories).flatMap(([cat, r]) => Object.values(r).map((s) => [cat, s] as const));
  const computed = all.filter(([, s]) => s.latest !== null).length;
  const q = o.qualityScores;
  return {
    headline: `${computed} of ${all.length} ratios computed across ${Object.keys(o.categories).length} categories · FY${o.years[0] ?? "?"}–FY${o.years.at(-1) ?? "?"}`,
    items: [
      { label: "Fundamental score", value: `${o.categoryScores.fundamental ?? "—"} / 100` },
      { label: "Growth score", value: `${o.categoryScores.growth ?? "—"} / 100` },
      { label: "Valuation score", value: `${o.categoryScores.valuation ?? "—"} / 100` },
      { label: "Financial health score", value: `${o.categoryScores.financialHealth ?? "—"} / 100` },
      { label: "Piotroski F-score", value: q.piotroski.score == null ? "not available" : `${q.piotroski.score} / 9` },
      { label: "Altman Z''", value: q.altmanZ.score == null ? `not available${q.altmanZ.reason ? ` (${q.altmanZ.reason})` : ""}` : `${q.altmanZ.score.toFixed(2)} - ${q.altmanZ.zone}` },
      { label: "Beneish M-score", value: q.beneishM.score == null ? "not available" : `${q.beneishM.score.toFixed(2)}${q.beneishM.flag ? " - flagged" : " - no flag"}` },
      { label: "Sector peers", value: `${o.peers.count}${o.peers.industry ? ` in ${o.peers.industry}` : ""}` },
    ],
    tables: Object.entries(o.categories).map(([cat, r]) => ({
      title: CATEGORY[cat] ?? cat,
      columns: ["Ratio", "Latest", "TTM", "Own median", "Trend", "Sector median"],
      rows: Object.values(r).map((s) => [
        s.label,
        s.latest == null ? (s.series.at(-1)?.reason ?? "—").replace(/_/g, " ") : fmtRatio(s.unit, s.latest, o.currency),
        s.ttm ? fmtRatio(s.unit, s.ttm.value, o.currency) : "—",
        s.series.length > 1 ? fmtRatio(s.unit, s.median10y, o.currency) : "—",
        s.trend ?? "—",
        s.sectorMedian == null ? "—" : `${fmtRatio(s.unit, s.sectorMedian, o.currency)} (p${Math.round(s.percentileInSector ?? 0)})`,
      ]),
    })),
  };
}

function valuation(o: ValuationReportOut, cur: Cur): StepDetail {
  const base = o.scenarios.find((s) => s.name === "base");
  return {
    headline: `Base case ${money(cur, base?.intrinsicValuePerShare)} against price ${money(cur, o.currentPrice)} · margin of safety ${pct(o.marginOfSafety)} (${o.meetsRequirement == null ? "not measurable" : o.meetsRequirement ? "meets" : "below"} the ${pct(o.requiredMarginOfSafety, 0)} required)`,
    items: [
      { label: "P/E now / own median / sector", value: `${x(o.relativeMultiples.pe, 1)} / ${x(o.relativeMultiples.peOwnMedian, 1)} / ${x(o.relativeMultiples.peSector, 1)}` },
      { label: "P/B now / sector", value: `${x(o.relativeMultiples.pb, 1)} / ${x(o.relativeMultiples.pbSector, 1)}` },
      { label: "EV/EBITDA now / own median", value: `${x(o.relativeMultiples.evEbitda, 1)} / ${x(o.relativeMultiples.evEbitdaReference, 1)}` },
    ],
    tables: [{
      title: "Scenarios",
      columns: ["Scenario", "Value per share", "Assumptions"],
      rows: o.scenarios.map((s) => [s.name, money(cur, s.intrinsicValuePerShare), Object.entries(s.assumptions).map(([k, v]) => `${words(k)}: ${typeof v === "number" ? (Math.abs(v) < 1 && !/shares|value|debt|flow/.test(k) ? pct(v) : Math.abs(v) > 1e6 ? big(cur, v) : v.toLocaleString("en-US", { maximumFractionDigits: 2 })) : v}`).join("; ")]),
    }],
    lists: [
      ...(o.assumptionNotes.length ? [{ title: "Where the assumptions came from", rows: o.assumptionNotes }] : []),
      ...(o.models.length ? [{ title: "Models", rows: o.models.map((m) => `${m.label}: ${money(cur, m.fairValue)} - ${m.basis}`) }] : []),
      ...(o.unavailable.length ? [{ title: "Not available", rows: o.unavailable.map((u) => `${words(u.key)}: ${u.reason}`) }] : []),
    ],
  };
}

function technical(o: TechnicalReport, cur: Cur): StepDetail {
  return {
    headline: `${o.trendLabel ?? "no trend label"} · price ${pct(o.priceVsMa200)} vs its 200-day average · 1-year return ${pct(o.returns["1y"])}`,
    items: [
      { label: "50-day average", value: `${money(cur, o.ma50)} (price ${pct(o.priceVsMa50)})` },
      { label: "200-day average", value: `${money(cur, o.ma200)} (price ${pct(o.priceVsMa200)})` },
      { label: "52-week range", value: `${money(cur, o.low52w)} – ${money(cur, o.high52w)}` },
      { label: "Returns 1y / 3y / 5y", value: `${pct(o.returns["1y"])} / ${pct(o.returns["3y"])} / ${pct(o.returns["5y"])}` },
      { label: "Volatility (annualised)", value: pct(o.volatility) },
      { label: "RSI (14)", value: o.rsi14 == null ? "—" : o.rsi14.toFixed(0) },
      { label: "Prices to", value: o.asOf ?? "—" },
    ],
    lists: o.unavailable.length ? [{ title: "Not available", rows: o.unavailable.map((u) => `${words(u.key)}: ${u.reason}`) }] : undefined,
  };
}

function qualitative(o: QualitativeReport): StepDetail {
  const row = (i: QualitativeReport["risks"][number]) => `[${i.sentiment}] ${i.summary}${i.sourceLabel ? ` — ${i.sourceLabel}${i.date ? `, ${i.date}` : ""}` : ""}`;
  return {
    headline: `${o.moatSignals.length} moat signals · ${o.managementSignals.length} management signals · ${o.risks.length} risks, each with a source`,
    lists: [
      { title: "Moat signals", rows: o.moatSignals.map(row) },
      { title: "Management signals", rows: o.managementSignals.map(row) },
      { title: "Risks", rows: o.risks.map(row) },
      ...(o.unavailable.length ? [{ title: "Not read", rows: o.unavailable.map((u) => `${words(u.key)}: ${u.reason}`) }] : []),
    ],
  };
}

function validation(o: ValidationReport): StepDetail {
  return {
    headline: `${o.passed ? "No impossible values" : "Impossible values found"} · ${o.warnings.length} warning${o.warnings.length === 1 ? "" : "s"}`,
    items: [
      { label: "Checks run", value: "accounting identity, impossible values, outliers, year gaps, cross-check, stale data, unsourced claims" },
      ...(o.lowConfidence.length ? [{ label: "Low confidence", value: o.lowConfidence.join(", ") }] : []),
    ],
    lists: [
      ...(o.failedItems.length ? [{ title: "Failures (sent back to their worker)", rows: o.failedItems.map((f) => `${words(f.check)}: ${f.detail}`) }] : []),
      ...(o.warnings.length ? [{ title: "Warnings", rows: o.warnings.map((w) => `${words(w.check)}: ${w.detail}`) }] : []),
    ],
  };
}

function final(o: FinalAnalysis): StepDetail {
  return {
    headline: `${o.writtenBy === "model" ? `Written by ${o.model ?? "the model"}` : "Written from the data"} · persona fit ${o.personaFit ?? "—"} / 100 · ${o.sections?.length ?? 0} sections`,
    items: [
      { label: "Fundamental", value: `${o.categoryScores.fundamental ?? "—"} / 100` },
      { label: "Valuation", value: `${o.categoryScores.valuation ?? "—"} / 100` },
      { label: "Technical", value: `${o.categoryScores.technical ?? "—"} / 100` },
      { label: "Qualitative", value: `${o.categoryScores.qualitative ?? "—"} / 100` },
      { label: "Checks removed", value: o.removed.length ? `${o.removed.length} sentence${o.removed.length === 1 ? "" : "s"}` : "nothing" },
    ],
    lists: [
      { title: "Strengths", rows: o.strengths },
      { title: "Concerns", rows: o.concerns },
      ...(o.removed.length ? [{ title: "Removed by the checks", rows: o.removed }] : []),
    ],
  };
}

/** The readable detail for one step, or null when the stage has nothing worth showing. */
export function digest(agent: string, stage: string, input: unknown, output: unknown): StepDetail | null {
  try {
    const cur: Cur = is<{ currency: Cur }>(input, "currency") && input.currency === "USD" ? "USD" : "INR";
    if (stage === "error") return { headline: `Failed: ${is<{ message: string }>(output, "message") ? output.message : "unknown error"}` };
    if (agent === "debate_agent" && is<{ bull: string[]; bear: string[]; writtenBy: string }>(output, "bull")) {
      return {
        headline: `${output.bull.length} points for, ${output.bear.length} against (${output.writtenBy === "model" ? "argued by the model" : "from the rules"})`,
        lists: [{ title: "The case for", rows: output.bull }, { title: "The case against", rows: output.bear }],
      };
    }
    if (stage === "regenerating" && is<{ problems: string[] }>(output, "problems")) {
      return { headline: `Written again: ${output.problems.length} problem${output.problems.length === 1 ? "" : "s"} in the first draft`, lists: [{ title: "What the checks found", rows: output.problems }] };
    }
    if (stage === "contract_failed") return { headline: "Output failed its contract and was left out", lists: [{ title: "Problems", rows: (output as string[]).slice(0, 10) }] };
    if (stage === "llm") {
      const o = output as { model?: string; error?: string; promptTokens?: number | null; completionTokens?: number | null; fellBackTo?: string };
      return {
        headline: o.error ? `Model call did not answer: ${o.error}${o.fellBackTo ? ` - retrying on ${o.fellBackTo}` : ""}` : `Model ${o.model ?? ""} answered`,
        items: [{ label: "Tokens in / out", value: `${o.promptTokens ?? "—"} / ${o.completionTokens ?? "—"}` }],
      };
    }
    if (stage === "loop" || stage === "loop_declined") {
      const o = output as { worker?: string; reason?: string; why?: string; questions?: string[] };
      return { headline: `${stage === "loop" ? "Looping back" : "Loop-back declined"}: ${words(o.worker ?? "")}${o.reason ? ` - ${o.reason}` : ""}${o.why ? ` (${o.why})` : ""}`, lists: o.questions?.length ? [{ title: "Questions", rows: o.questions }] : undefined };
    }
    if (stage !== "done" || output == null) return null;
    if (agent === "input_layer" && is<InputResult>(output, "intent")) return inputLayer(output);
    if (agent === "orchestrator" && is<ResearchPlan>(output, "tasks")) return plan(output);
    if (agent === "data_agent" && is<RawData>(output, "annual")) return rawData(output);
    if (agent === "ratio_engine" && is<RatioReport>(output, "categories")) return ratios(output);
    if (agent === "valuation_agent" && is<ValuationReportOut>(output, "scenarios")) return valuation(output, cur);
    if (agent === "technical_agent" && is<TechnicalReport>(output, "trendLabel")) return technical(output, cur);
    if (agent === "news_moat_agent" && is<QualitativeReport>(output, "moatSignals")) return qualitative(output);
    if (agent === "validator" && is<ValidationReport>(output, "warnings")) return validation(output);
    if (agent === "synthesis" && is<FinalAnalysis>(output, "summary")) return final(output);
    if (agent === "synthesis" && is<{ text: string }>(output, "text")) return { headline: "Concept explained", items: [{ label: "Explanation", value: output.text }] };
    if (agent === "response_layer" && is<{ headline: string }>(output, "headline")) return output as StepDetail;
    return null;
  } catch {
    return null;
  }
}
