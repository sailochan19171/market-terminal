// The validator (spec §8.1): rule-based checks, so a wrong number never reaches the reader unflagged.
//
// It never edits a figure. It warns, marks balance-sheet ratios low-confidence, names the worker to re-run when
// something is impossible, and removes qualitative claims that carry no source.
import type { QualitativeReport, RatioReport, RawData, TechnicalReport, ValidationIssue, ValidationReport, ValuationReportOut } from "./state";

export interface Reports {
  raw: RawData;
  ratios: RatioReport | null;
  valuation: ValuationReportOut | null;
  technical: TechnicalReport | null;
  qualitative: QualitativeReport | null;
}

const pct = (v: number) => `${(v * 100).toFixed(1)}%`;

export function validate(r: Reports, today = new Date()): ValidationReport {
  const warnings: ValidationIssue[] = [];
  const failedItems: ValidationIssue[] = [];
  const lowConfidence: string[] = [];
  const annual = [...r.raw.annual].sort((a, b) => a.year - b.year);

  // Accounting identity: assets ≈ liabilities + equity, within 1%.
  for (const y of annual.slice(-3)) {
    if (y.totalAssets === null || y.totalLiabilities === null || y.shareholdersEquity === null || y.totalAssets === 0) continue;
    const gap = Math.abs(y.totalAssets - (y.totalLiabilities + y.shareholdersEquity)) / Math.abs(y.totalAssets);
    if (gap > 0.01) {
      warnings.push({ check: "accounting_identity", severity: "warning", worker: "ratio_engine",
        detail: `FY${y.year}: total assets differ from liabilities plus equity by ${pct(gap)} (minority interest or a parsing gap); balance-sheet ratios for that year are low confidence` });
      lowConfidence.push(`FY${y.year} balance sheet`);
    }
  }

  // Impossible values: re-fetch once, then mark unavailable.
  for (const y of annual) {
    const bad = [
      y.revenue !== null && y.revenue < 0 ? `revenue ${y.revenue}` : null,
      y.sharesDiluted !== null && y.sharesDiluted <= 0 ? `shares ${y.sharesDiluted}` : null,
      y.totalAssets !== null && y.totalAssets < 0 ? `total assets ${y.totalAssets}` : null,
    ].filter(Boolean);
    if (bad.length) failedItems.push({ check: "impossible_values", severity: "failure", worker: "data_agent", detail: `FY${y.year}: ${bad.join(", ")}` });
  }

  // Outlier ratios, with the inputs shown.
  if (r.ratios) {
    const all = Object.values(r.ratios.categories).flatMap((c) => Object.entries(c));
    for (const [key, s] of all) {
      const last = s.series.at(-1);
      if (s.latest === null || !last) continue;
      const margin = /margin/i.test(key) && Math.abs(s.latest) > 1;
      const current = key === "currentRatio" && s.latest > 50;
      const pe = key === "pe" && s.latest > 1000;
      if (margin || current || pe) {
        warnings.push({ check: "outlier_ratio", severity: "warning", worker: "ratio_engine",
          detail: `${s.label} of ${s.unit === "percent" ? pct(s.latest) : s.latest.toFixed(2)} is outside the plausible range; inputs ${JSON.stringify(last.inputs)}` });
      }
    }
  }

  // Year gaps inside the series.
  for (let i = 1; i < annual.length; i++) {
    if (annual[i].year - annual[i - 1].year > 1) {
      warnings.push({ check: "year_gap", severity: "warning", worker: "data_agent",
        detail: `no complete fiscal year between FY${annual[i - 1].year} and FY${annual[i].year}; growth rates use the endpoints available` });
    }
  }

  // Cross-check: our P/E and market cap against the platform's independently computed metrics, within 5%.
  const pe = r.ratios ? Object.values(r.ratios.categories).map((c) => c.pe).find(Boolean)?.latest ?? null : null;
  if (pe !== null && r.raw.referencePe !== null && r.raw.referencePe > 0 && Math.abs(pe / r.raw.referencePe - 1) > 0.05) {
    warnings.push({ check: "cross_check", severity: "warning", worker: "ratio_engine",
      detail: `P/E of ${pe.toFixed(1)} from annual EPS differs from the trailing-twelve-month P/E of ${r.raw.referencePe.toFixed(1)} by more than 5% (earnings have moved since the last full year)` });
  }
  const price = r.raw.quote?.lastPrice ?? null;
  if (price !== null && r.raw.sharesOutstanding && r.raw.marketCap) {
    const implied = price * r.raw.sharesOutstanding;
    if (Math.abs(implied / r.raw.marketCap - 1) > 0.05) {
      warnings.push({ check: "cross_check", severity: "warning", worker: "data_agent",
        detail: `market cap on record differs from price × shares by ${pct(Math.abs(implied / r.raw.marketCap - 1))}` });
    }
  }

  // Stale data: latest annual filing older than 15 months.
  const latest = annual.at(-1);
  if (latest) {
    const months = (today.getTime() - new Date(`${latest.periodEnd}T00:00:00Z`).getTime()) / (30.44 * 86_400_000);
    if (months > 15) warnings.push({ check: "stale_data", severity: "warning", worker: "data_agent", detail: `the latest complete fiscal year on record is FY${latest.year}, ${Math.round(months)} months old` });
  }

  // Unsourced claims are dropped outright.
  if (r.qualitative) {
    for (const list of ["moatSignals", "managementSignals", "risks"] as const) {
      const before = r.qualitative[list].length;
      r.qualitative[list] = r.qualitative[list].filter((i) => Boolean(i.sourceUrl));
      const dropped = before - r.qualitative[list].length;
      if (dropped) warnings.push({ check: "unsourced_claim", severity: "warning", worker: "news_moat_agent", detail: `${dropped} ${list} item${dropped > 1 ? "s" : ""} without a source link removed` });
    }
  }

  // Ratios that are built from the same statements must agree with each other. Where they do not, one of the
  // inputs is wrong, and the reader is told which figures to treat carefully rather than being shown both.
  const find = (key: string) => {
    for (const ratios of Object.values(r.ratios?.categories ?? {})) if (ratios[key]) return ratios[key];
    return undefined;
  };
  const roe = find("roe")?.latest ?? null;
  const dupont = r.ratios?.qualityScores.dupont.at(-1);
  if (roe !== null && dupont?.netMargin != null && dupont.assetTurnover != null && dupont.equityMultiplier != null) {
    const product = dupont.netMargin * dupont.assetTurnover * dupont.equityMultiplier;
    if (Math.abs(product) > 1e-9 && Math.abs(product - roe) / Math.abs(product) > 0.1) {
      warnings.push({ check: "dupont_reconciliation", severity: "warning", worker: "ratio_engine",
        detail: `return on equity ${pct(roe)} does not match net margin x asset turnover x equity multiplier (${pct(product)}); one of the inputs is inconsistent, so treat the return figures as low confidence` });
      lowConfidence.push("roe");
    }
  }
  const pb = r.valuation?.relativeMultiples.pb ?? null;
  const marketCap = r.raw.marketCap ?? null;
  const netIncome = [...r.raw.annual].sort((a, b) => b.year - a.year)[0]?.netIncome ?? null;
  if (pb !== null && pb > 0 && marketCap !== null && roe !== null && roe !== 0 && netIncome !== null) {
    const equityFromPb = marketCap / pb;               // book equity the price-to-book implies
    const equityFromRoe = netIncome / roe;             // average equity the return on equity implies
    const gap = Math.abs(equityFromPb - equityFromRoe) / Math.max(Math.abs(equityFromPb), Math.abs(equityFromRoe));
    if (gap > 0.25) {
      warnings.push({ check: "equity_reconciliation", severity: "warning", worker: "ratio_engine",
        detail: `the equity behind price-to-book (${pb.toFixed(2)}x) and the equity behind return on equity differ by ${pct(gap)}; one filing uses a different equity base (minority interest or an average), so read the two together with care` });
      lowConfidence.push("pb");
    }
  }

  return { passed: failedItems.length === 0, warnings, failedItems, lowConfidence };
}

