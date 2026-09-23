// The agent graph (spec §2, Figure 1), built with LangGraph.js.
//
//   START → input_layer ─┬─ blocked / ambiguous ──────────────────────────────────────────────► response_layer → END
//                        ├─ explain_concept ───────────────────────────────────────────────────► response_layer
//                        └─ orchestrator → data_agent → ratio_engine ─┬─ valuation_agent ─┐
//                                              ▲                      ├─ technical_agent ─┼─► validator ─► synthesis ─► response_layer
//                                              │                      └─ news_moat_agent ─┘       │             │
//                                              └───────────── re-fetch once on impossible values ──┘             │
//          loop_back (the persona orchestrator taking synthesis's request, at most twice) ◄── needs more ──────────┘
//            ├─► document_fetch ─► news_moat_agent        (then validator ─► synthesis)
//            └─► news_moat_agent / valuation_agent / technical_agent
//
// State is one LangGraph annotation: every agent reads it and writes its own keys, and parallel workers merge their
// per-company reports through reducers - no agent calls another (spec §6). Things that are not state - the database,
// the trace, the persona, the data providers - travel in the run's `configurable` context. Every node still goes
// through the trace, so a request id shows each agent's input and output.
import { Annotation, END, START, StateGraph, type LangGraphRunnableConfig } from "@langchain/langgraph";
import type { Db } from "../db";
import { ingest as ingestFilings } from "../docs/filings";
import type { ChatOptions, Completion } from "../research/llm";
import { memoReport } from "./cache";
import { agentSetting, persona as loadPersona, settings, type Persona } from "./config";
import { DISCLAIMER } from "./compliance";
import { explainConcept } from "./concepts";
import { readInput, type InputResult, type Match } from "./input";
import { defaultPlan, plan as makePlan } from "./orchestrator";
import { providerFor, type DataProvider } from "./providers";
import { qualitativeReport } from "./qualitative";
import { ratioReport } from "./ratios";
import { validateContract, type Contract } from "./schemas";
import type {
  AnalysisState, FinalAnalysis, Market, QualitativeReport, QuarterFigures, RatioReport, RawData, ResearchPlan, TechnicalReport, ValidationReport, ValuationReportOut,
} from "./state";
import { synthesise, type CompanyReports, type FollowUp } from "./synthesis";
import { technicalReport } from "./technical";
import type { StepDetail } from "./digest";
import { Trace, type Step } from "./trace";
import { validate } from "./validator";
import { suggestAssumptions, valuationReport } from "./valuation";

const timeout = (agent: string, fallback: number) => agentSetting(agent).timeoutMs ?? fallback;

export interface CompanyOut {
  symbol: string; ticker: string; exchange: string; market: Market; currency: "INR" | "USD";
  company: string | null; industry: string | null; sectorSet: string; fiscalYearEnd: string | null;
  quote: RawData["quote"]; marketCap: number | null; years: number[]; quarterly: QuarterFigures[]; ttmPeriodEnd: string | null;
  ratios: RatioReport | null; valuation: ValuationReportOut | null; technical: TechnicalReport | null; qualitative: QualitativeReport | null;
  sources: RawData["sources"]; filingLinks: { label: string; url: string }[];
}

export interface AnalysisResponse {
  requestId: string;
  question: string;
  persona: { id: string; name: string; inspiredBy: string; weights: Persona["weights"]; requiredMarginOfSafety: number; dcfGrowthCap: number };
  intent: AnalysisState["intent"];
  status: "answered" | "blocked" | "ambiguous" | "concept" | "no_data";
  message: string | null;
  options: Match[];
  companies: CompanyOut[];
  plan: ResearchPlan | null;
  validation: ValidationReport | null;
  final: FinalAnalysis | null;
  concept: Awaited<ReturnType<typeof explainConcept>> | null;
  steps: { agent: string; stage: string; durationMs: number | null; detail?: StepDetail | null }[];
  errors: AnalysisState["errors"];
  llmCalls: number;
  loops: number;
  durationMs: number;
  disclaimer: string;
  at: string;
  /** The LangGraph nodes this request passed through, in order. */
  path: string[];
}

