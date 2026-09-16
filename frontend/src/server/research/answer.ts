// Answers a question about one company from its filings and figures.
//
// The answer is assembled from measured values first; a language model, when configured, only rephrases that
// same material. Every line carries the period it refers to, and the citations point at the filing itself.
import type { Db } from "../db";
import { decide, type Decision } from "./decision";
import { knowledge, passages, type Passage } from "./retrieve";
import { search as searchDocuments } from "../docs/store";
import * as llm from "./llm";

export interface Citation { n: number; label: string; period?: string | null; url?: string | null; source: string }
/** One exchange already in this conversation, so a follow-up question knows what it refers to. */
export interface Turn { q: string; a: string }
export interface AskOptions { debug?: boolean; history?: Turn[] }
export interface Answer {
  question: string;
  symbol: string;
  company: string | null;
  headline: string;
  points: string[];
  citations: Citation[];
  suggestions: string[];
  writtenBy: "data" | "model";
  /** True when the supporting points are the model's words too; false when only the opening line is. */
  modelPoints: boolean;
  asOf: string;
  /** Set when a model is configured but could not be reached, so the page can say why the answer reads plainly. */
  note?: string;
  /** The material the answer was built from. Only filled when asked for, by the checks that verify grounding. */
  context?: string;
}

type Intent = "invest" | "when_buy" | "when_avoid" | "valuation" | "risks" | "profit" | "debt" | "cash" | "shareholding" | "dividend" | "news" | "changed" | "overview";

const RULES: [Intent, RegExp][] = [
  ["when_buy", /when.*(buy|invest|enter)|buy zone|entry price|at what price/i],
  ["when_avoid", /when.*(not|avoid|sell|exit)|should i avoid|why not/i],
  // Word boundaries matter here: "p/e" without them matches the "pe" inside "operating", and "pat" the one
  // inside "pattern", which quietly routed whole questions to the wrong answer.
  ["valuation", /valuation|fair value|expensive|cheap|overvalued|undervalued|\bp\s?\/?\s?e\b|price to book|\bp\/?b\b|worth/i],
  ["risks", /risk|danger|wrong|downside|concern|red flag|\bloss\b/i],
  ["profit", /profit|earnings|revenue|sales|margin|result|quarter|growth|\bpat\b|\beps\b/i],
  ["debt", /debt|borrow|leverage|interest|solvency|loan/i],
  ["cash", /cash flow|cashflow|free cash|fcf|capex|operating cash/i],
  ["shareholding", /sharehold|promoter|fii|dii|institution|pledge|holding/i],
  ["dividend", /dividend|payout|yield/i],
  ["news", /news|announce|filing|\bfiled?\b|disclosure|update|happening|happened|exchange/i],
  ["changed", /what changed|recent|latest|since last|new/i],
  ["invest", /invest|should i|good stock|worth buying|opportunity|recommend/i],
];

/** Which of the thirteen written answers a question calls for. Exported so the routing can be tested. */
export const intentOf = (q: string): Intent => RULES.find(([, re]) => re.test(q))?.[0] ?? "overview";
export type { Intent };

/** The questions offered as chips under the box. */
const STARTERS = [
  "Is it undervalued right now?",
  "When should I buy, and when should I avoid it?",
  "What are the biggest risks?",
  "How did the last quarter go?",
  "How much debt does it carry?",
  "What changed recently?",
];

const WHAT_IT_ANSWERS = [
  "Results and growth: revenue, profit, margins, earnings per share, quarter by quarter.",
  "Balance sheet and cash: debt, cash, operating and free cash flow.",
  "Ownership: promoter, institutional and public holding, and how it has moved.",
  "Dividends and corporate actions, valuation against its own history and its peers, and recent exchange filings.",
];

/**
 * Not every message is a question about the company.
 *
 * A greeting, a question about what this thing is, or something off the subject entirely used to fall through
 * to the catch-all and return a full investment overview - the same wall of figures whatever was typed. These
 * get an answer of their own, without touching the model or the valuation machinery.
 */
