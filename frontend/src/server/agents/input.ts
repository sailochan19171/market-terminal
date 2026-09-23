// The input layer (spec §3.1): which company, what kind of question, and whether it is one we should answer.
//
// Code first. Company names are matched against the listings on file; intent and the guardrails are fixed rules,
// so a request for a price prediction is refused the same way every time. The model is consulted only to pull a
// company name out of a message the rules could not place.
import type { Db } from "../db";
import { plainName, usListings } from "./providers/us";
import type { Intent, Market } from "./state";
import { parseJson, type Trace } from "./trace";

export interface Match { symbol: string; company: string; industry: string | null; market: Market }

export interface InputResult {
  intent: Intent;
  isAllowed: boolean;
  blockedReason?: string;
  companies: Match[];           // resolved, in the order named (two for a comparison)
  ambiguous: { name: string; options: Match[] } | null;
  metric: string | null;        // for single_metric: the ratio key asked about
  concept: string | null;       // for explain_concept
  /** Something the reader should know about how the question was read (which listing was used). */
  note?: string | null;
}

// --- guardrails --------------------------------------------------------------------------

const BLOCKED: { re: RegExp; reason: string }[] = [
  { re: /\b(will|going to|gonna|can|could)\b.{0,40}\b(double|triple|10x|multibag|skyrocket|moon|crash|go up|go down|rise|fall|hit|reach|touch|cross)\b/i,
    reason: "That asks for a price prediction. Nobody can say where a share price will go, and this research tool does not guess." },
  { re: /\b(tomorrow|next week|this week|intraday|today)\b.{0,40}\b(price|stock|share|buy|sell|trade|move)|\b(price|stock|share)\b.{0,40}\b(tomorrow|next week|intraday)\b/i,
    reason: "Short-term price moves and trading signals are outside what this research covers. It looks at businesses over years, not days." },
  { re: /\b(target price|price target|stop ?loss|entry (point|level)|exit (point|level)|when (should|to) (i )?(buy|sell))\b/i,
    reason: "Target prices and entry or exit levels are advice that only a SEBI-registered adviser may give. The analysis can show what the figures say about value instead." },
  { re: /\b(guarantee[d]?|sure[- ]?shot|risk[- ]?free|assured) (return|profit|gain|income)s?\b|\bdouble my money\b/i,
    reason: "No investment has guaranteed returns, and this tool will not suggest otherwise." },
  { re: /\b(which|what|best|top)\b.{0,30}\b(stock|share|penny stock)s?\b.{0,30}\b(buy|double|invest|profit|multibagger)\b/i,
    reason: "Picking stocks to buy is personalised advice this tool does not give. Name a company and it will analyse it for you." },
];

const OFF_TOPIC = /\b(weather|joke|recipe|cricket score|football|movie|song|poem|homework|write (me )?(a|an) (essay|story|code)|girlfriend|boyfriend|horoscope|lottery|betting|casino)\b/i;

// --- intent ------------------------------------------------------------------------------