export interface AnalyzeOptions {
  message: string;
  personaId?: string | null;
  /** The company in view on the page (or the last one discussed), used when the message names none. */
  symbol?: string | null;
  market?: Market | null;
  onStep?: (step: Step) => void;
  /** Tests pass false to keep traces out of the database. */
  record?: boolean;
  /** Replaces the model: tests use a mock, and a load test with no model measures the code path alone. */
  chat?: (opts: ChatOptions) => Promise<Completion>;
  /** Replaces the data vendors with saved fixtures (spec §10.1: graph integration with mocked vendors). */
  provider?: (market: Market) => DataProvider;
}

// --- state ---------------------------------------------------------------------------------------

const last = <T>(initial: T) => Annotation<T>({ reducer: (_old, next) => next, default: () => initial });
const merge = <T>() => Annotation<Record<string, T>>({ reducer: (old, next) => ({ ...old, ...next }), default: () => ({}) });

export const AgentState = Annotation.Root({
  question: last<string>(""),
  contextSymbol: last<string | null>(null),
  contextMarket: last<Market | null>(null),
  input: last<InputResult | null>(null),
  intent: last<AnalysisState["intent"]>("full_analysis"),
  status: last<AnalysisResponse["status"]>("answered"),
  message: last<string | null>(null),
  options: last<Match[]>([]),
  concept: last<AnalysisResponse["concept"]>(null),
  plan: last<ResearchPlan | null>(null),
  companies: last<Match[]>([]),
  raws: merge<RawData>(),
  ratios: merge<RatioReport | null>(),
  valuations: merge<ValuationReportOut | null>(),
  technicals: merge<TechnicalReport | null>(),
  qualitatives: merge<QualitativeReport | null>(),
  validations: merge<ValidationReport | null>(),
  refetched: last<boolean>(false),
  final: last<FinalAnalysis | null>(null),
  followUp: last<FollowUp | null>(null),
  loops: last<number>(0),
  asked: Annotation<string[]>({ reducer: (old, next) => old.concat(next), default: () => [] }),
  path: Annotation<string[]>({ reducer: (old, next) => old.concat(next), default: () => [] }),
  response: last<AnalysisResponse | null>(null),
});
type S = typeof AgentState.State;
type U = typeof AgentState.Update;

/** What every node can reach that is not state: never serialised, never merged. */
interface Runtime { db: Db; trace: Trace; persona: Persona; providers: (m: Market) => DataProvider; startedAt: number }
const rt = (config: LangGraphRunnableConfig): Runtime => config.configurable?.runtime as Runtime;

/** Run one agent step and check its output against its contract; an invalid report counts as the worker failing. */
async function checked<T>(trace: Trace, agent: string, contract: Contract, input: unknown, fn: () => Promise<T> | T, timeoutMs: number): Promise<T | null> {
  const out = await trace.run(agent, input, fn, { timeoutMs });
  if (out === null) return null;
  const problems = validateContract(contract, out);
  if (!problems.length) return out;
  trace.errors.push({ agent, stage: "contract", message: `${contract} failed validation: ${problems.slice(0, 3).join("; ")}`, retryable: false, at: new Date().toISOString() });
  trace.note(agent, "contract_failed", problems);
  return null;
}

const symbols = (s: S) => s.companies.map((c) => c.symbol).filter((sym) => s.raws[sym]);
const task = (s: S, worker: string) => s.plan?.tasks.find((t) => t.worker === worker);
/** In a loop-back only the requested worker runs, and only for the first company. */
const looping = (s: S, worker: string) => s.followUp !== null && (s.followUp.worker === worker || (worker === "news_moat_agent" && s.followUp.worker === "data_agent"));

// --- nodes ---------------------------------------------------------------------------------------

