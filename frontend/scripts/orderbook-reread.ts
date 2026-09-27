// Forget the order books read under an older rule, so the decks are read again.
//
//   npx tsx scripts/orderbook-reread.ts [model|all]
//
// The readings themselves go, and so do the "already looked at" marks for those decks, but only for decks that
// produced a figure: a deck that reports no order book reports none however it is read, and re-downloading a
// hundred pages to learn that again is waste.
import { Db } from "../src/server/db";
import { ensureSchema } from "../src/server/orders/orderBook";

const which = process.argv[2] === "all" ? "all" : "model";

const db = new Db();
ensureSchema(db);
const where = which === "all" ? "" : " WHERE read_by = 'model'";
const rows = db.all<{ id: string; company: string | null; order_book_cr: number }>(`SELECT id, company, order_book_cr FROM company_order_book${where}`);
for (const r of rows) console.log(`  forgetting ${r.company ?? r.id}: ${r.order_book_cr} cr`);
for (const r of rows) {
  db.run("DELETE FROM company_order_book WHERE id = ?", [r.id]);
  db.run("DELETE FROM company_order_book_seen WHERE id = ?", [r.id]);
}
console.log(`\n${rows.length} reading${rows.length === 1 ? "" : "s"} forgotten (${which === "all" ? "every reading" : "those the model read"}); the decks will be read again on the next backfill`);
db.close();
