// Order wins, read out of the companies' own announcement PDFs.
//
// Both exchanges file an order win under a category of its own - NSE "Bagging/Receiving of orders/contracts",
// BSE "Award of Order / Receipt of Order" - but the figures that matter (who the customer is, what the contract
// is worth, how long it runs) are only inside the attached PDF. This table holds what was read out of that PDF,
// one row per announcement, always with the link back to it so a reader can check.
//
// Nothing here is a judgement: a value that is not in the document is stored as null with the reason, never
// guessed. The order size against revenue is not stored at all - it is worked out at query time from the
// latest revenue, so it moves when the results do.
import type { Db, Row } from "../db";
import { now } from "../db";

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS company_order (
    id               TEXT PRIMARY KEY,   -- the exchange's announcement id
    exchange         TEXT NOT NULL,      -- NSE | BSE
    symbol           TEXT,               -- NSE symbol, resolved for BSE rows where possible
    scrip_cd         TEXT,
    company          TEXT,
    announced_at     TEXT NOT NULL,
    customer         TEXT,               -- who placed the order, as the filing names it
    order_type       TEXT,               -- supply, EPC, service, export ... as the filing describes it
    contract_value_cr REAL,              -- in crore rupees, converted when the filing uses another unit
    currency         TEXT,               -- the currency the filing stated
    duration_months  REAL,
    work_scope       TEXT,
    location         TEXT,
    is_order         INTEGER NOT NULL DEFAULT 1,  -- 0: the PDF was read and is not an order win
    confidence       REAL,
    extracted_by     TEXT,               -- model | rules
    model            TEXT,
    headline         TEXT,
    summary          TEXT,
    pdf_url          TEXT,
    pdf_chars        INTEGER,
    note             TEXT,               -- why a field is missing, or why the PDF could not be read
    extracted_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_order_dt   ON company_order(announced_at);
CREATE INDEX IF NOT EXISTS ix_order_sym  ON company_order(symbol, announced_at);

-- Announcements already looked at, so a failed or empty PDF is not fetched again on every run.
CREATE TABLE IF NOT EXISTS company_order_seen (
    id         TEXT PRIMARY KEY,
    status     TEXT NOT NULL,            -- extracted | not_an_order | unreadable | failed
    detail     TEXT,
    tries      INTEGER NOT NULL DEFAULT 1,
    seen_at    TEXT NOT NULL
);
`;

let ready = false;
export function ensureSchema(db: Db) {
  if (ready) return;
  db.exec(SCHEMA);
  // Added after the table was already in use: without it, every filing that had failed once stayed failed.
  db.addColumns("company_order_seen", { tries: "INTEGER NOT NULL DEFAULT 1" });
  ready = true;
}

export interface OrderRow {
  id: string; exchange: string; symbol: string | null; scripCd: string | null; company: string | null;
  announcedAt: string; customer: string | null; orderType: string | null; contractValueCr: number | null;
  currency: string | null; durationMonths: number | null; workScope: string | null; location: string | null;
  isOrder: boolean; confidence: number | null; extractedBy: string | null; model: string | null;
  headline: string | null; summary: string | null; pdfUrl: string | null; pdfChars: number | null; note: string | null;
}

export function save(db: Db, o: OrderRow) {
  ensureSchema(db);
  db.run(
    `INSERT INTO company_order (id, exchange, symbol, scrip_cd, company, announced_at, customer, order_type,
       contract_value_cr, currency, duration_months, work_scope, location, is_order, confidence, extracted_by,
       model, headline, summary, pdf_url, pdf_chars, note, extracted_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET
       symbol = excluded.symbol, company = excluded.company, customer = excluded.customer,
       order_type = excluded.order_type, contract_value_cr = excluded.contract_value_cr, currency = excluded.currency,
       duration_months = excluded.duration_months, work_scope = excluded.work_scope, location = excluded.location,
       is_order = excluded.is_order, confidence = excluded.confidence, extracted_by = excluded.extracted_by,
       model = excluded.model, summary = excluded.summary, pdf_chars = excluded.pdf_chars, note = excluded.note,
       extracted_at = excluded.extracted_at`,
    [o.id, o.exchange, o.symbol, o.scripCd, o.company, o.announcedAt, o.customer, o.orderType,
      o.contractValueCr, o.currency, o.durationMonths, o.workScope, o.location, o.isOrder ? 1 : 0, o.confidence,
      o.extractedBy, o.model, o.headline, o.summary, o.pdfUrl, o.pdfChars, o.note, now()]);
}

export function markSeen(db: Db, id: string, status: string, detail?: string | null) {
  ensureSchema(db);
  // Each attempt is counted, so a filing that keeps failing is eventually left alone instead of being fetched
  // for ever, while one that failed once is tried again.
  db.run("INSERT INTO company_order_seen (id, status, detail, tries, seen_at) VALUES (?,?,?,1,?) ON CONFLICT(id) DO UPDATE SET status = excluded.status, detail = excluded.detail, tries = company_order_seen.tries + 1, seen_at = excluded.seen_at",
    [id, status, detail ?? null, now()]);
}

/** How many times a filing that failed is fetched again quickly before it is left for the slow pass. */
const RETRIES = 4;
/** How long to wait before trying a failed filing again, so a slow exchange is not hammered. */
const RETRY_AFTER_HOURS = 3;
/**
 * A filing that has failed its four quick attempts is not given up on - it is tried once a fortnight instead.
 * An exchange's archive goes down for a week, a link is wrong until someone re-files it, a PDF is served
 * truncated for a day: none of those are permanent, and a document abandoned for good is a company's order
 * missing from the site for ever. The long pass costs one fetch a fortnight per stuck filing.
 */
const SLOW_RETRY_AFTER_DAYS = 14;

export function seenIds(db: Db, ids: string[]): Set<string> {
  if (!ids.length) return new Set();
  ensureSchema(db);
  const found = new Set<string>();
  for (let i = 0; i < ids.length; i += 400) {
    const batch = ids.slice(i, i + 400);
    // A filing that failed on a timeout is not done with - it is one NSE was slow about, and dropping it loses
    // the order for good. Those come back after a few hours, up to a few attempts; a scan with no text in it,
    // or a filing already read, stays read.
    const rows = db.all<Row>(
      `SELECT id FROM company_order_seen
        WHERE id IN (${batch.map(() => "?").join(",")})
          AND NOT (
            status = 'failed' AND (
              (tries < ${RETRIES} AND seen_at < datetime('now', '-${RETRY_AFTER_HOURS} hours'))
              OR seen_at < datetime('now', '-${SLOW_RETRY_AFTER_DAYS} days')
            )
          )`, batch);
    for (const r of rows) found.add(String(r.id));
  }
  return found;
}

/** How much of the work is done: extracted rows, and what is still waiting to be read. */
export function coverage(db: Db): { orders: number; notOrders: number; unreadable: number; lastExtractedAt: string | null } {
  ensureSchema(db);
  return {
    orders: Number(db.scalar<number>("SELECT COUNT(*) FROM company_order WHERE is_order = 1") ?? 0),
    notOrders: Number(db.scalar<number>("SELECT COUNT(*) FROM company_order_seen WHERE status = 'not_an_order'") ?? 0),
    unreadable: Number(db.scalar<number>("SELECT COUNT(*) FROM company_order_seen WHERE status IN ('unreadable','failed')") ?? 0),
    lastExtractedAt: db.scalar<string>("SELECT MAX(extracted_at) FROM company_order") ?? null,
  };
}