async function inputLayer(s: S, config: LangGraphRunnableConfig): Promise<U> {
  const { db, trace } = rt(config);
  const input = await trace.run("input_layer", { question: s.question, context: s.contextSymbol, market: s.contextMarket },
    () => readInput(db, s.question, trace, { symbol: s.contextSymbol, market: s.contextMarket }), { timeoutMs: timeout("input_layer", 15_000) + 10_000 });
  if (!input) return { path: ["input_layer"], status: "blocked", message: "The question could not be read. Please try again." };
  const base: U = { path: ["input_layer"], input, intent: input.intent, companies: input.companies };
  if (!input.isAllowed) return { ...base, status: "blocked", message: input.blockedReason ?? "That request is outside what this research covers." };
  if (input.ambiguous) {
    const twoMarkets = new Set(input.ambiguous.options.map((o) => o.market)).size > 1;
    return {
      ...base, status: "ambiguous", options: input.ambiguous.options,
      message: twoMarkets ? `"${input.ambiguous.name}" is listed in both India and the US. Which listing did you mean?` : `Several listed companies match "${input.ambiguous.name}". Which one did you mean?`,
    };
  }
  return { ...base, message: input.note ?? null };
}

const afterInput = (s: S) => (s.status === "blocked" || s.status === "ambiguous" || !s.input ? "response_layer" : s.intent === "explain_concept" ? "explain_concept" : "orchestrator");

async function explainNode(s: S, config: LangGraphRunnableConfig): Promise<U> {
  const { trace, persona } = rt(config);
  const concept = await trace.run("synthesis", { concept: s.input?.concept }, () => explainConcept(trace, s.input!.concept!, persona, s.question));
  return { path: ["explain_concept"], status: "concept", concept, message: concept?.text ?? null };
}

async function orchestratorNode(s: S, config: LangGraphRunnableConfig): Promise<U> {
  const { trace, persona } = rt(config);
  const first = s.companies[0];
  const plan = s.intent === "full_analysis" || s.intent === "single_metric"
    ? (await checked(trace, "orchestrator", "ResearchPlan", { question: s.question, symbol: first.symbol, intent: s.intent, persona: persona.id },
      () => makePlan(trace, { question: s.question, symbol: first.symbol, company: first.company, intent: s.intent, persona, metric: s.input?.metric ?? null }),
      timeout("orchestrator", 20_000) + 25_000)) ?? defaultPlan(first.symbol, s.intent, persona)
    : defaultPlan(first.symbol, s.intent, persona);
  return { path: ["orchestrator"], plan };
}

async function dataAgent(s: S, config: LangGraphRunnableConfig): Promise<U> {
  const { db, trace, providers } = rt(config);
  // First pass: every company, in parallel. After the validator finds impossible values: those companies again, once.
  const refetch = Object.keys(s.validations).length > 0;
  const targets = refetch
    ? s.companies.filter((c) => s.validations[c.symbol]?.failedItems.some((f) => f.worker === "data_agent"))
    : s.companies;
  const loaded = await Promise.all(targets.map(async (c) => [c.symbol, await checked(trace, "data_agent", "RawData",
    { symbol: c.symbol, market: c.market, provider: providers(c.market).name, years: 10, refetch },
    () => providers(c.market).load(db, c.symbol, 10), timeout("data_agent", 20_000))] as const));
  const raws: Record<string, RawData> = {};
  for (const [sym, raw] of loaded) if (raw) raws[sym] = raw;
  const update: U = { path: ["data_agent"], raws, refetched: refetch || s.refetched };
  if (!refetch) {
    const first = s.companies[0];
    const firstRaw = raws[first.symbol];
    if (!Object.keys(raws).length) return { ...update, status: "no_data", message: "The data could not be loaded for this company. Please try again." };
    if (firstRaw && !firstRaw.annual.length && !firstRaw.prices.length) {
      return { ...update, status: "no_data", message: `${first.company} (${first.symbol}) has no financial statements or prices on record, so there is nothing to analyse.` };
    }
  }
  return update;
}

const afterData = (s: S) => (s.status === "no_data" ? "response_layer" : "ratio_engine");

