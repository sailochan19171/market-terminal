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
import { ensureSchema, markSeen, ORDER_BOOK_INDUSTRIES, orderBookFromText, presentations, save, type OrderBookRow } from "../src/server/orders/orderBook";
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
  let unreadable = 0, noFigure = 0, mentioned = 0;
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
      let hit = orderBookFromText(text);
      let readBy: "rules" | "model" = "rules";
      // A pattern reading that is absurd against the company's own sales is a misread, not a small order book.
      // Kalpataru Projects came back as 64 crore against twenty thousand crore of revenue, because the deck's
      // layout put another number next to the words. The model is asked to read those again.
      if (hit && useModel && implausible(db, p.symbol, hit.valueCr)) {
        const second = await orderBookFromModel(text, p.company);
        console.log(`${label} ${hit.valueCr} cr looks wrong against this company's sales; ${second ? `the model reads ${second.valueCr} cr` : "the model could not read it either, so nothing is stored"}`);
        hit = second;
        readBy = "model";
      }
      // The patterns handle a deck that writes "Order Book: Rs. 1,854 Cr" in one line. Where the deck mentions
      // an order book and the patterns cannot pick the figure out of the jumble, the model reads the excerpt.
      if (!hit && useModel && /order\s*book/i.test(text)) {
        const fromModel = await orderBookFromModel(text, p.company);
        if (fromModel) { hit = fromModel; readBy = "model"; }
      }
      if (!hit) {
        // Worth separating: a deck that never mentions an order book is a company that does not report one,
        // and no amount of better reading will find it. A deck that does mention one and still gives nothing
        // is a reading problem, and those are the ones a model pass should be aimed at.
        const mentions = /order\s*book/i.test(text);
        if (mentions) mentioned++;
        noFigure++;
        markSeen(db, p.id, "no_order_book", mentions ? "mentions one, no figure could be read" : "does not report one");
        console.log(`${label} ${mentions ? "mentions an order book, no figure read" : "does not report an order book"}`);
        continue;
      }
      // A deck filed in September can still report the June quarter; where it does not say, the filing date stands.
      const asOf = hit.asOf ?? p.filedAt.slice(0, 10);
      found.push({
        id: p.id, symbol: resolveSymbol(db, p.company, p.symbol), scripCd: p.scripCd, company: p.company,
        asOf, asOfStated: Boolean(hit.asOf), orderBookCr: hit.valueCr, filedAt: p.filedAt.slice(0, 10), phrase: hit.phrase, pdfUrl: p.pdfUrl,
        readBy, confidence: readBy === "model" ? 0.7 : hit.asOf ? 0.8 : 0.6,
      });
      markSeen(db, p.id, "read", `${hit.valueCr} cr as on ${asOf}`);
      console.log(`${label} INR ${hit.valueCr.toLocaleString("en-IN")} cr as on ${asOf}${hit.asOf ? "" : " (no date in the deck - the filing date stands in)"}${readBy === "model" ? " (read by the model)" : ""}`);
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
