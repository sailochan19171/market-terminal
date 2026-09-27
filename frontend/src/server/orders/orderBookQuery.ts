// The order book view: what each company is holding, how fast it is growing, and how it compares with a year
// of its own sales.
//
// One reading is a number. Several readings of the same company, each stamped with the quarter the company said
// it was "as on", are a line - and the shape of that line is the point of the view: an order book that has grown
// by half in three months is a company whose next two years look different from its last two.
//
// Growth is measured between two readings the company itself published. Where there is no earlier reading inside
// the window, there is no growth figure - an empty cell, never a zero, because "we do not know" and "it has not
// grown" are different things.
import type { Db, Row } from "../db";
import { ensureSchema } from "./orderBook";

export interface OrderBookView {
  symbol: string | null;
  company: string | null;
  scripCd: string | null;
  /** The newest reading. */
  orderBookCr: number;
  asOf: string;
  filedAt: string;
  /** Revenue for the last full year on record, and the label that says which. */
  revenueCr: number | null;
  revenueBasis: string | null;
  /** Order book against a year of sales: how many years of work is on the books. */
  bookToRevenue: number | null;
  /** Growth against the newest reading at least this many months old, as a percentage. */
  growth3m: number | null;
  growth6m: number | null;
  growth12m: number | null;
  /** Every reading, oldest first, for the sparkline. */
  history: { asOf: string; valueCr: number }[];
  phrase: string | null;
  pdfUrl: string | null;
}

export interface OrderBookFilters {
  /** Only companies holding at least this much, in crore. */
  minBookCr?: number;
  window?: "3m" | "6m" | "12m";
  search?: string | null;
  sort?: "growth" | "book" | "updated";
  limit?: number;
}

const num = (v: unknown): number | null => (v === null || v === undefined || v === "" ? null : Number(v));
const monthsBefore = (iso: string, months: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() - months);
  return d.toISOString().slice(0, 10);
};

/**
 * Growth between the newest reading and the newest one at or before `months` ago. A reading a little either side
 * of the mark still counts - companies report quarterly, so an exact three months back rarely exists - but one
 * from before the window's own start does not, or a year-old figure would be passed off as a quarter's growth.
 */
function growthOver(history: { asOf: string; valueCr: number }[], months: number): number | null {
  if (history.length < 2) return null;
  const newest = history[history.length - 1];
  const mark = monthsBefore(newest.asOf, months);
  const floor = monthsBefore(newest.asOf, months * 2);        // no further back than twice the window
  const earlier = [...history].reverse().find((h) => h.asOf <= mark && h.asOf >= floor);
  if (!earlier || earlier.valueCr <= 0 || earlier.asOf === newest.asOf) return null;
  return Math.round(((newest.valueCr - earlier.valueCr) / earlier.valueCr) * 1000) / 10;
}

export function orderBooks(db: Db, f: OrderBookFilters = {}): OrderBookView[] {
  ensureSchema(db);
  const rows = db.all<Row>(
    `SELECT b.symbol, b.scrip_cd, b.company, b.as_of, b.order_book_cr, b.filed_at, b.phrase, b.pdf_url,
            m.sales_ttm_cr, m.basis
       FROM company_order_book b
       LEFT JOIN company_metrics m ON m.symbol = b.symbol
      ORDER BY b.as_of ASC`);

  // Every reading of one company, in date order, so the newest is the last and the line reads left to right.
  const byCompany = new Map<string, Row[]>();
  for (const r of rows) {
    const key = String(r.symbol ?? r.company ?? r.scrip_cd ?? "");
    if (!key) continue;
    (byCompany.get(key) ?? byCompany.set(key, []).get(key)!).push(r);
  }

  const out: OrderBookView[] = [];
  for (const readings of byCompany.values()) {
    const history = readings.map((r) => ({ asOf: String(r.as_of), valueCr: Number(r.order_book_cr) }));
    const last = readings[readings.length - 1];
    const book = Number(last.order_book_cr);
    const revenue = num(last.sales_ttm_cr);
    out.push({
      symbol: last.symbol ? String(last.symbol) : null,
      company: last.company ? String(last.company) : null,
      scripCd: last.scrip_cd ? String(last.scrip_cd) : null,
      orderBookCr: book,
      asOf: String(last.as_of),
      filedAt: String(last.filed_at),
      revenueCr: revenue,
      revenueBasis: last.basis ? String(last.basis) : null,
      bookToRevenue: revenue && revenue > 0 ? Math.round((book / revenue) * 100) / 100 : null,
      growth3m: growthOver(history, 3),
      growth6m: growthOver(history, 6),
      growth12m: growthOver(history, 12),
      history,
      phrase: last.phrase ? String(last.phrase) : null,
      pdfUrl: last.pdf_url ? String(last.pdf_url) : null,
    });
  }

  const min = f.minBookCr ?? 0;
  const term = (f.search ?? "").trim().toLowerCase();
  const growthOf = (v: OrderBookView) => (f.window === "12m" ? v.growth12m : f.window === "6m" ? v.growth6m : v.growth3m);
  const filtered = out
    .filter((v) => v.orderBookCr >= min)
    .filter((v) => !term || `${v.company ?? ""} ${v.symbol ?? ""}`.toLowerCase().includes(term));
  const sorted = filtered.sort((a, b) =>
    f.sort === "book" ? b.orderBookCr - a.orderBookCr
      : f.sort === "growth" ? (growthOf(b) ?? -Infinity) - (growthOf(a) ?? -Infinity)
        : b.filedAt.localeCompare(a.filedAt));
  return f.limit ? sorted.slice(0, f.limit) : sorted;
}

/** The companies whose books have grown fastest in the window, for the cards along the top. */
export function topGainers(db: Db, f: OrderBookFilters = {}): OrderBookView[] {
  const window = f.window ?? "3m";
  return orderBooks(db, { ...f, window, sort: "growth" })
    .filter((v) => (window === "12m" ? v.growth12m : window === "6m" ? v.growth6m : v.growth3m) !== null)
    .slice(0, f.limit ?? 12);
}

/** How many companies are on file, and how many of those are growing, for the header. */
export function orderBookSummary(db: Db, f: OrderBookFilters = {}): { companies: number; rising: number } {
  const all = orderBooks(db, { ...f, limit: undefined });
  const window = f.window ?? "3m";
  const growth = (v: OrderBookView) => (window === "12m" ? v.growth12m : window === "6m" ? v.growth6m : v.growth3m);
  return { companies: all.length, rising: all.filter((v) => (growth(v) ?? 0) > 0).length };
}
