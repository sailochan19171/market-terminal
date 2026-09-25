// The news and moat agent (spec §3.7): moat, management and risk signals, each with the filing it came from.
//
// Two passes. The rule pass reads the exchange filings and the risk-flag checks and classifies what it can by
// keyword - it always runs, so the report exists with no model at all. The model pass, when one is configured,
// reads the same numbered filings plus any annual-report excerpts in the document library and writes one-line
// findings that must cite a numbered source. A finding that cites nothing real is dropped here, and the
// validator drops anything that still lacks a link (spec §8.1).
import type { Db } from "../db";
import { search as searchDocs } from "../docs/store";
import { riskFlags } from "../research/flags";
import { ownershipSignals } from "./ownership";
import type { Persona } from "./config";
import type { QualitativeItem, QualitativeReport, RawData, Unavailable } from "./state";
import { parseJson, type Trace } from "./trace";

interface Source { n: number; label: string; url: string | null; date: string | null; text: string }

// Routine paperwork says nothing about the business; skip it before classifying.
const ROUTINE = /trading window|newspaper (publication|advertisement)|compliance certificate|regulation 74|loss of share certificate|duplicate share|investor (meet|presentation) (schedule|intimation)|analyst.*(meet|call).*(intimation|schedule)|record date|book closure|shareholders meeting.*(notice|voting)|scrutini[sz]er|closure of trading/i;

