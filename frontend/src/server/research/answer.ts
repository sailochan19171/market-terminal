// Answers a question about one company from its filings and figures.
//
// The answer is assembled from measured values first; a language model, when configured, only rephrases that
// same material. Every line carries the period it refers to, and the citations point at the filing itself.
import type { Db } from "../db";
import { decide, type Decision } from "./decision";
import { knowledge, passages, type Passage } from "./retrieve";
import * as llm from "./llm";

export interface Citation { n: number; label: string; period?: string | null; url?: string | null; source: string }
export interface Answer {
  question: string;
  symbol: string;
  company: string | null;
  headline: string;
  points: string[];
  citations: Citation[];
  suggestions: string[];
  writtenBy: "data" | "model";
  asOf: string;
}

type Intent = "invest" | "when_buy" | "when_avoid" | "valuation" | "risks" | "profit" | "debt" | "cash" | "shareholding" | "dividend" | "news" | "changed" | "overview";

const RULES: [Intent, RegExp][] = [
  ["when_buy", /when.*(buy|invest|enter)|buy zone|entry price|at what price/i],
  ["when_avoid", /when.*(not|avoid|sell|exit)|should i avoid|why not/i],
  ["valuation", /valuation|fair value|expensive|cheap|overvalued|undervalued|p\/?e|price to book|worth/i],
  ["risks", /risk|danger|wrong|downside|concern|red flag|loss/i],
  ["profit", /profit|earnings|revenue|sales|margin|result|quarter|growth|pat|eps/i],
  ["debt", /debt|borrow|leverage|interest|solvency|loan/i],
  ["cash", /cash flow|cashflow|free cash|fcf|capex|operating cash/i],
  ["shareholding", /sharehold|promoter|fii|dii|institution|pledge|holding/i],
  ["dividend", /dividend|payout|yield/i],
  ["news", /news|announce|filing|disclosure|update|happening|happened/i],
  ["changed", /what changed|recent|latest|since last|new/i],
  ["invest", /invest|should i|good stock|worth buying|opportunity|recommend/i],
];

const intentOf = (q: string): Intent => RULES.find(([, re]) => re.test(q))?.[0] ?? "overview";

const pct = (v: number | null, d = 1) => (v === null ? "Data unavailable" : `${v > 0 ? "+" : ""}${v.toFixed(d)}%`);
const cr = (v: number | null) => (v === null ? "Data unavailable" : `₹${Math.round(v).toLocaleString("en-IN")} Cr`);
const rs = (v: number | null) => (v === null ? "Data unavailable" : `₹${v.toLocaleString("en-IN")}`);
/** Keeps the model's context small: hosted free tiers meter tokens by the minute. */
const clip = (t: string, n: number) => (t.length > n ? `${t.slice(0, n)}…` : t);

function baseCitations(d: Decision): Citation[] {
  const c: Citation[] = [];
  const add = (label: string, source: string, period?: string | null, url?: string | null) => {
    if (!c.some((x) => x.label === label)) c.push({ n: c.length + 1, label, source, period: period ?? null, url: url ?? null });
  };
  const f = d.facts;
  if (f.price.session) add("Price and market cap", "NSE bhavcopy", f.price.session, null);
  if (f.quarters[0]) add("Quarterly results", `NSE XBRL filing (${f.quarters[0].consolidated ? "consolidated" : "standalone"})`, f.quarters[0].period, f.quarters[0].url);
  if (f.balance.period) add("Balance sheet", "NSE XBRL filing", f.balance.period, f.balance.url);
  if (f.cash.period) add("Cash flow statement", "NSE XBRL filing", f.cash.period, f.cash.url);
  if (f.shareholding.asOf) add("Shareholding pattern", "NSE XBRL filing", f.shareholding.asOf, f.shareholding.url);
  return c;
}

/**
 * A model's reply, made safe to show.
 *
 * Models reach for markdown, for their own bracket characters, and occasionally for a citation that points at
 * nothing - "[RISK]", or a number past the end of the list. Anything that cannot be traced to a real citation is
 * removed rather than shown, which is the whole basis on which a reader is asked to trust the answer.
 */