async function ratioEngine(s: S, config: LangGraphRunnableConfig): Promise<U> {
  const { db, trace, persona } = rt(config);
  const ratios: Record<string, RatioReport | null> = {};
  for (const sym of symbols(s)) {
    const raw = s.raws[sym];
    // Pure code, cached by a hash of its inputs, so an unchanged company is not recomputed (spec §5.3).
    ratios[sym] = await checked(trace, "ratio_engine", "RatioReport", { symbol: sym, years: raw.annual.length, focus: task(s, "ratio_engine")?.focus },
      () => memoReport({ a: raw.annual, t: raw.ttm, q: raw.quote?.lastPrice, m: raw.marketCap, b: raw.bookValuePerShare, d: raw.dividendPerShare, s: raw.sectorSet, i: raw.industry, p: raw.peers, pv: raw.peerValues, th: persona.thresholds, c: raw.currency },
        () => ratioReport(db, raw, persona.thresholds)), timeout("ratio_engine", 30_000));
  }
  return { path: ["ratio_engine"], ratios };
}

/** The workers in the plan run together as one parallel step (spec §2 step 4). */
const fanOut = (s: S) => {
  const workers = ["valuation_agent", "technical_agent"].filter((w) => task(s, w));
  // A comparison, a narrow question or a re-fetch does not re-read the news.
  if (task(s, "news_moat_agent") && !s.refetched) workers.push("news_moat_agent");
  return workers.length ? workers : ["validator"];
};

async function valuationNode(s: S, config: LangGraphRunnableConfig): Promise<U> {
  const { trace, persona } = rt(config);
  const valuations: Record<string, ValuationReportOut | null> = {};
  const loop = looping(s, "valuation_agent");
  const targets = loop ? [s.companies[0].symbol] : symbols(s);
  await Promise.all(targets.map(async (sym, i) => {
    const raw = s.raws[sym];
    const ratios = s.ratios[sym];
    if (!raw || !ratios) return;
    valuations[sym] = await checked(trace, "valuation_agent", "ValuationReport", { symbol: sym, currency: raw.currency, growthCap: persona.dcfGrowthCap, loop: loop ? s.loops : undefined, reason: loop ? s.followUp?.reason : undefined }, async () => {
      if (loop) return valuationReport(raw, ratios, persona, s.followUp?.growth !== undefined ? { growth: s.followUp.growth, by: "plan" } : {});
      const fromPlan = task(s, "valuation_agent")?.growthSuggestion;
      // The model suggests assumptions for the company asked about; a comparison's second company uses the defaults.
      const useModel = i === 0 && s.intent !== "comparison" && !s.refetched;
      const suggested = fromPlan !== undefined ? { growth: fromPlan, by: "plan" as const } : useModel ? await suggestAssumptions(trace, raw, ratios, persona) : {};
      return valuationReport(raw, ratios, persona, suggested);
    }, timeout("valuation_agent", 30_000));
  }));
  return { path: ["valuation_agent"], valuations };
}

async function technicalNode(s: S, config: LangGraphRunnableConfig): Promise<U> {
  const { trace } = rt(config);
  const technicals: Record<string, TechnicalReport | null> = {};
  const targets = looping(s, "technical_agent") ? [s.companies[0].symbol] : symbols(s);
  for (const sym of targets) {
    const raw = s.raws[sym];
    if (raw) technicals[sym] = await checked(trace, "technical_agent", "TechnicalReport", { symbol: sym, currency: raw.currency, days: raw.prices.length }, () => technicalReport(raw), timeout("technical_agent", 30_000));
  }
  return { path: ["technical_agent"], technicals };
}

async function newsNode(s: S, config: LangGraphRunnableConfig): Promise<U> {
  const { db, trace, persona } = rt(config);
  const questions = looping(s, "news_moat_agent") ? s.followUp?.questions ?? [] : task(s, "news_moat_agent")?.questions ?? [];
  // Every company in the answer is read, not only the first: in a comparison both sides need a qualitative
  // score, or the persona weighting falls back on one company's moat evidence and none for the other.
  const qualitatives: Record<string, QualitativeReport | null> = {};
  for (const { symbol: sym } of s.companies) {
    const raw = s.raws[sym];
    if (!raw) continue;
    const report = await checked(trace, "news_moat_agent", "QualitativeReport", { symbol: sym, filings: raw.filings.length, questions, loop: s.followUp ? s.loops : undefined },
      () => qualitativeReport(db, raw, persona, trace, questions), timeout("news_moat_agent", 30_000));
    if (report) qualitatives[sym] = report;
  }
  return { path: ["news_moat_agent"], qualitatives };
}