export function smallTalk(question: string, company: string): { headline: string; points: string[] } | null {
  const q = question.trim().toLowerCase().replace(/[!?.,]+$/g, "");
  if (!q) return null;

  if (/^(hi|hii+|hey+|hello+|yo|namaste|namaskar|good (morning|afternoon|evening)|greetings)\b/.test(q) && q.length < 30) {
    return {
      headline: `Ask me anything about ${company}, and I will answer from its filings.`,
      points: WHAT_IT_ANSWERS,
    };
  }
  // Typed quickly and often misspelled ("were are you from"), so the pattern is deliberately loose.
  if (/\b(who|what|where|were|wher|hu)\s+(are|r|is)\s+(you|u|your)\b|\bwhat can (you|u) do\b|\bare (you|u) (an? )?(ai|bot|robot|human|chatgpt|gemini|real)\b|\byour name\b|\bhow do (you|u) work\b|\bwho (made|built|created) (you|u)\b/.test(q)) {
    return {
      headline: `I am Market Terminal's research assistant. I answer only from ${company}'s own filings to NSE and BSE, and I show the source for every figure.`,
      points: [
        "I read this company's results, balance sheets, cash-flow statements, shareholding patterns and exchange announcements, and the daily closing prices published by the exchanges.",
        "I do not know anything else. No opinions of my own, no news, nothing about other markets, and nothing that is not in the record I can cite.",
        "Nothing I say is investment advice, a recommendation or a price target - it is an explanation of published figures.",
        ...WHAT_IT_ANSWERS.slice(0, 2),
      ],
    };
  }
  if (/^(thanks?|thank you|thx|ok|okay|cool|nice|great|got it|bye|goodbye)\b/.test(q) && q.length < 25) {
    return { headline: "Glad it helped.", points: [`Ask another question about ${company} whenever you like.`] };
  }
  // A question with nothing to do with the company: weather, sport, other people, general chat.
  if (/\b(weather|joke|cricket|football|movie|song|recipe|who is the (prime minister|president)|your (age|birthday)|love|marry|time in)\b/.test(q)) {
    return {
      headline: `That is outside what I can answer. I only read ${company}'s filings and prices.`,
      points: WHAT_IT_ANSWERS,
    };
  }
  return null;
}

// Words that look like a company name but are not: without this, "profit", "growth" or "power" would send a
// question about the company in view off to some other listing.
const NOT_A_NAME = new Set([
  "what", "when", "where", "which", "why", "how", "does", "did", "will", "with", "from", "that", "this", "these", "those",
  "about", "over", "past", "last", "year", "years", "quarter", "quarterly", "month", "months", "growth", "growing",
  "profit", "profits", "revenue", "sales", "margin", "margins", "debt", "cash", "flow", "dividend", "dividends",
  "share", "shares", "price", "value", "valuation", "risk", "risks", "company", "business", "stock", "market",
  "please", "tell", "show", "give", "much", "many", "good", "better", "than", "into", "their", "there", "them",
  "report", "results", "result", "earnings", "compare", "against", "between", "recent", "latest", "history",
]);

/**
 * A different listed company named in the question - "profit of tata", asked on the Reliance page.
 *
 * Two-word phrases are tried before single words, so "hdfc bank" finds the bank rather than the three HDFC
 * companies. One clear match is answered directly; a name that fits several ("tata") asks which was meant.
 */
