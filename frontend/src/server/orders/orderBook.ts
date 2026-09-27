// The order book a company reports to its investors, read out of its own presentation.
//
// An order win tells a reader what came in on one day. The order book tells them what is still to be delivered -
// and set against a year's revenue, how many years of work the company is holding. Neither exchange publishes
// it: companies state it in the quarterly investor presentation, on a slide that says "Order book: Rs. 1,854 Cr
// as on 30 June 2026", so it has to be read out of the PDF like the order filings are.
//
// Each reading is kept with the date the company gave it "as on", not the day the file was published, because a
// presentation filed in September may still be reporting the June quarter. That is what makes a series of
// readings comparable, and what lets the dashboard say how much the book has grown over three months.
import type { Db, Row } from "../db";
import { logger } from "../log";
import { now } from "../db";
import { rupeesFromWords } from "./amountWords";

const log = logger("orders.orderbook");

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS company_order_book (
    id           TEXT PRIMARY KEY,      -- the announcement the presentation came from
    symbol       TEXT,
    scrip_cd     TEXT,
    company      TEXT,
    as_of        TEXT NOT NULL,         -- the date the company stated the book as on (YYYY-MM-DD)
    as_of_stated INTEGER NOT NULL DEFAULT 1,  -- 0 when the deck gave no date and the filing date stands in
    order_book_cr REAL NOT NULL,        -- in crore rupees
    filed_at     TEXT NOT NULL,         -- when the presentation was filed
    phrase       TEXT,                  -- the sentence it was read from, for a reader to check
    pdf_url      TEXT,
    read_by      TEXT,                  -- rules | model
    confidence   REAL,
    extracted_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_book_symbol ON company_order_book(symbol, as_of);

-- Presentations already read, so a deck that reports no order book is not downloaded again every run.
CREATE TABLE IF NOT EXISTS company_order_book_seen (
    id      TEXT PRIMARY KEY,
    status  TEXT NOT NULL,            -- read | no_order_book | unreadable | failed
    detail  TEXT,
    seen_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_book_reading ON company_order_book(symbol, as_of, order_book_cr);
`;

let ready = false;
export function ensureSchema(db: Db) {
  if (ready) return;
  db.exec(SCHEMA);
  db.addColumns("company_order_book", { as_of_stated: "INTEGER NOT NULL DEFAULT 1" });
  ready = true;
}

const CRORE_PER: Record<string, number> = { crore: 1, cr: 1, crs: 1, lakh: 0.01, lac: 0.01, million: 0.1, mn: 0.1, billion: 100, bn: 100 };

/** A month name to its number, for "as on 30th June, 2026" and "as of June 30, 2026". */
const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

/** "30th June 2026", "June 30, 2026", "30.06.2026", "Q1 FY27" -> an ISO date, or null. */
export function readAsOf(text: string): string | null {
  const t = text.replace(/\s+/g, " ");
  const dmy = t.match(/\b(\d{1,2})(?:st|nd|rd|th)?[\s.\-/]+([a-z]{3,9})[\s.,\-/]+(\d{4})\b/i);
  if (dmy) {
    const m = MONTHS[dmy[2].slice(0, 4).toLowerCase()] ?? MONTHS[dmy[2].slice(0, 3).toLowerCase()];
    if (m) return `${dmy[3]}-${String(m).padStart(2, "0")}-${dmy[1].padStart(2, "0")}`;
  }
  const mdy = t.match(/\b([a-z]{3,9})[\s.]+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/i);
  if (mdy) {
    const m = MONTHS[mdy[1].slice(0, 4).toLowerCase()] ?? MONTHS[mdy[1].slice(0, 3).toLowerCase()];
    if (m) return `${mdy[3]}-${String(m).padStart(2, "0")}-${mdy[2].padStart(2, "0")}`;
  }
  const numeric = t.match(/\b(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{4})\b/);
  if (numeric) return `${numeric[3]}-${numeric[2].padStart(2, "0")}-${numeric[1].padStart(2, "0")}`;
  // "Q1 FY27" and "Q3FY2026": the quarter's last day, on an Indian fiscal year that ends in March.
  const q = t.match(/\bq([1-4])\s*[',]?\s*fy\s*'?(\d{2,4})\b/i);
  if (q) {
    const quarter = Number(q[1]);
    const yy = Number(q[2].length === 2 ? `20${q[2]}` : q[2]);          // FY27 ends March 2027
    const ends = [[6, 30], [9, 30], [12, 31], [3, 31]][quarter - 1];
    const year = quarter === 4 ? yy : yy - 1;
    return `${year}-${String(ends[0]).padStart(2, "0")}-${ends[1]}`;
  }
  return null;
}

/**
 * The order book stated in the text, in crore, with the sentence it came from. A presentation repeats the figure
 * on several slides and mentions other large numbers - revenue, market cap, capex - so only a phrase that names
 * the order book itself is read, and the reading nearest the front of the deck wins, that being the headline.
 */
export function orderBookFromText(text: string): { valueCr: number; asOf: string | null; phrase: string } | null {
  const flat = text.replace(/\s+/g, " ");
  const LABEL = /(?:total |current |outstanding |unexecuted |consolidated |net )?order\s*book(?:\s*(?:position|value|size))?/i;
  const AMOUNT = /(?:rs\.?|inr|₹)?\s*([\d,]+(?:\.\d+)?)\s*(crores?|crs?\b|lakhs?|lacs?|millions?|mn\b|billions?|bn\b)?/gi;

  const label = flat.match(LABEL);
  if (!label || label.index === undefined) return fromWords(flat);
  const from = label.index + label[0].length;
  const window = flat.slice(from, from + 200);

  for (const m of window.matchAll(AMOUNT)) {
    const at = m.index ?? 0;
    const digits = m[1];
    const before = window.slice(Math.max(0, at), at + m[0].indexOf(digits)).toLowerCase() + window.slice(Math.max(0, at - 14), at).toLowerCase();
    const after = window.slice(at + m[0].length, at + m[0].length + 6);
    // A date's day and month read as a number: "as on 31.03.2026 is Rs 5,143.3 crores". Skip it and read on.
    if (/\b(?:as on|as of|as at|dated|w\.e\.f\.?)\s*$/.test(before)) continue;
    if (/^[./-]\d/.test(after)) continue;
    if (/^(?:19|20)\d{2}$/.test(digits)) continue;                    // a bare year
    // A slide deck's text comes out jumbled - "Current Order Book as ... on 31 March 2026" - so a bare number
    // near the label means nothing. Only a figure the deck marked as money counts: "Rs. 1,854" or "1,854 Cr".
    const marked = /rs\.?|inr|₹/i.test(m[0]) || Boolean(m[2]);
    if (!marked) continue;
    if (/^\s*(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i.test(after)) continue;   // "31 March 2026"
    const raw = Number(digits.replace(/,/g, ""));
    if (!Number.isFinite(raw) || raw <= 0) continue;
    const unit = (m[2] ?? "").toLowerCase().replace(/s$/, "").replace(/\./g, "");
    // Without a unit word a presentation means crore, which is how an Indian company states an order book; a
    // figure large enough to be rupees written out is converted instead.
    const valueCr = unit ? raw * (CRORE_PER[unit] ?? 0) : raw >= 1_000_000 ? raw / 1e7 : raw;
    if (!valueCr || valueCr <= 0 || valueCr > 10_000_000) continue;    // beyond ten lakh crore is a misread
    const around = flat.slice(Math.max(0, label.index - 60), from + at + 200);
    return { valueCr: Math.round(valueCr * 100) / 100, asOf: readAsOf(around), phrase: flat.slice(label.index, label.index + 130).trim() };
  }
  return fromWords(flat);
}

/** Some decks write it out: "order book of Rupees One Thousand Eight Hundred Fifty Four Crore". */
function fromWords(flat: string): { valueCr: number; asOf: string | null; phrase: string } | null {
  const words = flat.match(/order\s*book[^.\n]{0,40}?rupees?\s+([a-z\s]{8,120}?(?:crore|lakh)s?)/i);
  if (!words) return null;
  const rupees = rupeesFromWords(words[1]);
  if (!rupees) return null;
  return { valueCr: Math.round((rupees / 1e7) * 100) / 100, asOf: readAsOf(flat.slice(0, 400)), phrase: words[0].slice(0, 130) };
}

export interface OrderBookRow {
  id: string; symbol: string | null; scripCd: string | null; company: string | null;
  asOf: string; orderBookCr: number; filedAt: string; phrase: string | null; pdfUrl: string | null;
  readBy: "rules" | "model"; confidence: number | null;
  /**
   * Whether the deck itself said what date the book was as on. Engineers India restated its 31 March figure at
   * an August annual meeting; stamped with the filing date it read as an August book, and the growth between
   * the two would have been invented. A reading without a stated date is kept, but it is not a point on a line.
   */
  asOfStated: boolean;
}

export function save(db: Db, rows: OrderBookRow[]) {
  if (!rows.length) return 0;
  ensureSchema(db);
  const at = now();
  db.upsert("company_order_book", rows.map((r) => ({
    id: r.id, symbol: r.symbol, scrip_cd: r.scripCd, company: r.company, as_of: r.asOf,
    order_book_cr: r.orderBookCr, filed_at: r.filedAt, phrase: r.phrase, pdf_url: r.pdfUrl, as_of_stated: r.asOfStated ? 1 : 0,
    read_by: r.readBy, confidence: r.confidence, extracted_at: at,
  })));
  log.info(`order book: ${rows.length} reading${rows.length === 1 ? "" : "s"} stored`);
  return rows.length;
}

/** Record that a deck has been looked at, whatever it turned out to hold. */
export function markSeen(db: Db, id: string, status: "read" | "no_order_book" | "unreadable" | "failed", detail?: string) {
  ensureSchema(db);
  db.upsert("company_order_book_seen", [{ id, status, detail: detail ?? null, seen_at: now() }]);
}

/**
 * The industries whose companies carry an order book at all. A pharma or a bank has no work in hand to report,
 * and reading its deck to learn that again costs a hundred-page download for nothing: of thirty presentations
 * taken at random, twenty-five never mentioned one. Narrowing to these turns most of the downloads into readings.
 */
export const ORDER_BOOK_INDUSTRIES = ["Capital Goods", "Construction", "Construction Materials", "Power", "Realty", "Services", "Metals & Mining", "Information Technology"];

/** Investor presentations not yet read for an order book, newest first. */
export function presentations(db: Db, opts: { days?: number; limit?: number; symbol?: string | null; industries?: string[] | null } = {}): {
  id: string; exchange: "NSE" | "BSE"; symbol: string | null; scripCd: string | null; company: string | null; filedAt: string; pdfUrl: string;
}[] {
  ensureSchema(db);
  const since = new Date(Date.now() - (opts.days ?? 400) * 86_400_000).toISOString().slice(0, 10);
  const limit = opts.limit ?? 40;
  const industries = opts.industries ?? null;
  const inList = industries ? `(${industries.map(() => "?").join(", ")})` : "";
  const nse = db.all<Row>(
    `SELECT a.ann_id id, a.symbol, a.company, a.ann_dt, a.pdf_url
       FROM nse_announcement a
       LEFT JOIN company_metrics m ON m.symbol = a.symbol
      WHERE a.subject LIKE '%Investor Presentation%' AND a.ann_dt >= ? AND a.pdf_url LIKE 'http%'
        AND NOT EXISTS (SELECT 1 FROM company_order_book_seen s WHERE s.id = 'NSE:' || a.ann_id)
      ${industries ? `AND m.industry IN ${inList}` : ""}
      ${opts.symbol ? "AND a.symbol = ?" : ""}
      ORDER BY a.ann_dt DESC LIMIT ?`,
    [since, ...(industries ?? []), ...(opts.symbol ? [opts.symbol] : []), limit]);
  const bse = db.all<Row>(
    `SELECT b.news_id id, b.scrip_cd, b.headline, b.news_dt, b.pdf_url, m.symbol, m.company
       FROM announcement b
       LEFT JOIN company_metrics m ON m.bse_code = b.scrip_cd
      WHERE b.subcategory LIKE '%Presentation%' AND b.news_dt >= ? AND b.pdf_url LIKE 'http%'
        AND NOT EXISTS (SELECT 1 FROM company_order_book_seen s WHERE s.id = 'BSE:' || b.news_id)
      ${industries ? `AND m.industry IN ${inList}` : ""}
      ${opts.symbol ? "AND m.symbol = ?" : ""}
      ORDER BY b.news_dt DESC LIMIT ?`,
    [since, ...(industries ?? []), ...(opts.symbol ? [opts.symbol] : []), limit]);
  return [
    ...nse.map((r) => ({ id: `NSE:${String(r.id)}`, exchange: "NSE" as const, symbol: r.symbol ? String(r.symbol) : null, scripCd: null, company: r.company ? String(r.company) : null, filedAt: String(r.ann_dt), pdfUrl: String(r.pdf_url) })),
    ...bse.map((r) => ({ id: `BSE:${String(r.id)}`, exchange: "BSE" as const, symbol: r.symbol ? String(r.symbol) : null, scripCd: r.scrip_cd ? String(r.scrip_cd) : null, company: r.company ? String(r.company) : (r.headline ? String(r.headline).split(" - ")[0] : null), filedAt: String(r.news_dt), pdfUrl: String(r.pdf_url) })),
  ].sort((a, b) => b.filedAt.localeCompare(a.filedAt)).slice(0, limit);
}