const MOAT = [
  { re: /\b(order|contract)s?\b.*\b(win|won|receiv|secur|bag|award)/i, sentiment: "positive" as const, summary: "Won a new order or contract" },
  { re: /\b(capacity expansion|commission(ed|ing)|new (plant|facility|factory)|capex)\b/i, sentiment: "positive" as const, summary: "Expanding or commissioning capacity" },
  { re: /\b(launch|new product|approval|usfda|patent|licen[cs]e granted)\b/i, sentiment: "positive" as const, summary: "Product launch, approval or patent" },
  { re: /\b(acqui|amalgamation|merger|joint venture|strategic partnership|collaborat)/i, sentiment: "neutral" as const, summary: "Acquisition, merger or partnership" },
  { re: /\bentry into a material agreement\b/i, sentiment: "neutral" as const, summary: "Material agreement signed" },
  { re: /\bcredit rating\b.*\b(upgrade|reaffirm)/i, sentiment: "positive" as const, summary: "Credit rating upgraded or reaffirmed" },
];
const MANAGEMENT = [
  { re: /\bbuy ?back\b/i, sentiment: "positive" as const, summary: "Share buyback" },
  { re: /\b(dividend)\b/i, sentiment: "positive" as const, summary: "Dividend declared or recommended" },
  { re: /\bdeparture or appointment of directors|\b(resign|cessation)\b.*\b(director|ceo|cfo|managing|chief|company secretary|kmp)|\b(director|ceo|cfo|managing director|chief financial officer)\b.*\b(resign|cessation)/i, sentiment: "negative" as const, summary: "Senior management or director departure" },
  { re: /\b(appoint|re-appoint)\w*\b.*\b(director|ceo|cfo|managing|chief)/i, sentiment: "neutral" as const, summary: "Board or management appointment" },
  { re: /\b(preferential|qip|rights issue|fund rais|allotment of (equity|warrants))/i, sentiment: "neutral" as const, summary: "Raising capital (dilution to check)" },
];
const RISK = [
  { re: /\b(penalt|show cause|adjudicat|sebi order|search and seizure|raid|fraud)/i, sentiment: "negative" as const, summary: "Regulatory action or penalty" },
  { re: /\bnon-reliance on previously issued|\bchange in the company's certifying accountant/i, sentiment: "negative" as const, summary: "Restatement warning or auditor change" },
  { re: /\bmaterial impairments?\b|\bexit or disposal costs\b|\bnotice of delisting\b|\bbankruptcy or receivership\b/i, sentiment: "negative" as const, summary: "Impairment, restructuring or listing notice" },
  { re: /\b(litigation|lawsuit|arbitration|nclt|insolvenc|winding up)\b/i, sentiment: "negative" as const, summary: "Litigation or insolvency proceedings" },
  { re: /\bcredit rating\b.*\b(downgrade|watch negative|withdraw)/i, sentiment: "negative" as const, summary: "Credit rating downgraded or on watch" },
  { re: /\b(default|delay in (payment|servicing))\b/i, sentiment: "negative" as const, summary: "Default or payment delay" },
  { re: /\b(pledg|encumbran)/i, sentiment: "negative" as const, summary: "Promoter shares pledged or encumbered" },
  { re: /\b(fire|accident|shutdown|strike|lockout|cyber ?attack|ransomware)\b/i, sentiment: "negative" as const, summary: "Operational disruption" },
];

function classify(raw: RawData): Omit<QualitativeReport, "symbol" | "unavailable"> {
  const moat: QualitativeItem[] = [], management: QualitativeItem[] = [], risks: QualitativeItem[] = [];
  const seen = new Set<string>();
  for (const f of raw.filings) {
    const text = `${f.title} ${f.detail ?? ""}`;
    if (!f.url || ROUTINE.test(text)) continue;
    for (const [bucket, rules] of [[risks, RISK], [management, MANAGEMENT], [moat, MOAT]] as const) {
      const hit = rules.find((r) => r.re.test(text));
      if (!hit) continue;
      // One item per kind of event: five dividend notices are one signal, not five.
      const key = hit.summary;
      if (!seen.has(key) && bucket.length < 6) {
        seen.add(key);
        bucket.push({ summary: `${hit.summary}: ${f.title.slice(0, 140)}`, sentiment: hit.sentiment, sourceUrl: f.url, sourceLabel: f.source, date: f.when.slice(0, 10) });
      }
      break;
    }
  }
  return { moatSignals: moat, managementSignals: management, risks };
}

const SYSTEM = [
  "You read an Indian listed company's recent exchange filings and annual-report excerpts and extract evidence.",
  "Return JSON only: {\"moat_signals\": [...], \"management_signals\": [...], \"risks\": [...]}.",
  "Each item is {\"summary\": one plain sentence under 30 words, \"sentiment\": \"positive\"|\"negative\"|\"neutral\", \"source\": the number of the source it came from}.",
  "Use only what the numbered sources say. Every item must cite exactly one source number from the list. Never invent a source, a figure or an event.",
  "Moat signals: evidence of competitive advantage or its erosion (pricing power, market position, orders, capacity, approvals, brand).",
  "Management signals: capital allocation, governance, dilution, related-party dealings, leadership changes, candour.",
  "Risks: anything that could impair the business permanently: regulation, litigation, leverage, pledging, disruption, concentration.",
  "At most five items per list. Skip routine compliance paperwork. Empty lists are fine. No buy, sell or price-target language.",
].join(" ");

export async function qualitativeReport(db: Db, raw: RawData, persona: Persona, trace: Trace, questions: string[] = []): Promise<QualitativeReport> {
  const unavailable: Unavailable[] = [];
  const rules = classify(raw);

  // Risk-flag checks (pledging, auditor changes, insider selling, regulatory action) are already sourced.
  // The pledging, auditor and insider checks read Indian disclosures; a US ticker could collide with an NSE symbol.
  const flags = raw.market === "IN" ? riskFlags(db, raw.symbol) : null;
  for (const f of flags?.flags ?? []) {
    if (f.status !== "raised" || !f.source?.url) continue;
    rules.risks.unshift({ summary: `${f.label}: ${f.detail}`, sentiment: "negative", sourceUrl: f.source.url, sourceLabel: f.source.label, date: f.source.when?.slice(0, 10) ?? null });
  }

  // Who owns the company, from the shareholding patterns and insider disclosures the data agent read. These
  // are filed figures, so they go in whether or not a model answers.
  if (raw.ownership) {
    const own = ownershipSignals(raw.ownership);
    rules.managementSignals.push(...own.management);
    rules.risks.push(...own.risks);
  }

  const sources: Source[] = raw.filings
    .filter((f) => f.url && !ROUTINE.test(`${f.title} ${f.detail ?? ""}`))
    // The same subject filed on both exchanges is one source, and 25 is plenty for 90 days (and keeps the prompt
    // inside a free tier's per-minute token budget).
    .filter((f, i, all) => all.findIndex((g) => g.title.toLowerCase() === f.title.toLowerCase() && g.when.slice(0, 10) === f.when.slice(0, 10)) === i)
    .slice(0, 25)
    .map((f, i) => ({ n: i + 1, label: `${f.source}: ${f.title}`, url: f.url, date: f.when.slice(0, 10), text: `${f.title}${f.detail && f.detail !== f.title ? ` - ${f.detail.slice(0, 120)}` : ""}` }));

  // Annual report and presentation excerpts from the document library, when any have been added.
  try {
    if (raw.market !== "IN") throw new Error("the document library holds Indian filings");
    const asks = [...questions, ...persona.researchQuestions].slice(0, 3);
    for (const q of asks.length ? asks : ["competitive advantage market share", "risks"]) {
      for (const p of await searchDocs(db, raw.symbol, q, 2)) {
        if (!p.url || sources.some((s) => s.url === p.url && s.text === p.snippet)) continue;
        sources.push({ n: sources.length + 1, label: `${p.title}${p.page ? `, page ${p.page}` : ""}`, url: p.url, date: null, text: p.snippet });
      }
    }
  } catch (e) {
    unavailable.push({ key: "annual_report_excerpts", reason: raw.market === "IN" ? "the document library could not be searched" : `annual report text is not read for US companies yet (${(e as Error).message})` });
  }

  if (!sources.length) {
    unavailable.push({ key: "qualitative_sources", reason: "no filings in the last 90 days and no documents in the library" });
    return { symbol: raw.symbol, ...rules, unavailable };
  }

  const user = [
    `COMPANY: ${raw.company ?? raw.symbol} (${raw.symbol}), ${raw.industry ?? "industry not on record"}`,
    questions.length || persona.researchQuestions.length ? `QUESTIONS TO KEEP IN MIND: ${[...questions, ...persona.researchQuestions].join(" | ")}` : "",
    "SOURCES",
    ...sources.map((s) => `[${s.n}] ${s.date ?? ""} ${s.text}`),
  ].filter(Boolean).join("\n");

  const reply = await trace.llm("news_moat_agent", { system: SYSTEM, user, json: true, temperature: 0, maxTokens: 1200 });
  type Item = { summary?: unknown; sentiment?: unknown; source?: unknown };
  const parsed = parseJson<{ moat_signals?: Item[]; management_signals?: Item[]; risks?: Item[] }>(reply.text);
  if (!parsed) {
    if (reply.error && reply.error !== "no key configured") unavailable.push({ key: "model_reading", reason: `the model did not return findings (${reply.error}); keyword classification used` });
    return { symbol: raw.symbol, ...rules, unavailable };
  }

  const toItems = (items: Item[] | undefined): QualitativeItem[] =>
    (Array.isArray(items) ? items : []).slice(0, 5).flatMap((it) => {
      const source = sources.find((s) => s.n === Number(it.source));
      const summary = String(it.summary ?? "").trim();
      if (!source || !summary) return []; // a claim with no real source is not kept (spec §3.7)
      const sentiment = it.sentiment === "positive" || it.sentiment === "negative" ? it.sentiment : "neutral";
      return [{ summary: summary.slice(0, 240), sentiment, sourceUrl: source.url, sourceLabel: source.label.slice(0, 120), date: source.date }];
    });

  const merge = (model: QualitativeItem[], fromRules: QualitativeItem[]) => {
    const out = [...model];
    for (const r of fromRules) if (!out.some((m) => m.sourceUrl === r.sourceUrl)) out.push(r);
    return out.slice(0, 8);
  };
  return {
    symbol: raw.symbol,
    moatSignals: merge(toItems(parsed.moat_signals), rules.moatSignals),
    managementSignals: merge(toItems(parsed.management_signals), rules.managementSignals),
    risks: merge(toItems(parsed.risks), rules.risks),
    unavailable,
  };
}