async function documentFetch(s: S, config: LangGraphRunnableConfig): Promise<U> {
  const { db, trace } = rt(config);
  const raw = s.raws[s.companies[0].symbol];
  // Back to step 3: fetch more source material - the company's recent filing documents - for the news agent to read.
  if (raw?.market === "IN") {
    await trace.run("data_agent", { loop: s.loops, fetch: "recent filing documents", reason: s.followUp?.reason },
      () => ingestFilings(db, raw.symbol, 3), { timeoutMs: timeout("data_agent", 20_000) });
  } else {
    trace.note("data_agent", "loop_skipped", { reason: "filing documents are fetched for Indian companies only" });
  }
  return { path: ["document_fetch"] };
}

async function validatorNode(s: S, config: LangGraphRunnableConfig): Promise<U> {
  const { trace } = rt(config);
  const validations: Record<string, ValidationReport | null> = {};
  const qualitatives: Record<string, QualitativeReport | null> = {};
  const raws: Record<string, RawData> = {};
  const targets = s.followUp ? [s.companies[0].symbol] : symbols(s);
  for (const sym of targets) {
    // The validator drops unsourced claims from the report it is given, so it works on a copy and writes it back.
    const qualitative = s.qualitatives[sym] ? { ...s.qualitatives[sym]! } : null;
    const reports: CompanyReports = { raw: s.raws[sym], ratios: s.ratios[sym] ?? null, valuation: s.valuations[sym] ?? null, technical: s.technicals[sym] ?? null, qualitative };
    const v = await checked(trace, "validator", "ValidationReport", { symbol: sym, refetched: s.refetched, loop: s.followUp ? s.loops : undefined },
      () => validate(reports), timeout("validator", 5_000));
    validations[sym] = v;
    if (qualitative) qualitatives[sym] = reports.qualitative;
    // Still impossible after one re-fetch: marked unavailable, and the analysis goes on (spec §8.1).
    if (s.refetched && v && !v.passed) {
      raws[sym] = { ...s.raws[sym], unavailable: [...s.raws[sym].unavailable, ...v.failedItems.map((f) => ({ key: f.check, reason: `${f.detail}; still failing after a re-fetch, so the figures involved are unreliable` }))] };
    }
  }
  return { path: ["validator"], validations, qualitatives, raws };
}

const afterValidator = (s: S) =>
  !s.refetched && !s.followUp && Object.values(s.validations).some((v) => v && !v.passed && v.failedItems.some((f) => f.worker === "data_agent")) ? "data_agent" : "synthesis";

function mergedValidation(s: S): ValidationReport {
  const list = symbols(s).map((sym) => [sym, s.validations[sym] ?? null] as const);
  const many = list.length > 1;
  return {
    passed: list.every(([, v]) => v?.passed !== false),
    warnings: list.flatMap(([sym, v]) => (v?.warnings ?? []).map((w) => ({ ...w, detail: many ? `${sym}: ${w.detail}` : w.detail }))),
    failedItems: list.flatMap(([, v]) => v?.failedItems ?? []),
    lowConfidence: list.flatMap(([, v]) => v?.lowConfidence ?? []),
  };
}

const reportsFor = (s: S): CompanyReports[] => symbols(s).map((sym) => ({
  raw: s.raws[sym], ratios: s.ratios[sym] ?? null, valuation: s.valuations[sym] ?? null, technical: s.technicals[sym] ?? null, qualitative: s.qualitatives[sym] ?? null,
}));