export function cleanPoints(text: string, valid: Set<number>): string[] {
  return text.split(/\n+/)
    .map((line) => line
      .replace(/^\s*(?:[-*•‣]|\d+[.)])\s*/, "")            // bullet or numbered list marker
      .replace(/[【〔［]\s*(\d+)\s*[】〕］]/g, "[$1]")         // full-width brackets the model sometimes emits
      .replace(/[【〔][^】〕]*[】〕]/g, "")                    // an invented label such as 【RISK】
      .replace(/\*\*([^*]+)\*\*/g, "$1")                   // bold
      .replace(/(^|[\s(])[*_]([^*_\n]+)[*_]($|[\s).,;:])/g, "$1$2$3") // italics
      .replace(/^#+\s*/, "").replace(/`/g, "")
      .replace(/\[(\d+)\]/g, (m, n) => (valid.has(Number(n)) ? m : "")) // a citation pointing at nothing
      .replace(/\s{2,}/g, " ")
      .trim())
    // Drop separators and bare headings ("Main risks:"), keeping only lines that say something.
    .filter((line) => line.length > 12 && !/^[-–—_=*#\s]*$/.test(line) && !/^[A-Za-z ]{3,24}:$/.test(line))
    .slice(0, 6);
}

/** The written-from-data answer, before any model is asked to rephrase it. */
function compose(intent: Intent, d: Decision, found: Passage[]): { headline: string; points: string[] } {
  const f = d.facts;
  const v = d.valuation;
  const zone = v.zones[1];
  const strong = v.zones[0];

  switch (intent) {
    case "when_buy":
      return {
        headline: `${f.company ?? f.symbol}: the models put fair value at ${rs(v.fairValue)}; the price is ${rs(f.price.value)}.`,
        points: [
          strong?.to ? `Deep discount to the estimate: below ${rs(strong.to)}, at least 30% under the fair value the models produce [1].` : "Fair value could not be calculated, so no zone can be drawn.",
          zone?.from ? `Discount to the estimate: ${rs(zone.from)} to ${rs(zone.to)}, a 15-30% margin of safety [1].` : "",
          `Today the margin of safety is ${v.marginOfSafety === null ? "unavailable" : `${v.marginOfSafety.toFixed(1)}%`}, so the price is ${v.status.toLowerCase()} [1][2].`,
          `Conditions met: ${d.conditionsMet}. ${d.conditions.filter((c) => c.met === false).slice(0, 2).map((c) => `Not met: ${c.label.toLowerCase()} — ${c.detail}`).join(" ")}`,
          `On these checks the company ${d.verdict.toLowerCase().replace("screens", "screens as")}, confidence ${d.confidence}. Educational analysis of published figures; this platform issues no buy, sell or target recommendations.`,
        ].filter(Boolean),
      };
    case "when_avoid":
      return {
        headline: `${f.company ?? f.symbol}: what weighs against the current price of ${rs(f.price.value)}.`,
        points: [
          ...d.whyWait.slice(0, 3).map((x) => `${x} [1]`),
          ...d.risk.factors.filter((r) => r.level === "high").slice(0, 2).map((r) => `${r.label}: ${r.detail}`),
          v.zones[3]?.from ? `Above ${rs(v.zones[3].from)} the price sits in the overvalued zone; above ${rs(v.zones[4]?.from ?? null)} the models cannot support it [1].` : "",
          `Overall risk reads ${d.risk.level}.`,
        ].filter(Boolean),
      };
    case "valuation":
      return {
        headline: `${f.company ?? f.symbol} trades at ${rs(f.price.value)} against an estimated fair value of ${rs(v.fairValue)} (${v.status}).`,
        points: [
          `Margin of safety ${v.marginOfSafety === null ? "unavailable" : `${v.marginOfSafety.toFixed(1)}%`}; range across models ${rs(v.range.bear)} to ${rs(v.range.bull)}, confidence ${v.confidence} [1].`,
          ...v.models.filter((m) => m.fairValue !== null).slice(0, 3).map((m) => `${m.label}: ${rs(m.fairValue)} — ${m.basis} [2].`),
          v.history.medianPe ? `P/E ${v.inputs.currentPe ?? "?"} against its own ${v.history.years}-year median of ${v.history.medianPe}${v.history.percentile !== null ? ` (${v.history.percentile}th percentile)` : ""} [1].` : "",
          v.peers.medianPe ? `Peer median P/E ${v.peers.medianPe} across ${v.peers.count} companies in ${v.peers.industry} [1].` : "",
        ].filter(Boolean),
      };
    case "risks":
      return {
        headline: `${f.company ?? f.symbol}: risk reads ${d.risk.level}.`,
        points: [
          ...d.risk.factors.filter((r) => r.level !== "low").slice(0, 4).map((r) => `${r.label}: ${r.detail}`),
          ...d.whatCouldGoWrong.slice(0, 2),
        ],
      };
    case "profit":
      return {
        headline: `${f.company ?? f.symbol}: latest reported quarter ${f.quarters[0]?.period ?? "unavailable"}.`,
        points: [
          f.quarters[0] ? `Revenue ${cr(f.quarters[0].revenue)}, profit ${cr(f.quarters[0].pat)}, EPS ${rs(f.quarters[0].eps)} [2].` : "No quarterly results are parsed for this company yet.",
          `Against the same quarter last year: revenue ${pct(f.growth.revenueYoY.value)}, profit ${pct(f.growth.patYoY.value)} [2].`,
          f.growth.patCagr3y.value !== null ? `Three-year growth: revenue ${pct(f.growth.revenueCagr3y.value)} a year, profit ${pct(f.growth.patCagr3y.value)} a year [2].` : "",
          `Margins: operating ${pct(f.margins.operating.value)}, net ${pct(f.margins.net.value)} [2].`,
          f.quarters.length > 1 ? `Previous quarters: ${f.quarters.slice(1, 4).map((q) => `${q.period} profit ${cr(q.pat)}`).join("; ")} [2].` : "",
        ].filter(Boolean),
      };
    case "debt":
      return {
        headline: f.bank
          ? `${f.company ?? f.symbol} is a lender, so deposits and borrowings are part of the business rather than a debt burden.`
          : `${f.company ?? f.symbol}: borrowings at ${f.balance.period ?? "unknown date"}.`,
        points: [
          `Debt ${cr(f.balance.debtCr.value)}, cash ${cr(f.balance.cashCr.value)}, net ${f.balance.netDebtCr.value !== null && f.balance.netDebtCr.value < 0 ? `cash ${cr(-f.balance.netDebtCr.value)}` : `debt ${cr(f.balance.netDebtCr.value)}`} [3].`,
          f.bank
            ? "Interest cost is the cost of deposits for a lender, so an interest cover ratio does not apply here [3]."
            : `Debt to equity ${f.balance.debtToEquity.value ?? "unavailable"}${f.balance.interestCover.value !== null ? `; operating profit covers interest ${f.balance.interestCover.value.toFixed(1)} times` : ""} [2][3].`,
          d.scores.find((s) => s.key === "balanceSheet")?.detail ?? "",
        ].filter(Boolean),
      };
    case "cash":
      return {
        headline: `${f.company ?? f.symbol}: cash flow for the year to ${f.cash.period ?? "unknown"}.`,
        points: [
          `Operating cash flow ${cr(f.cash.cfoCr.value)}, capital spending ${cr(f.cash.capexCr.value)}, free cash flow ${cr(f.cash.fcfCr.value)} [4].`,
          f.cash.conversion.value !== null ? `Operating cash flow is ${f.cash.conversion.value.toFixed(0)}% of reported profit (${cr(f.cash.patCr.value)}), so earnings are ${f.cash.conversion.value >= 80 ? "well backed by cash" : f.cash.conversion.value >= 60 ? "reasonably backed by cash" : "not fully backed by cash"} [2][4].` : "No annual cash flow statement is parsed yet.",
        ],
      };
    case "shareholding":
      return {
        headline: `${f.company ?? f.symbol}: shareholding as at ${f.shareholding.asOf ?? "unavailable"}.`,
        points: [
          `Promoters ${pct(f.shareholding.promoter.value, 2)}, foreign institutions ${pct(f.shareholding.fii.value, 2)}, domestic institutions ${pct(f.shareholding.dii.value, 2)}, public ${pct(f.shareholding.public.value, 2)} [5].`,
          f.shareholding.promoterChange.value !== null ? `Change last quarter: promoters ${pct(f.shareholding.promoterChange.value, 2)}, foreign institutions ${pct(f.shareholding.fiiChange.value, 2)} [5].` : "",
          "Holdings show who owns the company, not where the price is going.",
        ].filter(Boolean),
      };
    case "dividend":
      return {
        headline: `${f.company ?? f.symbol}: dividends over the last twelve months.`,
        points: [
          `Dividend ${rs(f.dividend.perShare.value)} per share, yield ${pct(f.dividend.yield.value)} at ${rs(f.price.value)} [1].`,
          f.dividend.payout.value !== null ? `That is ${f.dividend.payout.value.toFixed(0)}% of earnings [2].` : "",
          f.actions.length ? `Recent corporate actions: ${f.actions.slice(0, 3).map((a) => `${a.purpose} (ex-date ${a.exDate})`).join("; ")}.` : "",
        ].filter(Boolean),
      };
    case "news":
    case "changed":
      return {
        headline: `${f.company ?? f.symbol}: most recent filings.`,
        points: [
          ...found.slice(0, 5).map((p, i) => `${p.when.slice(0, 10)} · ${p.exchange}: ${p.title}${p.detail ? ` — ${p.detail.slice(0, 120)}` : ""} [${baseCitations(d).length + i + 1}]`),
          f.quarters[0] ? `Latest result on record: ${f.quarters[0].period}, profit ${cr(f.quarters[0].pat)} (${pct(f.growth.patYoY.value)} against the same quarter last year) [2].` : "",
        ].filter(Boolean),
      };
    case "invest":
    default:
      return {
        headline: `${f.company ?? f.symbol}: ${d.verdict.toLowerCase().replace("screens", "screens as")}, score ${d.score ?? "unavailable"}/100, risk ${d.risk.level}, confidence ${d.confidence}.`,
        points: [
          `Price ${rs(f.price.value)} against estimated fair value ${rs(v.fairValue)} (${v.status}, margin of safety ${v.marginOfSafety === null ? "unavailable" : `${v.marginOfSafety.toFixed(1)}%`}) [1].`,
          ...d.whyInvest.slice(0, 2).map((x) => `For: ${x} [2]`),
          ...d.whyWait.slice(0, 2).map((x) => `Against: ${x}`),
          `Conditions met: ${d.conditionsMet}.`,
          `Estimates from published filings and the assumptions shown. Educational only: no recommendation, target price or forecast is given, and no outcome is guaranteed.`,
        ],
      };
  }
}

/** Answer one question about one company. */
// The same question about the same company, before any new data has landed, has the same answer. Holding it for
// an hour keeps a shared model quota for questions nobody has asked yet, and makes a repeated question instant.
const CACHE_TTL_MS = 60 * 60_000;
const CACHE_MAX = 300;
const cache = new Map<string, { at: number; answer: Answer }>();

export async function ask(db: Db, symbol: string, question: string): Promise<Answer> {
  const d = decide(db, symbol);
  const key = `${d.symbol}|${d.facts.price.session ?? ""}|${question.trim().toLowerCase().replace(/\s+/g, " ")}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.answer;
  const bseCode = db.scalar<string>("SELECT bse_code FROM company_metrics WHERE symbol = ?", [d.symbol]);
  const intent = intentOf(question);
  const found = passages(db, d.symbol, bseCode ? String(bseCode) : null, question, 5);
  const known = knowledge(db, d.symbol, question, 4);

  const citations = baseCitations(d);
  const baseCount = citations.length;
  for (const p of known) citations.push({ n: citations.length + 1, label: p.title.slice(0, 90), source: `knowledge base (${p.kind})`, period: p.when.slice(0, 10), url: p.url });
  for (const p of found) citations.push({ n: citations.length + 1, label: `${p.exchange} filing: ${p.title.slice(0, 90)}`, source: `${p.exchange} announcement`, period: p.when.slice(0, 10), url: p.url });

  const written = compose(intent, d, found);
  let points = written.points;
  let writtenBy: "data" | "model" = "data";

  if (llm.available()) {
    // Every line the model may quote carries the citation number the reader will see, so a claim in the answer
    // can be traced to the filing it came from - and anything it cites that is not here is dropped below.
    const cite = (label: string) => {
      const c = citations.find((x) => x.label === label);
      return c ? `[${c.n}] ` : "";
    };
    const context = [
      `COMPANY: ${d.company ?? d.symbol} (${d.symbol}), ${d.facts.industry ?? "industry unknown"}${d.facts.bank ? ", a lender" : ""}`,
      `${cite("Price and market cap")}PRICE: ${rs(d.facts.price.value)} on ${d.facts.price.session}`,
      `COMPUTED HERE, no citation needed - FAIR VALUE: ${rs(d.valuation.fairValue)} (range ${rs(d.valuation.range.bear)}–${rs(d.valuation.range.bull)}, confidence ${d.valuation.confidence}); margin of safety ${d.valuation.marginOfSafety}%; status ${d.valuation.status}`,
      `MODELS: ${d.valuation.models.filter((m) => m.fairValue !== null).map((m) => `${m.label} ${rs(m.fairValue)}`).join(" | ")}`,
      `COMPUTED HERE, no citation needed - VERDICT: ${d.verdict}`,
      `SCORES: ${d.scores.map((x) => `${x.label} ${x.score ?? "n/a"}`).join(" | ")}`,
      `CONDITIONS: ${d.conditionsMet}. ${d.conditions.map((c) => `${c.label}: ${c.met === null ? "untestable" : c.met ? "met" : "not met"}`).join(" | ")}`,
      `COMPUTED HERE, no citation needed - RISK: ${d.risk.level}. ${d.risk.factors.filter((r) => r.level !== "low").map((r) => `${r.label}: ${clip(r.detail, 90)}`).join(" | ")}`,
      `${cite("Quarterly results")}QUARTERS: ${d.facts.quarters.slice(0, 4).map((q) => `${q.period} revenue ${cr(q.revenue)} profit ${cr(q.pat)} EPS ${rs(q.eps)}`).join(" | ")}`,
      `${cite("Balance sheet")}BALANCE SHEET (${d.facts.balance.period}): debt ${cr(d.facts.balance.debtCr.value)}, cash ${cr(d.facts.balance.cashCr.value)}, D/E ${d.facts.balance.debtToEquity.value}`,
      `${cite("Cash flow statement")}CASH FLOW (${d.facts.cash.period}): operating ${cr(d.facts.cash.cfoCr.value)}, capex ${cr(d.facts.cash.capexCr.value)}, free ${cr(d.facts.cash.fcfCr.value)}`,
      `${cite("Shareholding pattern")}SHAREHOLDING (${d.facts.shareholding.asOf}): promoter ${d.facts.shareholding.promoter.value}%, FII ${d.facts.shareholding.fii.value}%, DII ${d.facts.shareholding.dii.value}%`,
      ...known.map((p, i) => `[${baseCount + i + 1}] ${p.kind}, ${p.when.slice(0, 10)}: ${p.title}. ${clip(p.detail ?? "", 320)}`),
      ...found.map((p, i) => `[${baseCount + known.length + i + 1}] ${p.exchange} filing ${p.when.slice(0, 10)}: ${p.title}${p.detail ? `. ${clip(p.detail, 140)}` : ""}`),
    ].join("\n");
    const text = await llm.complete(question, context);
    const cleaned = text ? cleanPoints(text, new Set(citations.map((c) => c.n))) : [];
    if (cleaned.length) {
      points = cleaned;
      writtenBy = "model";
    }
  }

  const answer: Answer = {
    question,
    symbol: d.symbol,
    company: d.company,
    headline: written.headline,
    points,
    citations,
    suggestions: [
      "Is it undervalued right now?",
      "When should I buy, and when should I avoid it?",
      "What are the biggest risks?",
      "How did the last quarter go?",
      "How much debt does it carry?",
      "What changed recently?",
    ],
    writtenBy,
    asOf: new Date().toISOString(),
  };
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
  cache.set(key, { at: Date.now(), answer });
  return answer;
}
