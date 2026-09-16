// "Why is this stock moving?" - the day's move, and what in the public record could account for it.
//
// The discipline here matters more than the cleverness. The engine only ever points at something it retrieved:
// an exchange filing, a result, a corporate action, an insider disclosure, or the sector's own move. When it
// finds nothing material it says so - "no company-specific news; the move tracks the sector" - because a
// confidently wrong cause is worse than an honest blank. Nothing is generated: every line below is assembled
// from rows, so a reader can open the filing behind each one.
import type { Db, Row } from "../db";
import { eodQuote, type PriceQuote } from "../core/price";
import { pickExchange, resolve, type Exchange, type Identity } from "../core/analysis";
import { INDEX_NAMES } from "../api/v2";
import { addDays } from "../util";

export type Confidence = "High" | "Medium" | "Low";
export type Direction = "up" | "down" | "flat";

export interface Catalyst {
  kind: "filing" | "result" | "action" | "insider" | "board" | "shareholding" | "sector";
  title: string;
  detail: string | null;
  when: string;              // ISO timestamp, IST
  source: string;            // "BSE filing", "NSE announcement", "Nifty IT"
  url: string | null;
  confidence: Confidence;
  expected: Direction;       // the direction this kind of event usually pushes a price
  agrees: boolean | null;    // does that match the move? null when the event has no obvious sign
  score: number;
}

export interface MoveContext {
  session: string | null;
  changePct: number | null;
  benchmark: { slug: string | null; name: string; changePct: number | null; isSector: boolean } | null;
  market: { name: string; changePct: number | null } | null;
  beta: number | null;
  abnormalPct: number | null;
  volume: number | null;
  averageVolume20d: number | null;
  volumeRatio: number | null;
  volatility30d: number | null;
  threshold: number | null;
  material: boolean;
  direction: Direction;
}

export interface MoveExplanation {
  symbol: string;
  company: string | null;
  quote: PriceQuote;
  move: MoveContext;
  headline: string;
  summary: string;
  catalysts: Catalyst[];
  noCatalyst: boolean;
  searched: string[];
  notCovered: string[];
  generatedAt: string;
}

const BROAD = /^(nifty50|niftynext50|nifty100|nifty200|nifty500|niftymidcap|niftysmallcap|niftymicrocap|niftytotalmarket|niftygrowsect)/;

// How much each kind of disclosure usually matters to a price, and which way it usually points. These weights
// only order the candidates; they never invent one.
const MATERIAL: { re: RegExp; weight: number; expected: Direction; label: string }[] = [
  // Routine compliance paperwork is matched first: it is most of the feed and it explains nothing.
  { re: /\b(trading window|newspaper publication|investor presentation|analysts?\s*[/·]|analyst meet|institutional investor|conference call|transcript|compliance certificate|shareholders meeting|postal ballot|loss of (share )?certificate|duplicate share|esg rating)/i, weight: 1, expected: "flat", label: "routine" },
  { re: /\b(result|financial results|earnings|quarterly)\b/i, weight: 10, expected: "flat", label: "results" },
  { re: /\b(order|contract|win|bagged|letter of award|loa)\b/i, weight: 9, expected: "up", label: "order win" },
  { re: /\b(acqui|merger|amalgamat|takeover|stake (purchase|sale)|divest)/i, weight: 9, expected: "flat", label: "deal" },
  { re: /\b(fund ?rais|qip|preferential|rights issue|debenture|ncd|bonus|split|buy-?back)\b/i, weight: 8, expected: "flat", label: "capital" },
  { re: /\b(dividend)\b/i, weight: 6, expected: "up", label: "dividend" },
  { re: /\b(pledg|encumbr)/i, weight: 9, expected: "down", label: "pledge" },
  { re: /\b(resign|cessation|auditor|fraud|default|insolvenc|nclt|ibc|penalt|show cause|search|raid|investigat)/i, weight: 9, expected: "down", label: "governance" },
  { re: /\b(credit rating|upgrade|downgrade|outlook)\b/i, weight: 7, expected: "flat", label: "rating" },
  { re: /\b(guidance|outlook|expansion|capacity|plant|capex|agreement|partnership|tie-?up|approval|licence|license|patent)\b/i, weight: 6, expected: "up", label: "business" },
  { re: /\b(board meeting|intimation)\b/i, weight: 4, expected: "flat", label: "board" },
  { re: /\b(agm|egm|general updates?|updates?)\b/i, weight: 2, expected: "flat", label: "routine" },
];