function namedElsewhere(db: Db, question: string, symbol: string, company: string): { pick?: { symbol: string; company: string }; options: { symbol: string; company: string }[] } {
  const here = `${symbol} ${company}`.toLowerCase();
  const words = (question.match(/[A-Za-z][A-Za-z&.'-]{2,}/g) ?? []).map((w) => w.toLowerCase());
  const phrases: string[] = [];
  for (let i = 0; i < words.length; i++) {
    if (i + 1 < words.length && !NOT_A_NAME.has(words[i])) phrases.push(`${words[i]} ${words[i + 1]}`);
  }
  for (const w of words) if (w.length >= 4 && !NOT_A_NAME.has(w)) phrases.push(w);

  for (const phrase of phrases) {
    if (here.includes(phrase)) return { options: [] }; // they are asking about the company already in view
    const rows = db.all<{ symbol: string; company: string }>(
      "SELECT symbol, company FROM company_metrics WHERE symbol = ? OR company LIKE ? ORDER BY market_cap_cr DESC NULLS LAST LIMIT 16",
      [phrase.replace(/\s+/g, "").toUpperCase(), `%${phrase}%`]);
    if (!rows.length || rows.length >= 16) continue; // no match, or a word so common it is not a name
    const exact = rows.find((r) => r.symbol.toLowerCase() === phrase.replace(/\s+/g, ""));
    const leading = rows.filter((r) => (r.company ?? "").toLowerCase().startsWith(phrase));
    if (exact) return { pick: exact, options: rows };
    if (leading.length === 1) return { pick: leading[0], options: rows };
    if (leading.length > 1) return { options: leading.slice(0, 6) };
    if (rows.length === 1) return { pick: rows[0], options: rows };
    return { options: rows.slice(0, 6) };
  }
  return { options: [] };
}

/**
 * A name the question treats as a company - "revenue of cisco", "ibm company" - that is not listed here.
 *
 * Only the phrasings that mark a word as a name are used, so a typo in the middle of a sentence is not mistaken
 * for a foreign listing. This matters when no model is available: without it, a question about Cisco was
 * answered with this page's own figures.
 */
function unlistedName(db: Db, question: string, here: string): string | null {
  const q = question.toLowerCase();
  const candidates = [
    ...[...q.matchAll(/\b(?:of|for|about|from)\s+([a-z][a-z&.'-]{2,})\b/g)].map((m) => m[1]),
    ...[...q.matchAll(/\b([a-z][a-z&.'-]{2,})\s+(?:company|ltd|limited|corp|corporation|inc|plc)\b/g)].map((m) => m[1]),
  ];
  for (const name of candidates) {
    if (NOT_A_NAME.has(name) || here.includes(name)) continue;
    const known = db.scalar<number>("SELECT COUNT(*) FROM company_metrics WHERE symbol = ? OR company LIKE ?", [name.toUpperCase(), `%${name}%`]);
    if (!known) return name;
  }
  return null;
}

const pct = (v: number | null, d = 1) => (v === null ? "Data unavailable" : `${v > 0 ? "+" : ""}${v.toFixed(d)}%`);
const cr = (v: number | null) => (v === null ? "Data unavailable" : `₹${Math.round(v).toLocaleString("en-IN")} Cr`);
const rs = (v: number | null) => (v === null ? "Data unavailable" : `₹${v.toLocaleString("en-IN")}`);
/** Keeps the model's context small: hosted free tiers meter tokens by the minute. */
const clip = (t: string, n: number) => (t.length > n ? `${t.slice(0, n)}…` : t);
/** 1st, 2nd, 3rd, 23rd - never "23th". */
const ordinal = (n: number) => `${n}${["th", "st", "nd", "rd"][(n % 100) - (n % 10) !== 10 ? n % 10 : 0] ?? "th"}`;

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
  // A model asked for bullets sometimes runs them together on one line with dashes, or answers in a single
  // paragraph. Both are split back into readable lines rather than shown as a wall of text.
  return text.split(/\n+/)
    .flatMap((l) => (l.length > 160 && (l.match(/\s[-–—]\s+(?=[A-Z0-9₹])/g) ?? []).length >= 2 ? l.split(/\s[-–—]\s+(?=[A-Z0-9₹])/) : [l]))
    .flatMap((l, _i, all) => (all.length === 1 && l.length > 300 ? l.split(/(?<=[.!?])\s+(?=[A-Z₹])/) : [l]))
    .map((line) => line
      .replace(/^\s*(?:[-*•‣]|\d+[.)])\s*/, "")            // bullet or numbered list marker
      .replace(/[【〔［]\s*(\d+)\s*[】〕］]/g, "[$1]")         // full-width brackets the model sometimes emits
      .replace(/[【〔][^】〕]*[】〕]/g, "")                    // an invented label such as 【RISK】
      .replace(/\*\*([^*]+)\*\*/g, "$1")                   // bold
      .replace(/(^|[\s(])[*_]([^*_\n]+)[*_]($|[\s).,;:])/g, "$1$2$3") // italics
      .replace(/^#+\s*/, "").replace(/`/g, "")
      .replace(/\[(\d+)\]/g, (m, n) => (valid.has(Number(n)) ? m : "")) // a citation pointing at nothing
      .replace(/\[[A-Za-z][A-Za-z ./-]{1,28}\]/g, "")      // a label the model made up, such as [DIVIDEND]
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
          v.history.medianPe ? `P/E ${v.inputs.currentPe ?? "?"} against its own ${v.history.years}-year median of ${v.history.medianPe}${v.history.percentile !== null ? ` (${ordinal(v.history.percentile)} percentile)` : ""} [1].` : "",
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

export async function ask(db: Db, symbol: string, question: string, opts: AskOptions = {}): Promise<Answer> {
  const sym = symbol.toUpperCase();
  const named = db.scalar<string>("SELECT company FROM company_metrics WHERE symbol = ? OR bse_code = ?", [sym, sym]);
  const history = (opts.history ?? []).slice(-4);
  const transcript = history.map((t) => `Reader: ${clip(t.q, 200)}\nYou: ${clip(t.a, 400)}`).join("\n");

  // A greeting, or a question about the assistant itself. With a model configured it answers these in its own
  // words from a short brief - no valuation is run and no figures are fetched, so it costs almost nothing.
  const chat = smallTalk(question, named ?? sym);
  if (chat) {
    const plain = (headline: string, points: string[]): Answer => ({
      question, symbol: sym, company: named ?? null, headline, points,
      citations: [], suggestions: STARTERS, writtenBy: llm.available() ? "model" : "data",
      modelPoints: false, asOf: new Date().toISOString(),
    });
    if (!llm.available()) return { ...plain(chat.headline, chat.points), writtenBy: "data" };
    const brief = [
      `COMPANY IN VIEW: ${named ?? sym}`,
      `WHAT YOU CAN ANSWER: ${WHAT_IT_ANSWERS.join(" ")}`,
      "WHAT YOU ARE: the research assistant on Market Terminal, which reads this company's own filings to NSE and BSE. You have no news, no opinions and no knowledge of anything outside those filings.",
      transcript ? `EARLIER IN THIS CONVERSATION:\n${transcript}` : "",
    ].filter(Boolean).join("\n");
    const said = await llm.complete(question, brief);
    const lines = said ? cleanPoints(said, new Set()) : [];
    return lines.length ? plain(lines[0], lines.slice(1)) : { ...plain(chat.headline, chat.points), writtenBy: "data" };
  }

  // A question that names a different company is answered about that company, not about this page's.
  const elsewhere = namedElsewhere(db, question, sym, named ?? sym);
  if (elsewhere.pick && elsewhere.pick.symbol !== sym) {
    const moved = await ask(db, elsewhere.pick.symbol, question, { ...opts, history: [] });
    return { ...moved, headline: `You asked about ${elsewhere.pick.company}, not ${named ?? sym}. ${moved.headline}` };
  }
  const foreign = elsewhere.pick || elsewhere.options.length ? null : unlistedName(db, question, `${sym} ${named ?? ""}`.toLowerCase());
  if (foreign) {
    const shown = foreign.charAt(0).toUpperCase() + foreign.slice(1);
    return {
      question, symbol: sym, company: named ?? null,
      headline: `${shown} does not file with NSE or BSE, so there is nothing about it on record here.`,
      points: [
        `This platform reads the filings of about 3,400 companies listed in India. A company listed abroad, or a private one, is outside it.`,
        `The company in view is ${named ?? sym}. ${WHAT_IT_ANSWERS[0]}`,
        "To read a different Indian company, search for it at the top of the page, or name it in your question.",
      ],
      citations: [], suggestions: STARTERS, writtenBy: "data", modelPoints: false, asOf: new Date().toISOString(),
    };
  }

  if (elsewhere.options.length > 1) {
    return {
      question, symbol: sym, company: named ?? null,
      headline: `Which company did you mean? This page is ${named ?? sym}.`,
      points: elsewhere.options.map((c) => `${c.company} (${c.symbol})`),
      citations: [], suggestions: elsewhere.options.slice(0, 4).map((c) => `How did ${c.company} do last quarter?`),
      writtenBy: "data", modelPoints: false, asOf: new Date().toISOString(),
    };
  }

  const d = decide(db, symbol);
  const key = `${d.symbol}|${d.facts.price.session ?? ""}|${transcript.length}|${question.trim().toLowerCase().replace(/\s+/g, " ")}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.answer;
  const bseCode = db.scalar<string>("SELECT bse_code FROM company_metrics WHERE symbol = ?", [d.symbol]);
  const intent = intentOf(question);
  // "And its debt?" carries no search terms of its own, so a short follow-up searches with the question before it.
  const retrieveWith = question.trim().split(/\s+/).length <= 4 && history.length ? `${history.at(-1)!.q} ${question}` : question;
  const found = passages(db, d.symbol, bseCode ? String(bseCode) : null, retrieveWith, 4);
  const known = knowledge(db, d.symbol, retrieveWith, 3);
  // Whatever has been read into the document library for this company - filings, annual reports, uploads.
  const read = await searchDocuments(db, d.symbol, retrieveWith, 3).catch(() => []);

  const citations = baseCitations(d);
  const baseCount = citations.length;
  for (const p of known) citations.push({ n: citations.length + 1, label: p.title.slice(0, 90), source: `knowledge base (${p.kind})`, period: p.when.slice(0, 10), url: p.url });
  for (const p of found) citations.push({ n: citations.length + 1, label: `${p.exchange} filing: ${p.title.slice(0, 90)}`, source: `${p.exchange} announcement`, period: p.when.slice(0, 10), url: p.url });
  const docStart = citations.length;
  for (const r of read) citations.push({ n: citations.length + 1, label: `${r.title.slice(0, 80)}${r.page ? `, page ${r.page}` : ""}`, source: r.kind === "upload" ? "document you uploaded" : "document read in full", period: null, url: r.url });

  const written = compose(intent, d, found);
  let shown = ""; // the context, kept only for the grounding checks
  let headline = written.headline;
  // What the documents themselves say comes first, quoted and cited. Without this an uploaded report would be
  // invisible whenever no model is available, which is exactly when a reader needs the quote most.
  let points = read.length
    ? [
      ...read.slice(0, 2).map((r, i) => `From ${r.title}${r.page ? `, page ${r.page}` : ""}: "${r.snippet}" [${docStart + i + 1}]`),
      ...written.points.slice(0, 3),
    ]
    : written.points;
  let writtenBy: "data" | "model" = "data";
  let modelPoints = false;
  let note: string | undefined;

  if (llm.available()) {
    // Every line the model may quote carries the citation number the reader will see, so a claim in the answer
    // can be traced to the filing it came from - and anything it cites that is not here is dropped below.
    const cite = (label: string) => {
      const c = citations.find((x) => x.label === label);
      return c ? `[${c.n}] ` : "";
    };
    const f = d.facts;
    const context = [
      transcript ? `EARLIER IN THIS CONVERSATION:
${transcript}
` : "",
      `COMPANY: ${d.company ?? d.symbol} (${d.symbol}), ${f.industry ?? "industry unknown"}${f.bank ? ", a lender" : ""}; market cap ${cr(f.marketCapCr.value)}`,
      `${cite("Price and market cap")}PRICE: ${rs(f.price.value)} on ${f.price.session}; return 1 month ${pct(f.returns.ret1m.value)}, 1 year ${pct(f.returns.ret1y.value)}`,
      // The question decides what a reader needs, so the figures they might ask about are all here: growth,
      // margins, dividends and corporate actions were missing, and a model cannot report what it is not given.
      `${cite("Quarterly results")}GROWTH: revenue ${pct(f.growth.revenueYoY.value)} and profit ${pct(f.growth.patYoY.value)} against the same quarter last year; three-year CAGR revenue ${pct(f.growth.revenueCagr3y.value)}, profit ${pct(f.growth.patCagr3y.value)}`,
      `${cite("Quarterly results")}MARGINS: operating ${pct(f.margins.operating.value)}, net ${pct(f.margins.net.value)}, gross ${pct(f.margins.gross.value)}; return on equity ${pct(f.returns.roe.value)}`,
      `DIVIDEND: ${rs(f.dividend.perShare.value)} per share over twelve months, yield ${pct(f.dividend.yield.value)}, payout ${pct(f.dividend.payout.value)} of earnings`,
      f.actions.length ? `CORPORATE ACTIONS: ${f.actions.slice(0, 6).map((a) => `${a.purpose}${a.exDate ? ` (ex-date ${a.exDate})` : ""}`).join(" | ")}` : "CORPORATE ACTIONS: none on record in the last two years",
      `VALUATION MULTIPLES: P/E ${d.valuation.inputs.currentPe ?? "unavailable"} against its own ${d.valuation.history.years}-year median ${d.valuation.history.medianPe ?? "unavailable"}; peer median P/E ${d.valuation.peers.medianPe ?? "unavailable"} across ${d.valuation.peers.count} companies in ${d.valuation.peers.industry ?? "its industry"}`,
      `COMPUTED HERE, no citation needed - FAIR VALUE: ${rs(d.valuation.fairValue)} (range ${rs(d.valuation.range.bear)}–${rs(d.valuation.range.bull)}, confidence ${d.valuation.confidence}); margin of safety ${d.valuation.marginOfSafety}%; status ${d.valuation.status}`,
      `MODELS: ${d.valuation.models.filter((m) => m.fairValue !== null).map((m) => `${m.label} ${rs(m.fairValue)}`).join(" | ")}`,
      `COMPUTED HERE, no citation needed - VERDICT: ${d.verdict}`,
      `CONDITIONS: ${d.conditionsMet}`,
      `COMPUTED HERE, no citation needed - RISK: ${d.risk.level}. ${d.risk.factors.filter((r) => r.level !== "low").map((r) => `${r.label}: ${clip(r.detail, 90)}`).join(" | ")}`,
      `${cite("Quarterly results")}QUARTERS: ${f.quarters.slice(0, 3).map((q) => `${q.period} revenue ${cr(q.revenue)} profit ${cr(q.pat)} EPS ${rs(q.eps)}`).join(" | ")}`,
      `${cite("Balance sheet")}BALANCE SHEET (${f.balance.period}): debt ${cr(f.balance.debtCr.value)}, cash ${cr(f.balance.cashCr.value)}, D/E ${f.balance.debtToEquity.value}, interest cover ${f.balance.interestCover.value ?? "n/a"}`,
      `${cite("Cash flow statement")}CASH FLOW (${f.cash.period}): operating ${cr(f.cash.cfoCr.value)}, capex ${cr(f.cash.capexCr.value)}, free ${cr(f.cash.fcfCr.value)}, profit converted to cash ${pct(f.cash.conversion.value)}`,
      `${cite("Shareholding pattern")}SHAREHOLDING (${f.shareholding.asOf}): promoter ${f.shareholding.promoter.value}%, FII ${f.shareholding.fii.value}%, DII ${f.shareholding.dii.value}%, public ${f.shareholding.public.value}%; promoter change ${f.shareholding.promoterChange.value ?? "n/a"} points on the quarter`,
      ...known.map((p, i) => `[${baseCount + i + 1}] ${p.kind}, ${p.when.slice(0, 10)}: ${p.title}. ${clip(p.detail ?? "", 220)}`),
      ...found.map((p, i) => `[${baseCount + known.length + i + 1}] ${p.exchange} filing ${p.when.slice(0, 10)}: ${p.title}${p.detail ? `. ${clip(p.detail, 100)}` : ""}`),
      // Passages read out of the documents themselves: this is where anything the company actually wrote appears.
      ...read.map((r, i) => `[${docStart + i + 1}] from "${r.title}"${r.page ? `, page ${r.page}` : ""}: ${clip(r.text, 1200)}`),
    ].join("\n");
    shown = context;
    const text = await llm.complete(question, context);
    if (!text) note = "The model was busy, so this answer was written straight from the figures.";
    const cleaned = text ? cleanPoints(text, new Set(citations.map((c) => c.n))) : [];
    if (cleaned.length) {
      // The model's opening sentence answers the question asked; the rule-written headline answers whichever of
      // the thirteen intents the question was routed to, which is not always the same thing.
      [headline, ...points] = cleaned;
      modelPoints = points.length > 0;
      // A one-line answer keeps the written detail beneath it - unless that line says the record does not answer
      // the question, in which case stapling a company summary underneath would contradict it.
      // A one-line answer keeps the written detail beneath it only when that detail is still on the subject:
      // not after a refusal, not when the answer came out of a document, and not when it already said enough.
      const standsAlone = read.length > 0 || headline.length > 140
        || /do not answer|does not answer|cannot|can't|not in the|no information|outside/i.test(headline);
      if (!points.length) points = standsAlone ? [] : written.points;
      writtenBy = "model";
    }
  }

  const answer: Answer = {
    question,
    symbol: d.symbol,
    company: d.company,
    headline,
    points,
    citations,
    suggestions: STARTERS,
    writtenBy,
    modelPoints,
    note,
    asOf: new Date().toISOString(),
    ...(opts.debug ? { context: shown } : {}),
  };
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
  cache.set(key, { at: Date.now(), answer });
  return answer;
}