// --- number grounding (spec §8.1, last row) -------------------------------------------------

/** Numbers a reader would check in prose: amounts, percentages, multiples, decimals. Years and list counts are not claims. */
export function numbersIn(text: string): { raw: string; value: number; percent: boolean }[] {
  const out: { raw: string; value: number; percent: boolean }[] = [];
  for (const m of text.matchAll(/(₹\s?)?(-?\d[\d,]*(?:\.\d+)?)\s?(%|x\b|times\b|cr\b|crore\b|lakh\b)?/gi)) {
    const digits = m[2].replace(/,/g, "");
    const value = Number(digits);
    if (!Number.isFinite(value)) continue;
    const unit = (m[3] ?? "").toLowerCase();
    // A bare four-digit year, or a small integer like "3 of 6", is not a financial claim.
    if (!m[1] && !unit && /^(19|20)\d\d$/.test(digits)) continue;
    if (!m[1] && !unit && !digits.includes(".") && Math.abs(value) <= 12) continue;
    out.push({ raw: m[0].trim(), value, percent: unit === "%" });
  }
  return out;
}

/** Every number the reports contain, in the forms a writer might print it. */
export function numberPool(reports: unknown): number[] {
  const pool: number[] = [];
  const walk = (v: unknown) => {
    if (typeof v === "number" && Number.isFinite(v)) {
      pool.push(v, v * 100, v / 1e7, v / 1e5); // decimal, percent, crore, lakh
    } else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(reports);
  return pool;
}

/** A printed number is grounded when some report value rounds to it at the precision it was printed with. */
export function grounded(n: { raw: string; value: number }, pool: number[]): boolean {
  const decimals = (n.raw.match(/\.(\d+)/)?.[1].length ?? 0);
  const tolerance = Math.max(0.5 * 10 ** -decimals, Math.abs(n.value) * 0.005);
  const target = Math.abs(n.value);
  return pool.some((p) => Math.abs(Math.abs(p) - target) <= tolerance);
}

export function ungroundedNumbers(text: string, pool: number[]): string[] {
  return numbersIn(text).filter((n) => !grounded(n, pool)).map((n) => n.raw);
}

// --- directional claims ----------------------------------------------------------------------
//
// Grounding proves a number exists in a report; it cannot prove the sentence around it is right. "Operating margin
// 22.6% exceeds its median of 23.7%" uses two real numbers and says something false. Each sentence's subject (its
// first figure) is checked against every figure after a comparison word, when the units match.

const GREATER = /\b(above|exceeds?|exceeding|exceeded|outpaces?|outpacing|surpass(?:es|ing)?|higher than|greater than|better than|ahead of|more than)\b/gi;
const LESS = /\b(below|lower than|less than|under|trails?|trailing|lags?(?: behind)?|behind|short of|weaker than|worse than)\b/gi;

function figures(text: string): { value: number; unit: string; at: number }[] {
  const out: { value: number; unit: string; at: number }[] = [];
  for (const m of text.matchAll(/(₹|\$)?\s?(-?\d[\d,]*(?:\.\d+)?)\s?(%|x\b|times\b|cr\b|crore\b|days?\b|[mb]\b)?(?![\d‑-]*\s?(?:-|‑)?(?:year|yr|y\b|quarter))/gi)) {
    const digits = m[2].replace(/,/g, "");
    const unit = (m[3] ?? (m[1] ? "money" : "")).toLowerCase().replace(/^times$/, "x").replace(/^crore$/, "cr").replace(/^days?$/, "d");
    const value = Number(digits);
    if (!Number.isFinite(value)) continue;
    if (!unit && (/^(19|20)\d\d$/.test(digits) || (!digits.includes(".") && Math.abs(value) <= 12))) continue;
    out.push({ value, unit, at: m.index ?? 0 });
  }
  return out;
}

/** Sentences whose "above" or "below" contradicts their own figures. */
export function contradictions(text: string): string[] {
  const bad: string[] = [];
  // A full stop inside a number ("22.6%") does not end the sentence.
  for (const sentence of text.match(/(?:[^.!?;]|\.(?=\d))+(?:[.!?;]|$)/g) ?? []) {
    const nums = figures(sentence);
    if (nums.length < 2) continue;
    const subject = nums[0];
    const marks = [
      ...[...sentence.matchAll(GREATER)].map((m) => ({ at: m.index ?? 0, sign: 1 })),
      ...[...sentence.matchAll(LESS)].map((m) => ({ at: m.index ?? 0, sign: -1 })),
    ].sort((a, b) => a.at - b.at);
    const wrong = marks.some((mark, i) => {
      if (mark.at < subject.at) return false;
      // The comparison reaches the figures it governs: up to the next comparison word, or a phrase that starts a
      // new one ("and close to the median", "while", "but"). ", and ..." starts a clause about another measure,
      // so a price-to-earnings is never read against the price-to-book that follows it.
      const next = sentence.slice(mark.at + 1).search(/,\s*and\b|\b(close to|in line|near|similar|versus|vs\.?|compared|while|but|whereas|although|stable|flat|declin|improv|rising|falling|slightly)/i);
      const end = Math.min(marks[i + 1]?.at ?? sentence.length, next >= 0 ? mark.at + 1 + next : sentence.length);
      // The subject is the sentence's first figure or the one just before the comparison word; a claim is wrong only
      // if it is wrong for both, so "A's 35% against B's 15%, and 16% above B's 12%" is read correctly.
      const nearest = nums.filter((n) => n.at < mark.at).at(-1) ?? subject;
      const wrongFor = (s: { value: number; unit: string }) => nums.filter((n) => n.at > mark.at && n.at < end && n.unit === s.unit)
        .some((n) => (mark.sign > 0 ? !(s.value > n.value) : !(s.value < n.value)));
      return wrongFor(subject) && wrongFor(nearest);
    });
    if (wrong) bad.push(sentence.trim());
  }
  return bad;
}

// --- claims about two companies ---------------------------------------------------------------
//
// In a comparison the writer is given the answer: which company is stronger on each ratio, and whether each one
// meets the persona's margin of safety (synthesis.comparisonFacts). This checks the written sentences against
// those facts, so "Accenture's liquidity is higher" cannot survive when the current ratios say otherwise.

export interface ComparedFact {
  key: string; label: string; better: "higher" | "lower";
  values: { symbol: string; company: string; value: number; shown: string }[];
  leader: string | null;
  sentence: string;
}

/** The words a comparison is written with, and which side of the claim they put the first company on. */
const AHEAD = /\b(higher|greater|larger|stronger|better|ahead|superior|exceeds?|outpaces?|leads?|more)\b/i;
const BEHIND = /\b(lower|smaller|weaker|worse|behind|trails?|lags?|less|below)\b/i;

/** The first word of a company's name, which is how a sentence normally refers to it. */
const shortName = (company: string, symbol: string) => {
  const word = company.replace(/\b(the|limited|ltd|inc|plc|corporation|corp|company|co|technologies|industries)\b/gi, " ").trim().split(/\s+/)[0];
  return (word && word.length > 2 ? word : symbol).toLowerCase();
};

/** Every place a sentence refers to a company, by name or by ticker. */
function mentions(company: string, symbol: string, sentence: string): number[] {
  const at: number[] = [];
  for (const term of new Set([shortName(company, symbol), symbol.toLowerCase()])) {
    for (const m of sentence.toLowerCase().matchAll(new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g"))) at.push(m.index ?? 0);
  }
  return at.sort((a, b) => a - b);
}

/** Where a sentence first names a measure - by its label, or by the word a writer uses instead. */
const ALIASES: Record<string, RegExp> = {
  currentRatio: /\bliquidity\b/, quickRatio: /\bliquidity\b/, debtToEquity: /\b(leverage|gearing)\b/,
  netMargin: /\bprofitability\b/, pe: /\bearnings multiple\b/,
};

function measureAt(fact: ComparedFact, lower: string): number {
  const words = fact.label.toLowerCase().split(/\s+/).map((w) => w.replace(/[^a-z]/g, "")).filter((w) => w.length > 2);
  const positions = words.map((w) => lower.indexOf(w));
  if (words.length && positions.every((p) => p >= 0)) return Math.min(...positions);
  const alias = ALIASES[fact.key] ? lower.search(ALIASES[fact.key]) : -1;
  return alias;
}

/**
 * Sentences that say the opposite of what the figures show.
 *
 * Three things decide what a comparison word is about: the measure named nearest before it (a sentence often
 * carries two), the company named nearest before it (which is not always the first company in the sentence),
 * and whether the word is about the number ("higher") or about strength ("stronger") - on a lower-is-better
 * ratio such as price to book those are opposite claims. A word about strength is judged only when a company
 * sits right in front of it, because "…for Accenture, showing stronger returns" is about neither company in
 * particular.
 */
export function wrongComparisons(text: string, facts: ComparedFact[]): string[] {
  if (!facts.length) return [];
  const bad: string[] = [];
  const ranked = facts.filter((f) => f.values.length > 1 && f.leader);
  const mos = facts.filter((f) => f.key.startsWith("marginOfSafety:"));
  const STRENGTH = /^(stronger|better|weaker|worse|superior)$/;

  for (const sentence of text.match(/(?:[^.!?;]|\.(?=\d))+(?:[.!?;]|$)/g) ?? []) {
    const lower = sentence.toLowerCase();

    // "both clear the 25% margin of safety" when one of them does not.
    if (/margin of safety/i.test(sentence) && mos.length) {
      const claimsPass = /\b(meets?|clears?|exceeds?|above|satisfies|comfortably|passes)\b/i.test(sentence)
        && !/\bdoes not|\bnot meet|\bfalls short|\bbelow the required|\bshort of\b/i.test(sentence);
      const failing = mos.filter((f) => /does NOT meet/.test(f.sentence));
      const namesFailing = failing.some((f) => mentions(f.values[0].company, f.values[0].symbol, sentence).length > 0);
      if (claimsPass && failing.length && (/\bboth\b/i.test(sentence) || namesFailing)) {
        bad.push(sentence.trim());
        continue;
      }
    }

    // The measures this sentence talks about, with where each is named.
    const mentioned = ranked.map((fact) => ({ fact, at: measureAt(fact, lower) })).filter((m) => m.at >= 0);
    if (!mentioned.length) continue;

    const marks = [
      ...[...sentence.matchAll(new RegExp(AHEAD.source, "gi"))].map((m) => ({ at: m.index ?? 0, ahead: true, word: m[0].toLowerCase() })),
      ...[...sentence.matchAll(new RegExp(BEHIND.source, "gi"))].map((m) => ({ at: m.index ?? 0, ahead: false, word: m[0].toLowerCase() })),
    ].sort((a, b) => a.at - b.at);

    for (const mark of marks) {
      // The word is about the measure named just after it ("a higher net profit margin"), or failing that the
      // last measure named before it. When neither is close there is nothing to check: "TCS's superior returns
      // against Accenture's cash conversion" is not a claim about cash conversion.
      const following = mentioned.find((m) => m.at > mark.at && m.at - mark.at <= 25
        && !/[,;]|\b(and|but|while|whereas|although|versus|vs\.?|against|compared with)\b/i.test(sentence.slice(mark.at, m.at)));
      const about = following ?? [...mentioned]
        // A measure named in the other half of the sentence is not this word's subject: in "TCS has lower
        // leverage, whereas Accenture benefits from a lower price multiple", the second "lower" is not leverage.
        .filter((m) => m.at < mark.at && !/\b(whereas|while|but|although|however)\b|;/i.test(sentence.slice(m.at, mark.at)))
        .sort((a, b) => a.at - b.at).at(-1);
      if (!about) continue;
      const fact = about.fact;
      const where = fact.values.map((v) => ({ v, at: mentions(v.company, v.symbol, sentence) })).filter((x) => x.at.length > 0);
      if (where.length < 2) continue;                    // only one company named: nothing to compare with

      const aboutStrength = STRENGTH.test(mark.word);
      // "<company> is stronger": the company must sit just before the word, with no comma between them.
      const adjacent = where
        .map(({ v, at }) => ({ v, at: Math.max(...at.filter((i) => i < mark.at), -1) }))
        .filter((x) => x.at >= 0 && !/[,;]/.test(sentence.slice(x.at, mark.at)) && mark.at - x.at <= 40);
      // A company named in an earlier clause is not the subject: in "…versus TCS's -28.3% and a higher free
      // cash flow yield", the "higher" belongs to the company the sentence opened with, not to TCS.
      const sameClause = where
        .map(({ v, at }) => ({ v, at: Math.max(...at.filter((i) => i < mark.at), -1) }))
        .filter((x) => x.at >= 0 && !/[,;]|\b(and|but|while|whereas|although|versus|vs\.?|compared with)\b/i.test(sentence.slice(x.at, mark.at)))
        .sort((a, b) => b.at - a.at)[0];
      const opener = where.map(({ v, at }) => ({ v, at: at[0] })).sort((a, b) => a.at - b.at)[0];
      const subject = aboutStrength
        ? adjacent.sort((a, b) => b.at - a.at)[0]?.v
        : (sameClause?.v ?? opener?.v);
      if (!subject) continue;
      const other = fact.values.find((v) => v.symbol !== subject.symbol);
      if (!other) continue;

      const truth = aboutStrength ? subject.symbol === fact.leader : subject.value > other.value;
      if (mark.ahead !== truth) {
        bad.push(sentence.trim());
        break;
      }
    }
  }
  return [...new Set(bad)];
}