const materiality = (text: string) => {
  for (const m of MATERIAL) if (m.re.test(text)) return m;
  return { re: /./, weight: 3, expected: "flat" as Direction, label: "disclosure" };
};

const r2 = (v: number | null, d = 2) => (v === null || !Number.isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d);
const dir = (pct: number | null, threshold: number): Direction => (pct === null ? "flat" : pct >= threshold ? "up" : pct <= -threshold ? "down" : "flat");

/** Daily closes for the last `days` sessions, oldest first. */
function closes(db: Db, identity: Identity, exchange: Exchange, from: string, to: string): { t: string; c: number; v: number | null }[] {
  if (exchange === "NSE") {
    if (!identity.symbol) return [];
    return db.all("SELECT trade_date t, close c, volume v FROM nse_bhavcopy WHERE symbol = ? AND series IN ('EQ','BE','BZ','SM','ST') AND trade_date BETWEEN ? AND ? AND close IS NOT NULL ORDER BY trade_date", [identity.symbol, from, to]);
  }
  if (!identity.bseCode) return [];
  return db.all("SELECT trade_date t, close c, volume v FROM bhavcopy WHERE scrip_cd = ? AND trade_date BETWEEN ? AND ? AND close IS NOT NULL ORDER BY trade_date", [identity.bseCode, from, to]);
}

const indexCloses = (db: Db, name: string, from: string, to: string) =>
  db.all<{ t: string; c: number; pct: number | null }>(
    "SELECT trade_date t, close c, pct_change pct FROM nse_index_history WHERE index_name = ? AND trade_date BETWEEN ? AND ? AND close IS NOT NULL ORDER BY trade_date", [name, from, to]);

/** Sensitivity of the stock to its benchmark, from a year of daily returns (1 when there is not enough history). */
function beta(stock: { t: string; c: number }[], index: { t: string; c: number }[]): number | null {
  const byDate = new Map(index.map((r) => [r.t, r.c]));
  const pairs: [number, number][] = [];
  for (let i = 1; i < stock.length; i++) {
    const a = byDate.get(stock[i].t), b = byDate.get(stock[i - 1].t);
    if (a === undefined || b === undefined || !b || !stock[i - 1].c) continue;
    pairs.push([stock[i].c / stock[i - 1].c - 1, a / b - 1]);
  }
  if (pairs.length < 60) return null;
  const mx = pairs.reduce((s, p) => s + p[1], 0) / pairs.length;
  const my = pairs.reduce((s, p) => s + p[0], 0) / pairs.length;
  let cov = 0, varx = 0;
  for (const [y, x] of pairs) { cov += (x - mx) * (y - my); varx += (x - mx) ** 2; }
  return varx > 0 ? r2(cov / varx) : null;
}

// Sector indices in the order they describe a company best: a narrow sector beats a theme like "commodities".
const SECTOR_ORDER = [
  "niftyit", "niftybank", "niftyprivatebank", "niftypsubank", "niftyauto", "niftypharma", "niftyhealthcare",
  "niftyfmcg", "niftymetal", "niftyrealty", "niftyoilgas", "niftyenergy", "niftymedia", "niftyconsumerdurables",
  "niftyfinancialservices", "niftyinfra", "niftycommodities", "niftyconsumption", "niftyservicessector", "niftypse", "niftycpse", "niftymnc",
];

/** The index to read the move against: the company's sector index when it has one, else the broad market. */
function benchmarkFor(identity: Identity): { slug: string | null; name: string; isSector: boolean } {
  const sector = SECTOR_ORDER.find((s) => identity.indices.includes(s) && INDEX_NAMES[s]);
  if (sector) return { slug: sector, name: INDEX_NAMES[sector], isSector: true };
  const broad = identity.indices.find((s) => INDEX_NAMES[s] && BROAD.test(s));
  return broad ? { slug: broad, name: INDEX_NAMES[broad], isSector: false } : { slug: null, name: "NIFTY 50", isSector: false };
}

