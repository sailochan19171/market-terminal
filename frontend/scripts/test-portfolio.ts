// Portfolio import smoke test against a throwaway database (never the real one).
//   BSE_DB_PATH=<tmp>/pf.db npx tsx scripts/test-portfolio.ts
import fs from "node:fs";
import path from "node:path";
import { openDb, init } from "../src/server/db";
import { ensureSchema as ensureMetrics } from "../src/server/core/metrics";
import { parseCas } from "../src/server/core/cas";
import { importCasData, importCsv, latestSnapshot } from "../src/server/core/portfolio";
import { portfolio, watchlistAdd, watchlistGet, watchlistRemove } from "../src/server/api/legacy";

async function main() {
  if (!process.env.BSE_DB_PATH || path.resolve(process.env.BSE_DB_PATH).endsWith(path.join("data", "bse.db"))) throw new Error("set BSE_DB_PATH to a scratch database");
  const db = openDb();
  init(db);
  ensureMetrics(db);
  db.run("INSERT OR IGNORE INTO nse_symbol (symbol, company, series, isin, updated_at) VALUES ('INFY', 'Infosys Limited', 'EQ', 'INE009A01021', '2026-09-01')");
  const fx = path.join(__dirname, "..", "tests", "fixtures", "cas");
  for (const f of ["nsdl.pdf", "cdsl.pdf", "cams_detailed.pdf"]) {
    const data = await parseCas(new Uint8Array(fs.readFileSync(path.join(fx, f))), "ABCDE1234F");
    console.log(f, JSON.stringify(importCasData(db, data, f.replace(".pdf", ""))));
  }
  const csv = "Report generated on 01-09-2026\n\nInstrument,Qty.,Avg. cost,LTP,P&L\nINFY,10,\"1,450.50\",1500,495\nTotal,10,,,\n";
  console.log("csv", importCsv(db, csv, "zerodha"));
  const snap = latestSnapshot(db);
  console.log("snapshot rows", snap.length, snap[0]);
  const pf = portfolio(db);
  console.log("portfolio totals", pf.total_value, pf.total_cost, pf.gain_pct, pf.brokers);
  console.log("watch add", watchlistAdd(db, "t", { symbols: "infy, nosuch", exchange: "nse" }));
  console.log("watch get", watchlistGet(db, "t").watchlist.length);
  console.log("watch remove", watchlistRemove(db, "t", { symbol: "INFY", exchange: "NSE" }));
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