/** Words for ratios the engine computes, mapped to its keys. Used for single_metric and explain_concept. */
export const METRIC_WORDS: [RegExp, string][] = [
  [/\broe\b|return on equity/i, "roe"],
  [/\broce\b|return on capital employed/i, "roce"],
  [/\broic\b|return on invested capital/i, "roic"],
  [/\broa\b|return on assets/i, "roa"],
  [/\bdebt[- ]to[- ]equity\b|\bd\/e\b|\bleverage\b|\bdebt\b|\bborrowing/i, "debtToEquity"],
  [/\binterest cover(age)?\b/i, "interestCoverage"],
  [/\bcurrent ratio\b|\bliquidity\b/i, "currentRatio"],
  [/\bquick ratio\b/i, "quickRatio"],
  [/\bp\/?e\b|price[- ]to[- ]earnings|\bpe ratio\b/i, "pe"],
  [/\bp\/?b\b|price[- ]to[- ]book/i, "pb"],
  [/\bpeg\b/i, "peg"],
  [/\bev\/?ebitda\b|enterprise value/i, "evEbitda"],
  [/\bdividend yield\b/i, "dividendYield"],
  [/\bdividend|payout\b/i, "payoutRatio"],
  [/\bfree cash ?flow\b|\bfcf\b/i, "freeCashFlow"],
  [/\bcash conversion cycle\b/i, "cashConversionCycle"],
  [/\bcash conversion\b/i, "cashConversion"],
  [/\bgross margin\b/i, "grossMargin"],
  [/\boperating margin\b|\bebit margin\b/i, "operatingMargin"],
  [/\bebitda margin\b/i, "ebitdaMargin"],
  [/\bnet (profit )?margin\b|\bmargins?\b/i, "netMargin"],
  [/\brevenue growth\b|\bsales growth\b/i, "revenueCagr5y"],
  [/\beps growth\b|\bearnings growth\b/i, "epsCagr5y"],
  [/\bnet interest margin\b|\bnim\b/i, "netInterestMargin"],
  [/\bcost[- ]to[- ]income\b/i, "costToIncome"],
  [/\bcredit[- ]deposit\b|\bcd ratio\b/i, "creditToDeposit"],
  [/\bnpa\b|non[- ]performing/i, "gross_npa"],
  [/\bpiotroski\b|\bf[- ]score\b/i, "piotroski"],
  [/\baltman\b|\bz[- ]score\b/i, "altmanZ"],
  [/\bbeneish\b|\bm[- ]score\b/i, "beneishM"],
  [/\bdupont\b/i, "dupont"],
  [/\bmargin of safety\b|\bintrinsic value\b|\bdcf\b|discounted cash/i, "marginOfSafety"],
  [/\binventory\b/i, "daysInventoryOutstanding"],
  [/\breceivables?\b|\bdso\b/i, "daysSalesOutstanding"],
];

const metricIn = (q: string) => METRIC_WORDS.find(([re]) => re.test(q))?.[1] ?? null;

const FULL = /\b(analy[sz]e|analysis|review|deep dive|overview|long[- ]term|invest(ment|ing)?|look at|worth|opinion|view on|thoughts on|tell me about|what do you (think|make)|fundamentals|research)\b/i;
const COMPARING = /\b(vs\.?|versus|compare[ds]?|comparison|compared (to|with)|better than|against)\b/i;
const EXPLAIN = /^\s*(what (is|are|does)|explain|define|meaning of|how (is|do you) (calculate|compute|measure)|why does .* matter)\b/i;

// --- company resolution ------------------------------------------------------------------

const STOP = new Set([
  "analyse", "analyze", "analysis", "review", "compare", "versus", "against", "better", "company", "stock", "share", "shares",
  "invest", "investment", "should", "would", "could", "about", "their", "there", "these", "those", "what", "which", "where",
  "when", "debt", "profit", "margin", "margins", "growth", "value", "price", "ratio", "return", "equity", "cash", "flow",
  "dividend", "long", "term", "look", "worth", "tell", "think", "concern", "risk", "risks", "business", "with", "from",
  "that", "this", "does", "have", "limited", "ltd", "india", "indian", "market", "listed", "good", "strong", "moat",
  "buffett", "lynch", "warren", "peter", "style", "view", "opinion", "please", "give", "show", "much", "many", "carry",
  "earnings", "revenue", "sales", "concern", "concerned", "is", "it", "its", "and", "or", "the", "for", "how",
]);

// Everyday words that also begin company names ("Best Agrolife", "Future Retail"). Typed in lower case on their
// own they are words, not names; in capitals, or with the rest of the name, they still match.
const COMMON = new Set([
  "best", "idea", "good", "great", "first", "new", "high", "super", "star", "prime", "united", "national", "global",
  "future", "royal", "smart", "ultra", "capital", "bright", "gold", "silver", "standard", "general", "modern", "simple",
  "next", "happy", "hope", "ideal", "excel", "vision", "focus", "trust", "safe", "sure", "just", "only", "real", "true",
  "fine", "rich", "wise", "dynamic", "quality", "premier", "supreme", "vintage", "classic", "active", "alpha", "delta",
  "omega", "orient", "pioneer", "prudent", "reliable", "sterling", "unique", "welcome", "worth", "right",
  "time", "today", "money", "stock", "shares", "fund", "home", "life", "health", "energy", "power", "water", "steel",
  "cement", "sugar", "paper", "textile", "motor", "motors", "auto", "bank", "finance", "housing", "infra", "tech",
  "digital", "media", "network", "systems", "solutions", "services", "industries", "enterprises", "ventures",
  "hold", "sell", "long", "term", "short", "growth", "income", "safety", "margin", "concern", "company",
]);