/** Filings, results, actions and insider trades disclosed in the window that ends with this session. */
function candidates(db: Db, identity: Identity, session: string, hours: number): Catalyst[] {
  const from = `${addDays(session, -Math.ceil(hours / 24))}T00:00:00`;
  const to = `${session}T23:59:59`;
  const out: Catalyst[] = [];

  if (identity.symbol) {
    for (const a of db.all<Row>("SELECT ann_dt, subject, details, pdf_url FROM nse_announcement WHERE symbol = ? AND ann_dt BETWEEN ? AND ? ORDER BY ann_dt DESC LIMIT 40", [identity.symbol, from, to])) {
      const title = String(a.subject ?? "").trim() || "Exchange filing";
      const m = materiality(`${title} ${a.details ?? ""}`);
      out.push({ kind: "filing", title, detail: (a.details as string) ?? null, when: String(a.ann_dt), source: "NSE announcement", url: (a.pdf_url as string) ?? null, confidence: "Medium", expected: m.expected, agrees: null, score: m.weight });
    }
    for (const b of db.all<Row>("SELECT meeting_dt, purpose, description FROM nse_board_meeting WHERE symbol = ? AND meeting_dt BETWEEN ? AND ? LIMIT 10", [identity.symbol, from.slice(0, 10), to.slice(0, 10)])) {
      out.push({ kind: "board", title: `Board meeting: ${String(b.purpose ?? "").trim() || "purpose not stated"}`, detail: (b.description as string) ?? null, when: String(b.meeting_dt), source: "NSE board meetings", url: null, confidence: "Medium", expected: "flat", agrees: null, score: 5 });
    }
    for (const c of db.all<Row>("SELECT purpose, ex_date FROM nse_corp_action WHERE symbol = ? AND ex_date BETWEEN ? AND ? LIMIT 10", [identity.symbol, addDays(session, -2), addDays(session, 7)])) {
      const m = materiality(String(c.purpose ?? ""));
      out.push({ kind: "action", title: `Corporate action: ${c.purpose}`, detail: `Ex-date ${c.ex_date}`, when: `${c.ex_date}T09:15:00`, source: "NSE corporate actions", url: null, confidence: "Medium", expected: m.expected, agrees: null, score: String(c.ex_date) <= session ? m.weight : m.weight - 2 });
    }
    for (const t of db.all<Row>("SELECT broadcast, acquirer, txn_type, quantity, value FROM nse_insider_trade WHERE symbol = ? AND broadcast BETWEEN ? AND ? ORDER BY broadcast DESC LIMIT 10", [identity.symbol, from, to])) {
      const sale = /dispos|sell|sale/i.test(String(t.txn_type ?? ""));
      out.push({
        kind: "insider", title: `Insider ${sale ? "sale" : "purchase"} disclosed by ${t.acquirer}`,
        detail: `${t.txn_type ?? ""}${t.quantity ? ` · ${Number(t.quantity).toLocaleString("en-IN")} shares` : ""}`,
        when: String(t.broadcast), source: "NSE insider trading", url: null, confidence: "Low", expected: sale ? "down" : "up", agrees: null, score: 6,
      });
    }
    // The filing moment lives on the result announcement, not on the parsed figures.
    for (const f of db.all<Row>(
      "SELECT r.period_end, r.broadcast_dt, r.consolidated, f.xbrl_url FROM nse_financial_result r "
      + "LEFT JOIN nse_fundamental f ON f.symbol = r.symbol AND f.period_end = r.period_end AND f.consolidated = r.consolidated "
      + "WHERE r.symbol = ? AND r.broadcast_dt BETWEEN ? AND ? ORDER BY r.broadcast_dt DESC LIMIT 4", [identity.symbol, from, to])) {
      out.push({ kind: "result", title: `Results filed for the quarter to ${f.period_end}`, detail: (f.consolidated as string) ?? null, when: String(f.broadcast_dt), source: "NSE result filing", url: (f.xbrl_url as string) ?? null, confidence: "High", expected: "flat", agrees: null, score: 12 });
    }
  }

  if (identity.bseCode) {
    for (const a of db.all<Row>("SELECT news_dt, headline, category, pdf_url FROM announcement WHERE scrip_cd = ? AND news_dt BETWEEN ? AND ? ORDER BY news_dt DESC LIMIT 30", [identity.bseCode, from, to])) {
      const title = String(a.headline ?? "").trim() || "Exchange filing";
      const m = materiality(`${title} ${a.category ?? ""}`);
      // Both exchanges get the same filing; keep one copy.
      if (out.some((c) => c.kind === "filing" && c.title.slice(0, 40).toLowerCase() === title.slice(0, 40).toLowerCase())) continue;
      out.push({ kind: "filing", title, detail: (a.category as string) ?? null, when: String(a.news_dt), source: "BSE filing", url: (a.pdf_url as string) ?? null, confidence: "Medium", expected: m.expected, agrees: null, score: m.weight });
    }
  }
  return out;
}

