// Saves real company data as fixtures for the graph integration test (spec §10.1: saved fixtures in tests/fixtures/).
//   npx tsx scripts/save-fixtures.ts
import { writeFileSync } from "node:fs";
import { Db } from "../src/server/db";
import { loadRawData } from "../src/server/agents/data";
import { loadUs, usListings } from "../src/server/agents/providers/us";

async function main() {
  const db = new Db({ kind: "local", readOnly: true });
  const trim = <T extends { prices: { t: string; c: number }[] }>(r: T) => ({ ...r, prices: r.prices.slice(-800) });
  writeFileSync("tests/fixtures/raw-IN-ITC.json", JSON.stringify(trim(loadRawData(db, "ITC", 10))));
  writeFileSync("tests/fixtures/raw-US-AAPL.json", JSON.stringify(trim(await loadUs(db, "AAPL", 10))));
  const listings = (await usListings()).filter((l) => ["AAPL", "APLE", "MSFT", "JPM", "ACN", "INFY", "HDB", "KO"].includes(l.ticker));
  writeFileSync("tests/fixtures/us-listings.json", JSON.stringify(listings));
  db.close();
  console.log("saved");
}
void main();