async function synthesisNode(s: S, config: LangGraphRunnableConfig): Promise<U> {
  const { trace, persona, startedAt } = rt(config);
  const limits = settings().request;
  // Keep the request inside its time target (spec §7.3): no loop-back once most of the budget is spent.
  const timeLeft = limits.targetSeconds * 1000 - (Date.now() - startedAt);
  const allowFollowUp = s.loops < limits.maxLoops && s.intent === "full_analysis" && timeLeft > 30_000;
  const asks: { follow: FollowUp | null } = { follow: null };
  const final = await checked(trace, "synthesis", "FinalAnalysis", { persona: persona.id, intent: s.intent, loop: s.loops },
    () => synthesise(trace, { question: s.question, intent: s.intent, persona, companies: reportsFor(s), validation: mergedValidation(s), metric: s.input?.metric ?? null, allowFollowUp }).then((out) => {
      asks.follow = out.followUp;
      return out.final;
    }), timeout("synthesis", 40_000) + 20_000);
  if (!final) return { path: ["synthesis"], followUp: null };

  // Loop guard (spec §8.2): at most two extra rounds, never the same request twice, and only for a report that is
  // actually missing or thin - re-running a worker that already answered repeats the same numbers.
  const follow = allowFollowUp ? asks.follow : null;
  let wanted: FollowUp | null = null;
  if (follow) {
    const key = `${follow.worker}:${(follow.questions ?? []).join("|")}`;
    const sym = s.companies[0].symbol;
    const q = s.qualitatives[sym];
    const thinNews = !q || q.moatSignals.length + q.managementSignals.length + q.risks.length < 3;
    const needed = follow.worker === "news_moat_agent" || follow.worker === "data_agent" ? thinNews
      : follow.worker === "valuation_agent" ? !s.valuations[sym] || s.valuations[sym]!.marginOfSafety === null
        : !s.technicals[sym];
    if (s.asked.includes(key)) trace.note("orchestrator", "loop_declined", { ...follow, why: "already asked once" });
    else if (!needed) trace.note("orchestrator", "loop_declined", { ...follow, why: "that report is already complete" });
    else wanted = follow;
  }
  // The filings reader came back empty and this persona weighs moat and management: ask for it again without
  // waiting for the writer to notice (the review of the TCS/Accenture run: a blank qualitative score and no loop).
  if (!wanted && allowFollowUp && persona.weights.qualitative > 0) {
    const sym = s.companies[0].symbol;
    const q = s.qualitatives[sym];
    const empty = !q || q.moatSignals.length + q.managementSignals.length + q.risks.length === 0;
    // Only once, and never after the filings have already been read again for any reason.
    if (empty && !s.asked.some((k) => k.startsWith("news_moat_agent:"))) {
      wanted = { worker: "news_moat_agent", reason: "no moat, management or risk signals were read from the filings, and this persona weighs them" };
      trace.note("orchestrator", "loop", wanted);
    } else if (empty) {
      trace.note("orchestrator", "loop_declined", { worker: "news_moat_agent", why: "the filings were read again and still carry no signals" });
    }
  }
  return { path: ["synthesis"], final, followUp: wanted };
}

const afterSynthesis = (s: S) => (s.followUp ? "loop_back" : "response_layer");

/** The persona orchestrator taking synthesis's request for more work (Figure 1's dotted arrow). */
async function loopBack(s: S, config: LangGraphRunnableConfig): Promise<U> {
  const { trace } = rt(config);
  const follow = s.followUp!;
  trace.note("orchestrator", "loop", follow);
  return { path: ["loop_back"], loops: s.loops + 1, asked: [`${follow.worker}:${(follow.questions ?? []).join("|")}`] };
}

const LOOP_TARGET: Record<FollowUp["worker"], string> = { data_agent: "document_fetch", news_moat_agent: "news_moat_agent", valuation_agent: "valuation_agent", technical_agent: "technical_agent" };
const loopTarget = (s: S) => LOOP_TARGET[s.followUp!.worker];