const tokenize = (message: string) =>
  (message.match(/[A-Za-z][A-Za-z0-9&.'-]*/g) ?? []).map((t) => t.replace(/['’]s$/i, "").replace(/[.'-]+$/, ""));

// Abbreviations that look like tickers but are the vocabulary of the question.
const NOT_TICKERS = new Set(["I", "A", "US", "USA", "PE", "PB", "ROE", "ROA", "ROCE", "ROIC", "EPS", "FCF", "DCF", "NIM", "CAR", "CASA", "NPA",
  "TTM", "CEO", "CFO", "IPO", "EV", "EBIT", "EBITDA", "PEG", "YOY", "FY", "AI", "IT", "OK", "NSE", "BSE", "NYSE", "SEC", "GAAP", "CAGR", "DE", "CD"]);

/**
 * US listings named in the message (spec §3.1: "search US exchanges and NSE/BSE"). A ticker counts when typed in
 * capitals (AAPL) or marked (AAPL.US, NYSE:JPM); a name counts when it is the listed name without its "Inc."/"Corp".
 */
export async function findUsCompanies(message: string, indiaSymbols: Set<string>): Promise<{ found: (Match & { phrase: string })[]; ambiguous: { name: string; options: Match[] } | null }> {
  const listings = await usListings();
  const byTicker = new Map(listings.map((l) => [l.ticker, l]));
  const toMatch = (l: (typeof listings)[number], phrase: string) => ({ symbol: l.ticker, company: l.title, industry: null, market: "US" as const, phrase });
  const found: (Match & { phrase: string })[] = [];
  let ambiguous: { name: string; options: Match[] } | null = null;
  const tokens = tokenize(message);
  const used = new Set<number>();

  tokens.forEach((t, i) => {
    const explicit = /\.US$/i.test(t) || new RegExp(`\\b(NYSE|NASDAQ|US):\\s*${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(message);
    const ticker = t.replace(/\.US$/i, "").toUpperCase().replace(/\./g, "-");
    // Two letters or more, and not part of a ratio written with a slash (P/E, D/E, EV/EBITDA); one-letter tickers
    // (P, F, T) only count when marked, e.g. F.US.
    const inRatio = new RegExp(`(^|[^A-Za-z])${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*/|/\\s*${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^A-Za-z]|$)`).test(message);
    const typedAsTicker = t === t.toUpperCase() && /^[A-Z][A-Z.-]{1,5}$/.test(t.replace(/\.US$/i, "")) && !NOT_TICKERS.has(ticker) && !inRatio;
    // A bare symbol that is also listed in India defaults to NSE (spec §5.0), unless marked as US.
    if ((explicit || (typedAsTicker && !indiaSymbols.has(ticker))) && byTicker.has(ticker)) {
      const l = byTicker.get(ticker)!;
      if (!found.some((f) => f.symbol === l.ticker)) found.push(toMatch(l, t));
      used.add(i);
    }
  });

  const plain = listings.map((l) => ({ l, name: plainName(l.title) }));
  for (const size of [3, 2, 1]) {
    for (let i = 0; i + size <= tokens.length; i++) {
      if ([...Array(size).keys()].some((k) => used.has(i + k))) continue;
      const words = tokens.slice(i, i + size);
      if (words.some((w, k) => STOP.has(w.toLowerCase()) && (k === 0 || k === size - 1))) continue;
      const phrase = plainName(words.join(" "));
      if (phrase.length < 3) continue;
      if (size === 1 && (COMMON.has(phrase) || phrase.length < 4)) continue;
      const exact = plain.filter((p) => p.name === phrase);
      const leading = exact.length ? exact : plain.filter((p) => p.name.startsWith(`${phrase} `));
      if (!leading.length || leading.length > 12) continue;
      // Several share classes of one company (GOOGL, GOOG) are one company: keep the largest.
      // Common stock before preferred shares, notes and warrants (JPM before JPM-PM), then the larger listing.
      const commonFirst = (t: string) => (/^[A-Z]{1,5}$/.test(t) ? 0 : 1);
      const ordered = leading.slice().sort((a, b) => commonFirst(a.l.ticker) - commonFirst(b.l.ticker) || a.l.rank - b.l.rank);
      const byCompany = [...ordered.reduce((m, p) => (m.has(p.name) ? m : m.set(p.name, p)), new Map<string, (typeof ordered)[number]>()).values()];
      if (byCompany.length === 1) {
        if (!found.some((f) => f.symbol === byCompany[0].l.ticker)) found.push(toMatch(byCompany[0].l, words.join(" ")));
      } else if (!ambiguous) {
        ambiguous = { name: words.join(" "), options: byCompany.slice(0, 8).map((p) => toMatch(p.l, words.join(" "))) };
      }
      for (let k = 0; k < size; k++) used.add(i + k);
    }
  }
  return { found, ambiguous };
}

/** Names in the message that match listings on file, longest phrase first. */
export function findCompanies(db: Db, message: string): { found: Match[]; ambiguous: { name: string; options: Match[] } | null } {
  const tokens = tokenize(message).filter((t) => !/\.US$/i.test(t));
  const found: Match[] = [];
  let ambiguous: { name: string; options: Match[] } | null = null;
  const used = new Set<number>();

  for (const size of [3, 2, 1]) {
    for (let i = 0; i + size <= tokens.length; i++) {
      if ([...Array(size).keys()].some((k) => used.has(i + k))) continue;
      const words = tokens.slice(i, i + size);
      if (words.some((w, k) => STOP.has(w.toLowerCase()) && (k === 0 || k === size - 1))) continue;
      const phrase = words.join(" ");
      if (phrase.length < 3) continue;

      // An exact trading symbol (RELIANCE, HDFCBANK, TCS) wins outright.
      if (size === 1) {
        const bySymbol = db.get<Match>("SELECT symbol, company, industry, 'IN' AS market FROM company_metrics WHERE symbol = ?", [phrase.toUpperCase().replace(/\.(NS|BO)$/, "")]);
        // A lowercase word counts as a symbol only when it is also the start of the name ("infosys"), so ordinary
        // words that happen to be tickers ("idea", "best") are not taken for companies.
        if (bySymbol && (phrase === phrase.toUpperCase() || (bySymbol.company ?? "").toLowerCase().startsWith(phrase.toLowerCase()))) {
          if (!found.some((f) => f.symbol === bySymbol.symbol)) found.push(bySymbol);
          used.add(i);
          continue;
        }
        if (phrase.length < 4) continue;
      }
      // A lone lower-case word is a name only if a listing starts with it and it is not an everyday word.
      const loneWord = size === 1 && phrase !== phrase.toUpperCase();
      if (loneWord && COMMON.has(phrase.toLowerCase())) continue;
      const whole = new RegExp(`\\b${phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
      const rows = db.all<Match>(
        "SELECT symbol, company, industry, 'IN' AS market FROM company_metrics WHERE company LIKE ? AND close IS NOT NULL ORDER BY market_cap_cr DESC NULLS LAST LIMIT 25", [`%${phrase}%`])
        .filter((r) => whole.test(r.company ?? ""))
        .filter((r) => !loneWord || (r.company ?? "").toLowerCase().startsWith(phrase.toLowerCase()));
      if (!rows.length || rows.length >= 25) continue;
      const leading = rows.filter((r) => (r.company ?? "").toLowerCase().startsWith(phrase.toLowerCase()));
      const pick = rows.length === 1 ? rows[0] : leading.length === 1 ? leading[0] : null;
      if (pick) {
        if (!found.some((f) => f.symbol === pick.symbol)) found.push(pick);
      } else if (!ambiguous) {
        ambiguous = { name: phrase, options: (leading.length ? leading : rows).slice(0, 8) };
      }
      for (let k = 0; k < size; k++) used.add(i + k);
    }
  }
  // Keep the order the names appear in the message.
  const at = (m: Match) => {
    const idx = message.toLowerCase().indexOf(m.symbol.toLowerCase());
    const byName = message.toLowerCase().indexOf((m.company ?? "").toLowerCase().split(" ")[0]);
    return Math.min(...[idx, byName].filter((v) => v >= 0), 1e9);
  };
  found.sort((a, b) => at(a) - at(b));
  return { found, ambiguous: found.length ? null : ambiguous };
}

export async function readInput(db: Db, message: string, trace: Trace, context: { symbol?: string | null; market?: Market | null } = {}): Promise<InputResult> {
  const q = message.trim();
  const base = { companies: [] as Match[], ambiguous: null, metric: metricIn(q), concept: null as string | null };

  for (const b of BLOCKED) if (b.re.test(q)) return { ...base, intent: "out_of_scope", isAllowed: false, blockedReason: b.reason };
  if (OFF_TOPIC.test(q)) {
    return { ...base, intent: "out_of_scope", isAllowed: false, blockedReason: "That is outside investment research. Ask about a company listed on NSE, BSE or a US exchange, or about a financial ratio." };
  }

  /** Both markets searched together; a name listed in both is put to the reader (spec §3.1). */
  const search = async (text: string) => {
    const india = findCompanies(db, text);
    let us: Awaited<ReturnType<typeof findUsCompanies>> = { found: [], ambiguous: null };
    try {
      us = await findUsCompanies(text, new Set(india.found.map((f) => f.symbol)));
    } catch { /* SEC unreachable: India-only search, as before */ }
    const found: Match[] = [...india.found];
    const twins: { name: string; india: Match; us: Match }[] = [];
    for (const u of us.found) {
      const usMatch: Match = { symbol: u.symbol, company: u.company, industry: u.industry, market: "US" };
      const twin = india.found.find((f) => new RegExp(`\\b${plainName(u.phrase).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(f.company ?? ""));
      if (twin && u.phrase !== u.phrase.toUpperCase()) twins.push({ name: u.phrase, india: twin, us: usMatch });
      else found.push(usMatch);
    }
    let ambiguous = india.ambiguous ?? (india.found.length ? null : us.ambiguous);
    let note: string | null = null;
    const comparing = found.length >= 2 || COMPARING.test(text);

    if (twins.length && found.length >= 2) {
      // A comparison that names a company listed in both markets (Infosys, Wipro, HDFC Bank have US ADRs): keep
      // every company in one market, the market of the others where they agree, else India - and say so.
      const others = found.filter((f) => !twins.some((t) => t.india === f));
      const markets = new Set(others.map((o) => o.market));
      const market: Market = markets.size === 1 ? [...markets][0] : "IN";
      if (market === "US") for (const t of twins) found.splice(found.indexOf(t.india), 1, t.us);
      const names = twins.map((t) => t.india.company).join(" and ");
      note = `${names} ${twins.length > 1 ? "are" : "is"} listed in both India and the US; the ${market === "IN" ? "NSE" : "US"} listing${twins.length > 1 ? "s were" : " was"} used so the comparison stays within one market. Write a ticker such as ${twins[0].india.symbol}${market === "IN" ? ".US" : ".NS"} to use the other.`;
    } else if (twins.length) {
      // One company, listed in both markets: the reader chooses (spec §3.1).
      ambiguous = { name: twins[0].name, options: [twins[0].india, twins[0].us] };
      found.splice(found.indexOf(twins[0].india), 1);
    }
    // A comparison where one name could not be placed must ask, never quietly analyse only the other company.
    if (comparing && found.length === 1 && (india.ambiguous || us.ambiguous)) {
      return { found: [] as Match[], ambiguous: india.ambiguous ?? us.ambiguous, note };
    }
    // Keep the order the names appear in the message.
    const lower = text.toLowerCase();
    const at = (m: Match) => Math.min(...[lower.indexOf(m.symbol.toLowerCase()), lower.indexOf(plainName(m.company ?? "").split(" ")[0] ?? "")].filter((v) => v >= 0), 1e9);
    found.sort((a, b) => at(a) - at(b));
    return { found, ambiguous: found.length ? null : ambiguous, note };
  };

  let first = await search(q);
  // A brand written with its apostrophe ("McDonald's", "Kellogg's") is listed without it ("MCDONALDS CORP").
  if (!first.found.length && !first.ambiguous && /\w['’]s\b/.test(q)) first = await search(q.replace(/(\w)['’]s\b/g, "$1s"));
  let { found, ambiguous } = first;
  const note = first.note;
  // A name listed in both markets needs no question when that company is the one already open on the page.
  const inViewOption = ambiguous?.options.find((o) => o.symbol === context.symbol?.toUpperCase() && o.market === (context.market ?? "IN"));
  if (inViewOption) {
    found = [inViewOption];
    ambiguous = null;
  }

  // The rules found no name: a model may recognise a misspelling or a brand ("Jio" -> Reliance, "Google" -> Alphabet).
  if (!found.length && !ambiguous && q.split(/\s+/).length > 1) {
    const reply = await trace.llm("input_layer", {
      system: "Extract the names of listed companies (Indian NSE/BSE or US NYSE/NASDAQ) from an investing question. Return JSON {\"companies\": [\"name as it is listed, or its ticker\"]}. Correct obvious misspellings and map well-known brands to their listed parent. Return an empty list if none is named. JSON only.",
      user: q, json: true, temperature: 0, maxTokens: 400,
    });
    const names = parseJson<{ companies?: unknown[] }>(reply.text)?.companies ?? [];
    for (const name of names.slice(0, 2).map(String)) {
      const again = await search(name);
      found.push(...again.found.filter((f) => !found.some((x) => x.symbol === f.symbol)));
      ambiguous ??= again.ambiguous;
    }
  }

  // Nothing named: the company already in view, if the page has one.
  if (!found.length && !ambiguous && context.symbol) {
    if (context.market === "US") {
      try {
        const l = (await usListings()).find((x) => x.ticker === context.symbol!.toUpperCase());
        if (l) found = [{ symbol: l.ticker, company: l.title, industry: null, market: "US" }];
      } catch { /* unreachable: fall through */ }
    } else {
      const inView = db.get<Match>("SELECT symbol, company, industry, 'IN' AS market FROM company_metrics WHERE symbol = ?", [context.symbol.toUpperCase()]);
      if (inView) found = [inView];
    }
  }

  // "What is DuPont analysis?" asks about the measure, not about DuPont de Nemours: a measure named after a person
  // or a company wins when the question is a definition and no ticker is marked.
  const namedMeasure = /\b(dupont|altman|piotroski|beneish)\b/i.test(q) && !/\.(NS|BO|US)\b/.test(q);
  if (EXPLAIN.test(q) && base.metric && (namedMeasure || !found.filter((f) => f.symbol !== context.symbol?.toUpperCase()).length) && !/\b(its|this company|their)\b/i.test(q)) {
    return { ...base, intent: "explain_concept", isAllowed: true, concept: base.metric, companies: [] };
  }
  if (found.length >= 2) {
    return { ...base, intent: "comparison", isAllowed: true, companies: found.slice(0, 2), ambiguous: null, note };
  }
  if (ambiguous && !found.length) return { ...base, intent: FULL.test(q) || !base.metric ? "full_analysis" : "single_metric", isAllowed: true, ambiguous };
  if (!found.length) {
    return { ...base, intent: "full_analysis", isAllowed: false, blockedReason: "Name a listed company - for example \"Analyse Infosys\", \"Analyse Apple\" or \"Is HDFC Bank's debt a concern?\"." };
  }
  const single = Boolean(base.metric) && !FULL.test(q);
  return { ...base, intent: single ? "single_metric" : "full_analysis", isAllowed: true, companies: found.slice(0, 1), note };
}
