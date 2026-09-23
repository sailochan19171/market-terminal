// The US provider (spec §5.0, §5.1): SEC EDGAR for statements, profile and filings; Nasdaq for daily prices.
//
// EDGAR's company facts are the audited XBRL figures from every 10-K and 10-Q. Each fact carries the filing it
// came from, and a later filing restates earlier periods (a stock split, a reclassification), so for every period
// the most recently filed value is used (spec §5.4: ratios use restated values) and the first-filed one is kept as
// as-reported. Tags are mapped to the internal schema through config/field_mapping/us_gaap.yaml.
import type { Db } from "../../db";
import { logger } from "../../log";
import { cached, TTL, withRetry } from "../cache";
import { fieldMapping } from "../config";
import type { AnnualFigures, MarketQuote, QuarterFigures, RawData, SectorSet, Unavailable } from "../state";

const log = logger("provider-us");
const DAY = 86_400_000;

/** SEC asks every client to identify itself with a contact address (sec.gov/os/accessing-edgar-data). */
const SEC_UA = process.env.SEC_USER_AGENT || "MarketTerminal research-tool admin@market-terminal-sai.netlify.app";

async function json<T>(url: string, headers: Record<string, string>, timeoutMs = 15_000): Promise<T> {
  return withRetry(url.replace(/\?.*/, ""), async () => {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as T;
  });
}
const sec = <T>(url: string) => json<T>(url, { "User-Agent": SEC_UA, Accept: "application/json" });

// --- listings --------------------------------------------------------------------------------

export interface UsListing { cik: number; ticker: string; title: string; rank: number }
let listings: { at: number; rows: UsListing[] } | null = null;

/** Tests replace the SEC listing with a saved one, so a graph test needs no network (spec §10.1). */
export function setListingsForTests(rows: UsListing[]) {
  listings = { at: Date.now(), rows };
}

/** Every SEC registrant with a ticker, roughly in order of size. Held in memory for a day. */
export async function usListings(): Promise<UsListing[]> {
  if (listings && Date.now() - listings.at < DAY) return listings.rows;
  const raw = await sec<Record<string, { cik_str: number; ticker: string; title: string }>>("https://www.sec.gov/files/company_tickers.json");
  const rows = Object.values(raw).map((r, i) => ({ cik: r.cik_str, ticker: r.ticker.toUpperCase(), title: r.title, rank: i }));
  listings = { at: Date.now(), rows };
  return rows;
}