function companyOut(r: CompanyReports): CompanyOut {
  const filingLabel = r.raw.market === "US" ? "SEC filing" : "XBRL";
  const seen = new Set<string>();
  return {
    symbol: r.raw.symbol, ticker: r.raw.ticker, exchange: r.raw.exchange, market: r.raw.market, currency: r.raw.currency,
    company: r.raw.company, industry: r.raw.industry, sectorSet: r.raw.sectorSet, fiscalYearEnd: r.raw.fiscalYearEnd,
    quote: r.raw.quote, marketCap: r.raw.marketCap, years: r.raw.annual.map((a) => a.year).sort((a, b) => a - b),
    quarterly: r.raw.quarterly, ttmPeriodEnd: r.raw.ttm?.periodEnd ?? null,
    ratios: r.ratios, valuation: r.valuation, technical: r.technical, qualitative: r.qualitative,
    sources: r.raw.sources,
    filingLinks: r.raw.annual.slice(0, 3).flatMap((a) => [
      a.sources.income ? { label: `FY${a.year} results (${filingLabel})`, url: a.sources.income } : null,
      a.sources.balance ? { label: `FY${a.year} balance sheet (${filingLabel})`, url: a.sources.balance } : null,
      a.sources.cashFlow ? { label: `FY${a.year} cash flow (${filingLabel})`, url: a.sources.cashFlow } : null,
    ].filter((x): x is { label: string; url: string } => Boolean(x) && !seen.has(`${x!.label}|${x!.url}`) && Boolean(seen.add(`${x!.label}|${x!.url}`)))),
  };
}

/** The Response layer (spec §3.10): what the reader sees, with the disclaimer, and every failed worker named. */
async function responseLayer(s: S, config: LangGraphRunnableConfig): Promise<U> {
  const { trace, persona, startedAt } = rt(config);
  const final = s.final ? { ...s.final, missingData: [...s.final.missingData] } : null;
  if (final) {
    for (const e of trace.errors) {
      const line = `${e.agent.replace(/_/g, " ")}: could not complete (${e.message.slice(0, 140)})`;
      if (!final.missingData.includes(line)) final.missingData.push(line);
    }
  }
  const answered = s.status === "answered" && Boolean(final);
  const status: AnalysisResponse["status"] = s.status === "answered" && !final ? "no_data" : s.status;
  const companies = answered ? reportsFor(s) : [];
  // The response layer's own step: what it assembled for the reader.
  trace.note("response_layer", "done", {
    headline: answered
      ? `Answer assembled: summary, ${final!.sections?.length ?? 0} sections, 4 score cards, ${final!.keyNumbers.length} key numbers with sources, ${final!.missingData.length} items listed as missing, disclaimer attached`
      : `${status === "concept" ? "Concept explanation" : status === "ambiguous" ? "Clarifying question" : "Explanation of why no analysis was run"} returned, disclaimer attached`,
    items: [
      { label: "Status", value: status },
      { label: "Path through the graph", value: [...s.path, "response_layer"].join(" → ") },
      { label: "Model calls", value: `${trace.llmCalls} of 12` },
      { label: "Loop-backs", value: `${s.loops} of 2` },
      { label: "Time", value: `${((Date.now() - startedAt) / 1000).toFixed(1)} s` },
    ],
    lists: companies.length ? [{ title: "Sources attached", rows: companies.flatMap((c) => c.raw.sources.map((src) => `${c.raw.ticker} · ${src.dataset.replace(/_/g, " ")}: ${src.source}`)) }] : undefined,
  } satisfies StepDetail);
  const response: AnalysisResponse = {
    requestId: trace.requestId,
    question: s.question,
    persona: { id: persona.id, name: persona.name, inspiredBy: persona.inspiredBy, weights: persona.weights, requiredMarginOfSafety: persona.requiredMarginOfSafety, dcfGrowthCap: persona.dcfGrowthCap },
    intent: s.intent,
    status,
    message: status === "no_data" && !s.message ? "The analysis could not be completed. Please try again." : s.message,
    options: s.options,
    companies: companies.map(companyOut),
    plan: s.plan,
    validation: answered ? mergedValidation(s) : null,
    final: answered ? final : null,
    concept: s.concept,
    steps: trace.steps.map((st) => ({ agent: st.agent, stage: st.stage, durationMs: st.durationMs, detail: st.detail ?? null })),
    errors: trace.errors,
    llmCalls: trace.llmCalls,
    loops: s.loops,
    durationMs: Date.now() - startedAt,
    disclaimer: DISCLAIMER,
    at: new Date().toISOString(),
    path: [...s.path, "response_layer"],
  };
  return { path: ["response_layer"], response };
}

// --- the graph ----------------------------------------------------------------------------------

