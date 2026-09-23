// Push the announcement history that the old two-year publish window left behind.
//
// The normal publish only sends rows written since its last mark, so filings fetched long ago are past that
// mark and would never be sent once the window was lifted. This copies them across directly, oldest first, in
// batches, and can be re-run safely: every row is keyed by its announcement id.
//   npx tsx --env-file=../.env scripts/publish-history.ts [batch]
import { Db, type Row } from "../src/server/db";

const BATCH = Number(process.argv[2] ?? 1000);

interface Table { name: string; dateColumn: string }
const TABLES: Table[] = [
  { name: "announcement", dateColumn: "news_dt" },
  { name: "nse_announcement", dateColumn: "ann_dt" },
];

async function main() {
  const local = new Db();
  const remote = new Db({ kind: "remote", url: process.env.TURSO_DATABASE_URL ?? "", token: process.env.TURSO_AUTH_TOKEN ?? "" });

  for (const t of TABLES) {
    const here = Number(local.scalar<number>(`SELECT COUNT(*) FROM ${t.name}`) ?? 0);
    const there = Number(remote.scalar<number>(`SELECT COUNT(*) FROM ${t.name}`) ?? 0);
    console.log(`\n${t.name}: ${here.toLocaleString("en-IN")} here, ${there.toLocaleString("en-IN")} hosted`);
    if (here <= there) { console.log("  nothing older to send"); continue; }

    // The rows the hosted copy is missing are the oldest ones: walk from the oldest date forward.
    const oldestThere = remote.scalar<string>(`SELECT MIN(${t.dateColumn}) FROM ${t.name}`) ?? "9999";
    console.log(`  hosted history starts at ${String(oldestThere).slice(0, 10)}; sending everything before that`);

    let sent = 0, from = "";
    for (;;) {
      const rows = local.all<Row>(
        `SELECT * FROM ${t.name} WHERE ${t.dateColumn} < ? AND ${t.dateColumn} > ? ORDER BY ${t.dateColumn} LIMIT ?`,
        [oldestThere, from, BATCH]);
      if (!rows.length) break;
      remote.upsert(t.name, rows as unknown as Record<string, unknown>[]);
      sent += rows.length;
      from = String(rows[rows.length - 1][t.dateColumn]);
      process.stdout.write(`\r  sent ${sent.toLocaleString("en-IN")} rows (through ${from.slice(0, 10)})   `);
    }
    console.log(`\n  done: ${sent.toLocaleString("en-IN")} rows; hosted now holds ${Number(remote.scalar<number>(`SELECT COUNT(*) FROM ${t.name}`) ?? 0).toLocaleString("en-IN")}`);
  }

  local.close();
  remote.close();
}

main();
