// Read the order book out of investor presentations, into company_order_book.
//
//   npx tsx scripts/orderbook-backfill.ts [days] [limit]
//
// Rules only, no model: a deck states the figure as "Order Book: Rs. 1,854 Cr as on 30th June 2026", which a
// pattern reads as well as a model would and at no cost against the day's token allowance. A deck that states it
// some other way is left for the model pass to pick up later; it is recorded as read either way, so the same
// hundred-page PDF is not downloaded again on every run.
//
// The figure is stored against the date the company said it was "as on", so several quarters of presentations
// build the history the dashboard draws as a growth line.
import { Db } from "../src/server/db";
import { BSEClient } from "../src/server/bse/client";
import { NSEClient } from "../src/server/nse/client";
import { extract as extractText } from "../src/server/docs/extract";
import { ensureSchema, markSeen, ORDER_BOOK_INDUSTRIES, orderBookFromText, presentations, quarterBefore, save, type OrderBookRow } from "../src/server/orders/orderBook";
import { orderBookFromModel } from "../src/server/orders/orderBookModel";
import { resolveSymbol } from "../src/server/orders/extract";

const days = Number(process.argv[2] ?? 400);
const limit = Number(process.argv[3] ?? 40);
// The model reads the decks the patterns cannot. Pass "rules" as the third argument to leave it out and spend
// nothing against the day's token allowance.
const useModel = !process.argv.includes("rules");


/**
 * Whether a reading is out of all proportion to the company's sales. An order book is work in hand: for a
 * builder or an equipment maker it runs from a fraction of a year's revenue to several years of it. A hundredth
 * of a year, or fifty years, is the reader having picked up the wrong number off the slide.
 *
 * A company with no revenue on file cannot be judged this way, and is left alone.
 */
function implausible(db: Db, symbol: string | null, valueCr: number): boolean {
  if (!symbol) return false;
  const revenue = db.scalar<number>("SELECT sales_ttm_cr FROM company_metrics WHERE symbol = ?", [symbol]);
  if (!revenue || revenue <= 0) return false;
  const ratio = valueCr / revenue;
  return ratio < 0.05 || ratio > 50;
}

async function main() {
  const db = new Db();
  ensureSchema(db);
  const nse = new NSEClient({ rps: 1.5, maxRetries: 2, timeoutS: 60 });
  const bse = new BSEClient({ rps: 1.5, maxRetries: 2, timeoutS: 60 });
  // Only the industries that carry an order book, unless "everyone" is asked for: most of the market has
  // nothing to report and reading its decks is a download spent to learn that again.
  const industries = process.argv.includes("everyone") ? null : ORDER_BOOK_INDUSTRIES;
  // "history" goes back through the earlier decks of companies already on the page, which is what gives each
  // of them a second and third reading - and so a line to draw and a growth figure to measure.
  const history = process.argv.includes("history");
  const todo = presentations(db, { days, limit, industries, history });
  console.log(`${todo.length} presentation${todo.length === 1 ? "" : "s"} to read (${days} days back, ${db.isRemote ? "hosted" : "local"} database)\n`);

  const found: OrderBookRow[] = [];
  let unreadable = 0, noFigure = 0, mentionedCount = 0;
  for (const [i, p] of todo.entries()) {
    const label = `${String(i + 1).padStart(3)}/${todo.length} ${(p.company ?? p.symbol ?? p.scripCd ?? "?").slice(0, 34).padEnd(35)}`;
    try {
      const bytes = p.exchange === "NSE" ? await nse.archive(p.pdfUrl) : await bse.getBytes(p.pdfUrl);
      const doc = await extractText(bytes, p.pdfUrl);
      const text = doc.pages.join("\n");
      if (doc.imageOnly || text.replace(/\s/g, "").length < 400) {
        unreadable++; markSeen(db, p.id, "unreadable", "the deck is a scan with no text");
        console.log(`${label} the deck is a scan with no text`); continue;
      }
      // The model reads the deck; the patterns are the fallback.
      //
      // It was the other way round, and the patterns were wrong more often than they were right: Prism Johnson
      // came back as 0.14 crore, Quality Power as 1 crore, Maharashtra Seamless as 2 crore, Cochin Shipyard as
      // 200 against a book in the tens of thousands. A deck is a slide, and its text arrives in the order the
      // boxes were drawn, so the number nearest the words "order book" is as likely to be a page number or half
      // a date as the figure. The model reads the same excerpt and gets it right. Where it cannot - no key, no
      // tokens left, a deck it will not answer on - the patterns still stand in, and an absurd reading is
      // dropped rather than stored.
      const mentioned = /order\s*book/i.test(text);
      let hit = mentioned && useModel ? await orderBookFromModel(text, p.company) : null;
      let readBy: "rules" | "model" = hit ? "model" : "rules";
      if (!hit) {
        hit = orderBookFromText(text);
        if (hit && implausible(db, p.symbol, hit.valueCr)) {
          console.log(`${label} the patterns read ${hit.valueCr} cr, which makes no sense against this company's sales; nothing is stored`);
          hit = null;
        }
      }
      if (!hit) {
        // Worth separating: a deck that never mentions an order book is a company that does not report one,
        // and no amount of better reading will find it. A deck that does mention one and still gives nothing
        // is a reading problem, and those are the ones a model pass should be aimed at.
        if (mentioned) mentionedCount++;
        noFigure++;
        markSeen(db, p.id, "no_order_book", mentioned ? "mentions one, no figure could be read" : "does not report one");
        console.log(`${label} ${mentioned ? "mentions an order book, no figure read" : "does not report an order book"}`);
        continue;
      }
      // A deck filed in September can still report the June quarter. Where it does not say, the quarter that
      // ended just before it is taken as the date - but only when the deck followed that quarter closely
      // enough to be reporting on it; otherwise the filing date stands and the reading stays out of the growth.
      const inferred = hit.asOf ? null : quarterBefore(p.filedAt);
      const asOf = hit.asOf ?? inferred ?? p.filedAt.slice(0, 10);
      found.push({
        id: p.id, symbol: resolveSymbol(db, p.company, p.symbol), scripCd: p.scripCd, company: p.company,
        asOf, asOfStated: Boolean(hit.asOf || inferred), orderBookCr: hit.valueCr, filedAt: p.filedAt.slice(0, 10), phrase: hit.phrase, pdfUrl: p.pdfUrl,
        readBy, confidence: readBy === "model" ? 0.7 : hit.asOf ? 0.8 : 0.6,
      });
      markSeen(db, p.id, "read", `${hit.valueCr} cr as on ${asOf}`);
      console.log(`${label} INR ${hit.valueCr.toLocaleString("en-IN")} cr as on ${asOf}${hit.asOf ? "" : inferred ? " (no date in the deck; the quarter that ended just before it)" : " (no date in the deck - the filing date stands in)"}${readBy === "model" ? " (read by the model)" : ""}`);
    } catch (e) {
      markSeen(db, p.id, "failed", (e as Error).message.slice(0, 200));
      console.log(`${label} could not read: ${(e as Error).message.slice(0, 60)}`);
    }
  }
  save(db, found);
  console.log(`\n${found.length} order book${found.length === 1 ? "" : "s"} read, ${noFigure} decks stated none, ${unreadable} unreadable`);
  db.close();
}

void main();