export const agentGraph = new StateGraph(AgentState)
  .addNode("input_layer", inputLayer)
  .addNode("explain_concept", explainNode)
  .addNode("orchestrator", orchestratorNode)
  .addNode("data_agent", dataAgent)
  .addNode("ratio_engine", ratioEngine)
  .addNode("valuation_agent", valuationNode)
  .addNode("technical_agent", technicalNode)
  .addNode("news_moat_agent", newsNode)
  .addNode("document_fetch", documentFetch)
  .addNode("validator", validatorNode)
  .addNode("synthesis", synthesisNode)
  .addNode("loop_back", loopBack)
  .addNode("response_layer", responseLayer)
  .addEdge(START, "input_layer")
  .addConditionalEdges("input_layer", afterInput, ["response_layer", "explain_concept", "orchestrator"])
  .addEdge("explain_concept", "response_layer")
  .addEdge("orchestrator", "data_agent")
  .addConditionalEdges("data_agent", afterData, ["response_layer", "ratio_engine"])
  .addConditionalEdges("ratio_engine", fanOut, ["valuation_agent", "technical_agent", "news_moat_agent", "validator"])
  .addEdge("valuation_agent", "validator")
  .addEdge("technical_agent", "validator")
  .addEdge("news_moat_agent", "validator")
  .addConditionalEdges("validator", afterValidator, ["data_agent", "synthesis"])
  .addConditionalEdges("synthesis", afterSynthesis, ["loop_back", "response_layer"])
  .addConditionalEdges("loop_back", loopTarget, ["document_fetch", "news_moat_agent", "valuation_agent", "technical_agent"])
  .addEdge("document_fetch", "news_moat_agent")
  .addEdge("response_layer", END)
  .compile({ name: "stock_analysis" });

/** The graph as a Mermaid diagram, for the traces page. */
export async function graphDiagram(): Promise<string> {
  return (await agentGraph.getGraphAsync()).drawMermaid();
}

/** One request through the whole graph. Never throws for a data or model failure; those become AgentErrors. */
export async function analyze(db: Db, opts: AnalyzeOptions): Promise<AnalysisResponse> {
  const startedAt = Date.now();
  const question = opts.message.trim().slice(0, 600);
  const persona = loadPersona(opts.personaId);
  const trace = new Trace(opts.record === false ? null : db, opts.onStep, opts.chat);
  const limits = settings().request;
  // Leave room to write the response inside the platform's 60-second limit (spec §7.3).
  trace.deadline = startedAt + Math.max(20_000, limits.targetSeconds * 1000 - 8_000);
  const runtime: Runtime = { db, trace, persona, providers: opts.provider ?? providerFor, startedAt };
  let result: AnalysisResponse | null = null;
  let state: S | null = null;
  try {
    // Worst case: 13 nodes, a re-fetch pass and two loop-backs - well inside 60 steps.
    state = await agentGraph.invoke({ question, contextSymbol: opts.symbol ?? null, contextMarket: opts.market ?? null }, { configurable: { runtime }, recursionLimit: 60 }) as S;
    result = state.response;
  } catch (e) {
    trace.errors.push({ agent: "graph", stage: "run", message: (e as Error).message, retryable: false, at: new Date().toISOString() });
  } finally {
    if (!result) {
      result = {
        requestId: trace.requestId, question, intent: state?.intent ?? "full_analysis", status: "no_data",
        persona: { id: persona.id, name: persona.name, inspiredBy: persona.inspiredBy, weights: persona.weights, requiredMarginOfSafety: persona.requiredMarginOfSafety, dcfGrowthCap: persona.dcfGrowthCap },
        message: "The analysis could not be completed. Please try again.", options: [], companies: [], plan: null, validation: null, final: null, concept: null,
        steps: trace.steps.map((st) => ({ agent: st.agent, stage: st.stage, durationMs: st.durationMs })), errors: trace.errors,
        llmCalls: trace.llmCalls, loops: 0, durationMs: Date.now() - startedAt, disclaimer: DISCLAIMER, at: new Date().toISOString(), path: state?.path ?? [],
      };
    }
    trace.finish({ personaId: persona.id, symbol: state?.companies[0]?.symbol ?? null, intent: result.intent, question, loops: result.loops, passed: result.validation?.passed ?? null, startedAt, result });
  }
  return result;
}