const SUFFIX = /\b(inc|incorporated|corp|corporation|co|company|ltd|limited|plc|holdings?|group|n\.?v|s\.?a|ag|se|lp|llc|the|class [a-c]|\/[a-z]+\/)\b\.?/gi;
export const plainName = (title: string) => title.toLowerCase().replace(/[.,&'/-]/g, " ").replace(SUFFIX, " ").replace(/\s+/g, " ").trim();

// --- company facts -----------------------------------------------------------------------------

interface Fact { start?: string; end: string; val: number; fy?: number; fp?: string; form: string; filed: string; accn: string }
interface CompanyFacts { entityName: string; facts: Record<string, Record<string, { units: Record<string, Fact[]> }>> }

const ANNUAL_FORMS = /^(10-K|10-K\/A|20-F|20-F\/A|40-F|40-F\/A)$/;
const QUARTER_FORMS = /^(10-Q|10-Q\/A|6-K)$/;
const days = (f: Fact) => (f.start ? (new Date(f.end).getTime() - new Date(f.start).getTime()) / DAY : 0);

/** All values of one concept in one unit family (USD, USD/shares, shares), across taxonomies. */
function factsFor(cf: CompanyFacts, concept: string): { unit: string; facts: Fact[] } | null {
  const [taxonomy, name] = concept.split(":");
  const units = cf.facts[taxonomy]?.[name]?.units;
  if (!units) return null;
  // Some filers tag the same concept in two units (EPS in both "pure" and "USD/shares"); use the one with the data.
  const unit = Object.keys(units).sort((a, b) => (a === "pure" ? 1 : 0) - (b === "pure" ? 1 : 0) || units[b].length - units[a].length)[0];
  return { unit, facts: units[unit] };
}

/** Latest-filed and first-filed value per period end, for facts that pass `keep`. */
function byPeriod(facts: Fact[], keep: (f: Fact) => boolean): Map<string, { latest: Fact; first: Fact }> {
  const out = new Map<string, { latest: Fact; first: Fact }>();
  for (const f of facts) {
    if (!keep(f)) continue;
    const key = f.start ? `${f.start}|${f.end}` : f.end;
    const cur = out.get(key);
    if (!cur) out.set(key, { latest: f, first: f });
    else {
      if (f.filed > cur.latest.filed) cur.latest = f;
      if (f.filed < cur.first.filed) cur.first = f;
    }
  }
  return out;
}

interface Normalised {
  company: string;
  currency: "USD" | string;
  annual: AnnualFigures[];
  quarterly: QuarterFigures[];
  ttm: AnnualFigures | null;
  sharesOutstanding: number | null;
  unavailable: Unavailable[];
}

function normalise(cf: CompanyFacts, cik: number, financial: boolean, years: number): Normalised {
  const map = fieldMapping("us_gaap") as { duration: Record<string, string[]>; instant: Record<string, string[]>; shares_outstanding: string[] };
  const unavailable: Unavailable[] = [];
  let currency = "USD";

  // Fiscal years are defined by the annual income statement periods on record.
  const annualDuration = (f: Fact) => ANNUAL_FORMS.test(f.form) && days(f) > 340 && days(f) < 380;
  const ends = new Set<string>();
  for (const concept of [...map.duration.revenue, ...map.duration.net_income]) {
    const got = factsFor(cf, concept);
    if (!got) continue;
    if (!got.unit.startsWith("USD")) currency = got.unit;
    for (const f of got.facts) if (annualDuration(f)) ends.add(f.end);
  }
  const yearEnds = [...ends].sort().reverse()
    // Two period ends within a month are the same fiscal year reported on a 52/53-week calendar.
    .filter((e, i, all) => i === 0 || new Date(all[i - 1]).getTime() - new Date(e).getTime() > 300 * DAY)
    .slice(0, years);

  /** A duration field for the period ending `end` (±7 days, for 52/53-week years), first mapped concept wins. */
  const duration = (field: string, end: string, keep: (f: Fact) => boolean, pickFirst = false): number | null => {
    for (const concept of map.duration[field] ?? []) {
      const got = factsFor(cf, concept);
      if (!got) continue;
      const periods = byPeriod(got.facts, keep);
      for (const { latest, first } of periods.values()) {
        if (Math.abs(new Date(latest.end).getTime() - new Date(end).getTime()) <= 7 * DAY) return (pickFirst ? first : latest).val;
      }
    }
    return null;
  };
  const instant = (field: string, end: string): number | null => {
    for (const concept of map.instant[field] ?? []) {
      const got = factsFor(cf, concept);
      if (!got) continue;
      const periods = byPeriod(got.facts, (f) => !f.start && (ANNUAL_FORMS.test(f.form) || QUARTER_FORMS.test(f.form)));
      for (const { latest } of periods.values()) {
        if (Math.abs(new Date(latest.end).getTime() - new Date(end).getTime()) <= 7 * DAY) return latest.val;
      }
    }
    return null;
  };
  const accession = (field: string, end: string): string | null => {
    for (const concept of map.duration[field] ?? []) {
      const got = factsFor(cf, concept);
      const f = got?.facts.filter((x) => annualDuration(x) && Math.abs(new Date(x.end).getTime() - new Date(end).getTime()) <= 7 * DAY).sort((a, b) => b.filed.localeCompare(a.filed))[0];
      if (f) return `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${cik}&type=${encodeURIComponent(f.form)}&dateb=&owner=include&count=40#${f.accn}`;
    }
    return null;
  };

  const build = (label: number, end: string, get: (field: string) => number | null, getFirst: (field: string) => number | null, url: string | null): AnnualFigures => {
    const revenue = get("revenue");
    const cogs = get("cost_of_goods_sold");
    const pretax = get("pretax_income");
    const interest = get("interest_expense");
    const operating = get("operating_income");
    const ebit = financial ? pretax : pretax !== null && interest !== null ? pretax + interest : operating;
    const dep = get("depreciation");
    const debtParts = [instant("long_term_debt_noncurrent", end), instant("long_term_debt_current", end), instant("short_term_borrowings", end)];
    const totalDebt = debtParts.some((v) => v !== null) ? debtParts.reduce<number>((s, v) => s + (v ?? 0), 0) : instant("long_term_debt_total", end);
    const cash = instant("cash", end);
    const sti = instant("short_term_investments", end);
    const loans = instant("loans", end);
    const eps = get("eps_diluted");
    const firstEps = getFirst("eps_diluted");
    const shares = get("shares_diluted");
    return {
      year: label,
      periodEnd: end,
      consolidated: true,
      revenue: financial && revenue === null ? get("net_interest_income") : revenue,
      costOfGoodsSold: cogs,
      grossProfit: get("gross_profit") ?? (revenue !== null && cogs !== null ? revenue - cogs : null),
      operatingIncome: operating ?? ebit,
      ebit,
      ebitda: ebit === null ? null : ebit + (dep ?? 0),
      interestExpense: interest,
      taxExpense: get("tax_expense"),
      netIncome: get("net_income"),
      epsDiluted: eps,
      sharesDiluted: shares,
      depreciation: dep,
      cash: cash === null && sti === null ? null : (cash ?? 0) + (sti ?? 0),
      receivables: instant("receivables", end),
      inventory: instant("inventory", end),
      currentAssets: instant("current_assets", end),
      totalAssets: instant("total_assets", end),
      payables: instant("payables", end),
      currentLiabilities: instant("current_liabilities", end),
      totalDebt,
      totalLiabilities: instant("total_liabilities", end),
      shareholdersEquity: instant("shareholders_equity", end),
      operatingCashFlow: get("operating_cash_flow"),
      capitalExpenditure: get("capital_expenditure"),
      dividendsPaid: get("dividends_paid"),
      shareBuybacks: get("share_buybacks"),
      netInterestIncome: financial ? get("net_interest_income") : null,
      interestEarningAssets: financial && loans !== null ? loans + (instant("securities_available_for_sale", end) ?? 0) + (instant("securities_held_to_maturity", end) ?? 0) : null,
      advances: financial ? loans : null,
      deposits: financial ? instant("deposits", end) : null,
      otherIncome: financial ? get("other_income") : null,
      operatingExpenses: financial ? get("operating_expenses") : null,
      sources: { income: url, balance: url, cashFlow: url },
      asReported: firstEps !== null && eps !== null && Math.abs(firstEps - eps) > 1e-9 ? { epsDiluted: firstEps, sharesDiluted: null } : null,
    };
  };

  const annual = yearEnds.map((end) => build(
    Number(end.slice(0, 4)), end,
    (f) => duration(f, end, annualDuration),
    (f) => duration(f, end, annualDuration, true),
    accession("net_income", end) ?? accession("revenue", end),
  ));

  // Quarters: 10-Q periods of about three months, newest first (spec §3.3: 8 quarters).
  const quarterDuration = (f: Fact) => QUARTER_FORMS.test(f.form) && days(f) > 80 && days(f) < 100;
  const qEnds = new Set<string>();
  for (const concept of [...map.duration.revenue, ...map.duration.net_income]) for (const f of factsFor(cf, concept)?.facts ?? []) if (quarterDuration(f)) qEnds.add(f.end);
  const quarterly: QuarterFigures[] = [...qEnds].sort().reverse().slice(0, 8).map((end) => ({
    periodEnd: end,
    revenue: duration("revenue", end, quarterDuration),
    netIncome: duration("net_income", end, quarterDuration),
    epsDiluted: duration("eps_diluted", end, quarterDuration),
    operatingIncome: duration("operating_income", end, quarterDuration),
    source: "SEC EDGAR 10-Q",
  }));

  // Trailing twelve months: last fiscal year + this year's year-to-date − the same stretch a year earlier.
  let ttm: AnnualFigures | null = null;
  const lastEnd = yearEnds[0];
  if (lastEnd) {
    let ytdEnd: string | null = null;
    for (const concept of map.duration.revenue.concat(map.duration.net_income)) {
      for (const f of factsFor(cf, concept)?.facts ?? []) {
        if (QUARTER_FORMS.test(f.form) && f.start && f.end > lastEnd && new Date(f.start).getTime() - new Date(lastEnd).getTime() < 10 * DAY && (!ytdEnd || f.end > ytdEnd)) ytdEnd = f.end;
      }
    }
    if (ytdEnd) {
      const span = (new Date(ytdEnd).getTime() - new Date(lastEnd).getTime()) / DAY;
      const priorEnd = new Date(new Date(ytdEnd).getTime() - 364 * DAY).toISOString().slice(0, 10);
      const ytd = (field: string, at: string) => duration(field, at, (f) => QUARTER_FORMS.test(f.form) && Math.abs(days(f) - span) < 12);
      const annualOf = (field: string) => duration(field, lastEnd, annualDuration);
      const roll = (field: string) => {
        const a = annualOf(field), now = ytd(field, ytdEnd!), then = ytd(field, priorEnd);
        return a === null || now === null || then === null ? null : a + now - then;
      };
      const full = build(Number(ytdEnd.slice(0, 4)), ytdEnd, (f) => (["shares_diluted"].includes(f) ? ytd(f, ytdEnd!) : roll(f)), () => null, "SEC EDGAR 10-Q year to date");
      ttm = { ...full, asReported: null };
    }
  }

  let sharesOutstanding: number | null = null;
  for (const concept of map.shares_outstanding) {
    const got = factsFor(cf, concept);
    const latest = got?.facts.slice().sort((a, b) => b.end.localeCompare(a.end))[0];
    if (latest) { sharesOutstanding = latest.val; break; }
  }
  if (!annual.length) unavailable.push({ key: "annual_statements", reason: "no annual XBRL financial statements on SEC EDGAR for this registrant" });
  if (annual.length && annual.length < years) unavailable.push({ key: "history_depth", reason: `${annual.length} fiscal years in EDGAR's XBRL records, fewer than the ${years} asked for` });
  return { company: cf.entityName, currency, annual, quarterly, ttm, sharesOutstanding, unavailable };
}

// --- profile, filings, prices --------------------------------------------------------------------

interface Submissions {
  name: string; sic: string; sicDescription: string; fiscalYearEnd: string; exchanges: string[]; tickers: string[];
  filings: { recent: { form: string[]; filingDate: string[]; accessionNumber: string[]; primaryDocument: string[]; items: string[]; primaryDocDescription: string[] } };
}

// 8-K item numbers, in words the news agent's classifiers read.
const ITEMS: Record<string, string> = {
  "1.01": "Entry into a material agreement", "1.02": "Termination of a material agreement", "1.03": "Bankruptcy or receivership",
  "2.01": "Completion of acquisition or disposition of assets", "2.02": "Results of operations and financial condition",
  "2.03": "Creation of a direct financial obligation", "2.04": "Triggering events that accelerate an obligation",
  "2.05": "Exit or disposal costs", "2.06": "Material impairments", "3.01": "Notice of delisting or failure to meet listing standards",
  "3.02": "Unregistered sales of equity securities", "4.01": "Change in the company's certifying accountant (auditor change)",
  "4.02": "Non-reliance on previously issued financial statements", "5.01": "Change in control",
  "5.02": "Departure or appointment of directors or certain officers", "5.03": "Amendments to articles or bylaws",
  "5.07": "Submission of matters to a vote of security holders", "7.01": "Regulation FD disclosure", "8.01": "Other events", "9.01": "Financial statements and exhibits",
};

function filingsFrom(s: Submissions, cik: number): RawData["filings"] {
  const r = s.filings.recent;
  const since = new Date(Date.now() - 90 * DAY).toISOString().slice(0, 10);
  const out: RawData["filings"] = [];
  for (let i = 0; i < r.form.length; i++) {
    if (r.filingDate[i] < since) break;
    if (!/^(8-K|10-K|10-Q|20-F|6-K|DEF 14A|SC 13D|SC 13G)/.test(r.form[i])) continue;
    const items = (r.items[i] ?? "").split(",").map((x) => x.trim()).filter((x) => x && x !== "9.01");
    const described = items.map((x) => ITEMS[x] ?? `Item ${x}`).join("; ");
    out.push({
      when: r.filingDate[i],
      title: `${r.form[i]}${described ? `: ${described}` : r.primaryDocDescription[i] ? `: ${r.primaryDocDescription[i]}` : ""}`,
      detail: null,
      url: `https://www.sec.gov/Archives/edgar/data/${cik}/${r.accessionNumber[i].replace(/-/g, "")}/${r.primaryDocument[i]}`,
      source: "SEC EDGAR filing",
    });
  }
  return out;
}

interface NasdaqHistory { data: { tradesTable: { rows: { date: string; close: string }[] } | null } | null }

async function nasdaqPrices(ticker: string, years: number): Promise<{ t: string; c: number }[]> {
  const to = new Date().toISOString().slice(0, 10);
  // The feed occasionally answers "something went wrong" for a particular start date; a start a few days later works.
  // SEC writes share classes with a hyphen (BRK-B), Nasdaq with a slash-free dot (BRK.B).
  const symbols = [...new Set([ticker, ticker.replace(/-/g, ".")])];
  for (const [assetclass, shift, sym] of symbols.flatMap((t) => [["stocks", 0, t], ["stocks", 3, t], ["etf", 3, t]] as const)) {
    const from = new Date(Date.now() - years * 365 * DAY + shift * DAY).toISOString().slice(0, 10);
    const data = await json<NasdaqHistory>(
      `https://api.nasdaq.com/api/quote/${encodeURIComponent(sym)}/historical?assetclass=${assetclass}&fromdate=${from}&todate=${to}&limit=9999`,
      { "User-Agent": "Mozilla/5.0 (research tool)", Accept: "application/json" }, 20_000);
    const rows = data.data?.tradesTable?.rows ?? [];
    if (!rows.length) continue;
    return rows.map((r) => {
      const [m, d, y] = r.date.split("/");
      return { t: `${y}-${m}-${d}`, c: Number(r.close.replace(/[$,]/g, "")) };
    }).filter((r) => r.c > 0).reverse();
  }
  return [];
}

const FINANCIAL_SIC = (sic: number) => (sic >= 6000 && sic <= 6199) || (sic >= 6300 && sic <= 6411);

// --- US peers (spec §4.5: sector median and percentile, minimum 5 peers; §5.0: US peers only) ------------

interface Frame { data: { cik: number; val: number; end: string }[] }
const frames = new Map<string, { at: number; byCik: Map<number, number> }>();

/** One XBRL concept for every filer in one calendar period, from SEC's frames API; held in memory for a week. */
async function frame(concept: string, period: string): Promise<Map<number, number>> {
  const key = `${concept}/${period}`;
  const hit = frames.get(key);
  if (hit && Date.now() - hit.at < 7 * DAY) return hit.byCik;
  let byCik = new Map<number, number>();
  try {
    const got = await sec<Frame>(`https://data.sec.gov/api/xbrl/frames/us-gaap/${concept}/USD/${period}.json`);
    byCik = new Map(got.data.map((d) => [d.cik, d.val]));
  } catch { /* a concept nobody filed for that period */ }
  frames.set(key, { at: Date.now(), byCik });
  return byCik;
}

/** Registrants that share an SIC industry code and still have a listed ticker. */
async function peersBySic(sic: string, self: number): Promise<UsListing[]> {
  const listed = new Map((await usListings()).map((l) => [l.cik, l]));
  const ciks = new Set<number>();
  for (let start = 0; start < 160; start += 40) {
    const res = await fetch(`https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&SIC=${encodeURIComponent(sic)}&type=10-K&dateb=&owner=include&count=40&start=${start}&output=atom`,
      { headers: { "User-Agent": SEC_UA }, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) break;
    const text = await res.text();
    const found = [...text.matchAll(/<cik>(\d+)<\/cik>/g)].map((m) => Number(m[1]));
    found.forEach((c) => ciks.add(c));
    if (found.length < 40) break;
  }
  return [...ciks].filter((c) => c !== self && listed.has(c)).map((c) => listed.get(c)!)
    // One listing per company (share classes), largest first.
    .filter((l, i, all) => all.findIndex((x) => x.cik === l.cik) === i)
    .sort((a, b) => a.rank - b.rank).slice(0, 60);
}

export interface UsPeers { count: number; basis: string; values: Record<string, number[]>; tickers: string[] }

/**
 * Sector values for the ratios SEC frames can support without a price per peer: net margin, return on equity and
 * debt to equity, for the latest calendar year most peers have filed. Year-end equity is used for ROE here (the
 * frames carry one balance per year), which the basis line says.
 */
async function usPeers(db: Db, sic: string, self: number): Promise<UsPeers> {
  const got = await cached(db, `us:peers:${sic}`, TTL.profile, "SEC EDGAR SIC listing and XBRL frames", async () => {
    const peers = await peersBySic(sic, self);
    const year = new Date().getUTCFullYear() - 1;
    for (const y of [year, year - 1]) {
      const [ni, rev, rev2, eq, ltd] = await Promise.all([
        frame("NetIncomeLoss", `CY${y}`), frame("RevenueFromContractWithCustomerExcludingAssessedTax", `CY${y}`), frame("Revenues", `CY${y}`),
        frame("StockholdersEquity", `CY${y}Q4I`), frame("LongTermDebtNoncurrent", `CY${y}Q4I`),
      ]);
      const values: Record<string, number[]> = { netMargin: [], roe: [], debtToEquity: [] };
      const used: string[] = [];
      for (const p of peers) {
        const n = ni.get(p.cik), r = rev.get(p.cik) ?? rev2.get(p.cik), e = eq.get(p.cik), d = ltd.get(p.cik);
        if (n !== undefined && r) values.netMargin.push(n / r);
        if (n !== undefined && e && e > 0) values.roe.push(n / e);
        if (d !== undefined && e && e > 0) values.debtToEquity.push(d / e);
        if (n !== undefined) used.push(p.ticker);
      }
      if (used.length >= 5) return { count: used.length, basis: `${used.length} US peers in SIC ${sic}, calendar ${y} (ROE on year-end equity; debt is long-term debt)`, values, tickers: used.slice(0, 30) };
    }
    return { count: 0, basis: `fewer than 5 US peers with ${sic} filings in the SEC frames`, values: {}, tickers: [] };
  });
  return got.value;
}

/** Everything one request needs about one US company (spec §3.3), from cache when fresh. */
export async function loadUs(db: Db, ticker: string, years = 10): Promise<RawData> {
  const t = ticker.toUpperCase().replace(/\.US$/, "");
  const listing = (await usListings()).find((l) => l.ticker === t);
  if (!listing) throw new Error(`${t} is not an SEC-registered ticker`);
  const pad = String(listing.cik).padStart(10, "0");
  const unavailable: Unavailable[] = [];

  const profile = await cached(db, `us:profile:${pad}`, TTL.news, "SEC EDGAR submissions", () => sec<Submissions>(`https://data.sec.gov/submissions/CIK${pad}.json`));
  const sic = Number(profile.value.sic) || 0;
  const sectorSet: SectorSet = FINANCIAL_SIC(sic) ? "financial" : "standard";
  const facts = await cached(db, `us:facts:${pad}:${years}`, TTL.statements, "SEC EDGAR company facts (XBRL)", async () =>
    normalise(await sec<CompanyFacts>(`https://data.sec.gov/api/xbrl/companyfacts/CIK${pad}.json`), listing.cik, sectorSet === "financial", years));

  let prices: { t: string; c: number }[] = [];
  let priceSource = "Nasdaq end-of-day";
  let pricesFetched = new Date().toISOString();
  try {
    const got = await cached(db, `us:prices:${t}`, TTL.prices, "Nasdaq end-of-day", () => nasdaqPrices(t, years));
    prices = got.value;
    priceSource = got.source;
    pricesFetched = got.fetchedAt;
  } catch (e) {
    log.warn(`${t}: prices unavailable - ${(e as Error).message}`);
  }
  if (!prices.length) unavailable.push({ key: "prices", reason: "no daily prices could be fetched for this ticker" });

  const last = prices.at(-1) ?? null;
  const prev = prices.at(-2) ?? null;
  const quote: MarketQuote | null = last ? {
    lastPrice: last.c, changeAbs: prev ? last.c - prev.c : null, changePct: prev ? (last.c / prev.c - 1) * 100 : null,
    asOfTimestamp: `${last.t}T16:00:00-04:00`, session: last.t, source: priceSource, isLive: false, currency: "USD",
  } : null;

  const n = facts.value;
  const latest = n.annual[0];
  const shares = n.sharesOutstanding ?? latest?.sharesDiluted ?? null;
  const yearEndPrices: Record<number, number> = {};
  for (const a of n.annual) {
    const onOrBefore = prices.filter((p) => p.t <= a.periodEnd).at(-1);
    if (onOrBefore && new Date(a.periodEnd).getTime() - new Date(onOrBefore.t).getTime() < 10 * DAY) yearEndPrices[a.year] = onOrBefore.c;
  }
  const filings = filingsFrom(profile.value, listing.cik);
  if (!filings.length) unavailable.push({ key: "news", reason: "no SEC filings in the last 90 days" });
  let peers: UsPeers = { count: 0, basis: "", values: {}, tickers: [] };
  try {
    peers = await usPeers(db, profile.value.sic, listing.cik);
  } catch (e) {
    log.warn(`${t}: peers unavailable - ${(e as Error).message}`);
  }
  if (peers.count < 5) unavailable.push({ key: "sector_peers", reason: `sector medians need at least 5 US peers (spec §4.5); ${peers.basis || "the peer lookup failed"}` });
  unavailable.push({ key: "sector_valuation_multiples", reason: "US sector P/E and P/B medians need a price for every peer, which is not fetched; the company's own history is used instead" });
  if (sectorSet === "financial") {
    for (const key of ["net_charge_offs", "non_performing_loans", "cet1_ratio"]) unavailable.push({ key, reason: "regulatory bank metrics are not in the XBRL financial statements" });
  }
  const fye = profile.value.fiscalYearEnd;

  return {
    symbol: t,
    company: profile.value.name || n.company,
    market: "US",
    currency: n.currency === "USD" ? "USD" : (n.currency as "USD"),
    exchange: profile.value.exchanges?.[0]?.toUpperCase() || "US",
    ticker: t,
    fiscalYearEnd: fye ? `${fye.slice(0, 2)}-${fye.slice(2)}` : null,
    industry: profile.value.sicDescription || null,
    sectorSet,
    quote,
    marketCap: quote?.lastPrice != null && shares ? quote.lastPrice * shares : null,
    sharesOutstanding: shares,
    referencePe: null,
    bookValuePerShare: latest?.shareholdersEquity != null && shares ? latest.shareholdersEquity / shares : null,
    dividendPerShare: latest?.dividendsPaid != null && shares ? Math.abs(latest.dividendsPaid) / shares : null,
    annual: n.annual,
    quarterly: n.quarterly,
    ttm: n.ttm,
    prices,
    yearEndPrices,
    peerMultiples: { count: peers.count, pe: null, pb: null },
    peerValues: peers.count >= 5 ? { basis: peers.basis, values: peers.values } : undefined,
    filings,
    peers: peers.tickers,
    fetchedAt: new Date().toISOString(),
    sources: [
      { dataset: "statements", source: facts.source + (facts.fromCache ? " (cached)" : ""), fetchedAt: facts.fetchedAt },
      { dataset: "profile_and_filings", source: profile.source + (profile.fromCache ? " (cached)" : ""), fetchedAt: profile.fetchedAt },
      { dataset: "prices", source: priceSource, fetchedAt: pricesFetched },
      { dataset: "peers", source: peers.basis || "no US peers", fetchedAt: new Date().toISOString() },
    ],
    unavailable: [...n.unavailable, ...unavailable],
  };
}
