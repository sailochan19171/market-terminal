// Reading the filings themselves, not just their titles.
//
// The announcements table holds a headline and a link to a PDF. Everything the company actually said is inside
// that PDF, so this fetches them, one company at a time, and puts them in the document library where a question
// can reach them. It only ever fetches what is asked for: a million filings are not going to be downloaded.
import type { Db, Row } from "../db";
import { logger } from "../log";
import { NSEClient } from "../nse/client";
import { add, list } from "./store";
import { UnreadableDocument } from "./extract";

const log = logger("docs.filings");

export interface Ingested { fetched: number; skipped: number; failed: number; titles: string[] }

let client: NSEClient | null = null;
const nse = () => (client ??= new NSEClient({ rps: 1, maxRetries: 2, timeoutS: 45 }));

/** Recent announcements for a company that carry a document, newest first. */
export function pending(db: Db, symbol: string, limit: number): { url: string; title: string; when: string; exchange: string }[] {
  const have = new Set(list(db, symbol).map((d) => d.url).filter(Boolean));
  const rows = db.all<Row>(
    "SELECT ann_dt AS when_, subject AS title, pdf_url AS url, 'NSE' AS exchange FROM nse_announcement WHERE symbol = ? AND pdf_url IS NOT NULL AND pdf_url != '' ORDER BY ann_dt DESC LIMIT ?",
    [symbol, limit * 3]);
  const bseCode = db.scalar<string>("SELECT bse_code FROM company_metrics WHERE symbol = ?", [symbol]);
  if (bseCode) {
    rows.push(...db.all<Row>(
      "SELECT news_dt AS when_, headline AS title, pdf_url AS url, 'BSE' AS exchange FROM announcement WHERE scrip_cd = ? AND pdf_url IS NOT NULL AND pdf_url != '' ORDER BY news_dt DESC LIMIT ?",
      [String(bseCode), limit * 2]));
  }
  return rows
    .map((r) => ({ url: String(r.url), title: String(r.title ?? "Exchange filing"), when: String(r.when_), exchange: String(r.exchange) }))
    .filter((r) => /\.pdf(\?|$)/i.test(r.url) && !have.has(r.url))
    .sort((a, b) => b.when.localeCompare(a.when))
    .slice(0, limit);
}

/** Fetch and index one document by URL. */
export async function ingestOne(db: Db, symbol: string, doc: { url: string; title: string; when: string; exchange: string }) {
  const bytes = await nse().archive(doc.url);
  return add(db, bytes, {
    symbol,
    title: `${doc.title} (${doc.exchange}, ${doc.when.slice(0, 10)})`.slice(0, 300),
    kind: "filing",
    source: `${doc.exchange} filing`,
    url: doc.url,
    filename: doc.url.split("/").pop() ?? "filing.pdf",
  });
}

/** Fetch the most recent filings for one company into the library. */
export async function ingest(db: Db, symbol: string, limit = 10): Promise<Ingested> {
  const queue = pending(db, symbol, limit);
  const out: Ingested = { fetched: 0, skipped: 0, failed: 0, titles: [] };
  for (const doc of queue) {
    try {
      const stored = await ingestOne(db, symbol, doc);
      out.fetched++;
      out.titles.push(`${stored.title} - ${stored.pages} pages, ${stored.chunks} passages`);
    } catch (e) {
      // A scanned filing or a broken link is normal and not worth failing the run for.
      if (e instanceof UnreadableDocument) {
        out.skipped++;
        log.info(`${symbol}: skipped ${doc.title.slice(0, 60)} - ${e.message}`);
      } else {
        out.failed++;
        log.warn(`${symbol}: ${doc.title.slice(0, 60)} - ${(e as Error).message}`);
      }
    }
  }
  return out;
}
