// Read the order-win filings of the last N days into company_order.
//   npx tsx --env-file=.env.local scripts/orders-backfill.ts [days] [limit]
//   npx tsx --env-file=.env.local scripts/orders-backfill.ts repair   - read again the filings that were read
//                                                                      by the rules alone (the model was busy)
import { Db, type Row } from "../src/server/db";
import { candidates, readOne, runOrders } from "../src/server/orders/extract";
import { coverage } from "../src/server/orders/store";

/** Filings whose figures came from the rules alone, read again now that the model has room. */
async function repair(db: Db) {
  const ids = new Set(db.all<Row>("SELECT id FROM company_order WHERE extracted_by = 'rules'").map((r) => String(r.id)));
  const todo = candidates(db, { days: 400, limit: 5000, redo: true }).filter((c) => ids.has(c.id));
  console.log(`${todo.length} filings were read by the rules alone; reading them again with the model`);
  let done = 0;
  for (const c of todo) {
    const row = await readOne(db, c);
    done += row?.extractedBy === "model" ? 1 : 0;
  }
  console.log(`read again with the model: ${done} of ${todo.length}`);
}

/** Filings whose customer is still empty, read again - with the model where it has quota left. */
async function customers(db: Db) {
  const missing = new Set(db.all<Row>("SELECT id FROM company_order WHERE customer IS NULL").map((r) => String(r.id)));
  const todo = candidates(db, { days: 400, limit: 5000, redo: true }).filter((c) => missing.has(c.id));
  console.log(`${todo.length} filings have no customer; reading them again`);
  let filled = 0;
  for (const c of todo) {
    const row = await readOne(db, c);
    if (row?.customer) filled++;
  }
  console.log(`customers found: ${filled} of ${todo.length}`);
}

async function main() {
  if (process.argv[2] === "customers") {
    const db = new Db();
    await customers(db);
    console.log("coverage:", coverage(db));
    db.close();
    return;
  }
  if (process.argv[2] === "repair") {
    const db = new Db();
    await repair(db);
    console.log("coverage:", coverage(db));
    db.close();
    return;
  }
  const days = Number(process.argv[2] ?? 45);
  const limit = Number(process.argv[3] ?? 250);
  const db = new Db();
  const r = await runOrders(db, { days, limit, concurrency: 2, deadlineMs: 75 * 60_000 });
  console.log("run:", r, "coverage:", coverage(db));
  db.close();
}
main();