/** Why this stock moved on its last completed session. */
export function whyMoving(db: Db, ident: string, opts: { windowHours?: number } = {}): MoveExplanation | null {
  let identity: Identity;
  try {
    identity = resolve(db, ident);
  } catch {
    return null;
  }
  const exchange = pickExchange(identity, "");
  const quote = eodQuote(db, identity, exchange);
  const session = quote.session;
  const windowHours = opts.windowHours ?? 72;

  const empty = (headline: string, summary: string): MoveExplanation => ({
    symbol: identity.symbol ?? identity.key, company: identity.company, quote,
    move: { session, changePct: quote.changePct, benchmark: null, market: null, beta: null, abnormalPct: null, volume: quote.volume, averageVolume20d: null, volumeRatio: null, volatility30d: null, threshold: null, material: false, direction: "flat" },
    headline, summary, catalysts: [], noCatalyst: true,
    searched: [], notCovered: [], generatedAt: new Date().toISOString(),
  });
  if (!session) return empty("No price on record", "There is no session on file for this security, so there is no move to explain.");

  // --- the move itself ------------------------------------------------------------------
  const history = closes(db, identity, exchange, addDays(session, -400), session);
  const recent = history.slice(-21);
  const volumes = recent.slice(0, -1).map((r) => r.v).filter((v): v is number => typeof v === "number" && v > 0);
  const avgVolume = volumes.length >= 5 ? Math.round(volumes.reduce((s, v) => s + v, 0) / volumes.length) : null;
  const rets: number[] = [];
  for (let i = Math.max(1, history.length - 30); i < history.length; i++) if (history[i - 1].c) rets.push(history[i].c / history[i - 1].c - 1);
  const mean = rets.length ? rets.reduce((s, r) => s + r, 0) / rets.length : 0;
  const vol30 = rets.length >= 10 ? Math.sqrt(rets.reduce((s, r) => s + (r - mean) ** 2, 0) / (rets.length - 1)) * 100 : null;

  const bm = benchmarkFor(identity);
  const bmHistory = indexCloses(db, bm.name, addDays(session, -400), session);
  const bmToday = bmHistory.at(-1);
  const bmPct = bmToday?.t === session ? r2(bmToday.pct ?? null) : null;
  const marketRows = bm.name === "NIFTY 50" ? bmHistory : indexCloses(db, "NIFTY 50", addDays(session, -5), session);
  const marketToday = marketRows.at(-1);
  const marketPct = marketToday?.t === session ? r2(marketToday.pct ?? null) : null;
  const b = beta(history, bmHistory);
  const abnormal = quote.changePct !== null && bmPct !== null ? r2(quote.changePct - (b ?? 1) * bmPct) : null;

  // Material when the move is large for this stock, or the volume is unusual: the spec's 2x volatility / 2x volume.
  const threshold = vol30 !== null ? r2(Math.max(2 * vol30, 2)) : 3;
  const volumeRatio = avgVolume && quote.volume ? r2(quote.volume / avgVolume) : null;
  const move: MoveContext = {
    session, changePct: quote.changePct,
    benchmark: { slug: bm.slug, name: bm.name, changePct: bmPct, isSector: bm.isSector },
    market: { name: "NIFTY 50", changePct: marketPct },
    beta: b, abnormalPct: abnormal, volume: quote.volume, averageVolume20d: avgVolume, volumeRatio,
    volatility30d: r2(vol30), threshold,
    material: Boolean((abnormal !== null && Math.abs(abnormal) >= (threshold ?? 3)) || (quote.changePct !== null && Math.abs(quote.changePct) >= (threshold ?? 3)) || (volumeRatio !== null && volumeRatio >= 2)),
    direction: dir(quote.changePct, 0.5),
  };

  // --- what could account for it --------------------------------------------------------
  const found = candidates(db, identity, session, windowHours);
  for (const c of found) {
    const sameDay = c.when.slice(0, 10) === session;
    const dayBefore = c.when.slice(0, 10) === addDays(session, -1);
    c.agrees = c.expected === "flat" ? null : c.expected === move.direction;
    // Time proximity, then whether the event points the way the price went.
    c.score += sameDay ? 6 : dayBefore ? 3 : 0;
    if (c.agrees === true) c.score += 3;
    if (c.agrees === false) c.score -= 4;
    c.confidence = c.score >= 15 && (sameDay || dayBefore) && c.agrees !== false ? "High" : c.score >= 8 ? "Medium" : "Low";
  }
  found.sort((a, z) => z.score - a.score || z.when.localeCompare(a.when));
  const catalysts = found.filter((c) => c.score >= 8).slice(0, 4);

  // The sector move is itself an explanation, and often the right one.
  const sectorExplains = bmPct !== null && Math.abs(bmPct) >= 1 && move.direction !== "flat" && Math.sign(bmPct) === (move.direction === "up" ? 1 : -1);
  if (sectorExplains) {
    catalysts.push({
      kind: "sector", title: `${bm.name} moved ${bmPct > 0 ? "+" : ""}${bmPct}% the same day`,
      detail: abnormal === null ? null : `After the sector move${b === null ? "" : ` and a beta of ${b}`}, ${Math.abs(abnormal) < 1 ? "little of the move is specific to this company" : `${abnormal > 0 ? "+" : ""}${abnormal}% is specific to this company`}.`,
      when: `${session}T15:30:00`, source: `${bm.name} index`, url: null,
      confidence: Math.abs(abnormal ?? 9) < 1 ? "High" : "Medium", expected: move.direction, agrees: true, score: 7,
    });
  }

  const pctText = quote.changePct === null ? "" : `${quote.changePct > 0 ? "+" : ""}${quote.changePct}%`;
  const headline = move.direction === "flat"
    ? `${identity.company ?? identity.key} closed roughly flat`
    : `Why ${identity.company ?? identity.key} closed ${move.direction} ${pctText}`;

  const parts: string[] = [];
  if (quote.changePct !== null) parts.push(`${identity.symbol ?? identity.key} ${pctText}`);
  if (bmPct !== null) parts.push(`${bm.name} ${bmPct > 0 ? "+" : ""}${bmPct}%`);
  if (marketPct !== null && bm.name !== "NIFTY 50") parts.push(`Nifty 50 ${marketPct > 0 ? "+" : ""}${marketPct}%`);
  const comparison = parts.join(" vs ");
  const peerWord = bm.isSector ? "its sector" : "the market";
  const relative = abnormal === null ? "" : Math.abs(abnormal) < 1 ? ` - in line with ${peerWord}` : abnormal > 0 ? ` - outperforming ${peerWord}` : ` - lagging ${peerWord}`;

  const companySpecific = catalysts.filter((c) => c.kind !== "sector");
  const summary = move.direction === "flat" && !move.material
    ? `${comparison}${relative}. The stock barely moved, so there is nothing to explain.`
    : companySpecific.length
      ? `${comparison}${relative}. ${companySpecific.length} disclosure${companySpecific.length > 1 ? "s" : ""} in the ${windowHours} hours to the close could bear on it; each is linked below.`
      : sectorExplains
        ? `${comparison}${relative}. No company-specific disclosure was filed in the ${windowHours} hours to the close, so the move looks ${bm.isSector ? "sector-driven" : "market-driven"}.`
        : `${comparison}${relative}. Nothing was filed by the company in the ${windowHours} hours to the close, so no company-specific cause can be shown from the public record.`;

  return {
    symbol: identity.symbol ?? identity.key,
    company: identity.company,
    quote, move, headline, summary,
    catalysts,
    noCatalyst: companySpecific.length === 0,
    searched: [
      `NSE and BSE announcements for the ${windowHours} hours to the close`,
      "Results filed in the window",
      "Board meetings and corporate actions around the date",
      "Insider trading disclosures",
      `${bm.name} and Nifty 50 index moves`,
    ],
    notCovered: [
      "News coverage and broker commentary (no licensed news feed)",
      "Block and bulk deals (not collected yet)",
      "Intraday prices - this reads the end-of-day session only",
    ],
    generatedAt: new Date().toISOString(),
  };
}
