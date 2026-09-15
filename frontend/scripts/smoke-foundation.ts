import { getDb, now } from "../src/server/db";
import { NSEClient } from "../src/server/nse/client";
import { BSEClient } from "../src/server/bse/client";

async function main() {
  const db = getDb();
  console.log("now", now());
  console.log("metrics", db.scalar("SELECT COUNT(*) FROM company_metrics"));
  console.log("row", db.get("SELECT symbol, close, pe FROM company_metrics WHERE symbol = ?", ["TCS"]));
  const t = Date.now();
  for (let i = 0; i < 200; i++) db.get("SELECT close FROM company_metrics WHERE symbol = ?", ["INFY"]);
  console.log("200 cached queries", Date.now() - t, "ms");

  const nse = new NSEClient({ rps: 2 });
  const holdings = await nse.api<unknown[]>("corporate-share-holdings-master", { index: "equities", symbol: "ITC" });
  console.log("nse api rows", Array.isArray(holdings) ? holdings.length : holdings);
  const blob = await nse.archive("/content/equities/EQUITY_L.csv");
  console.log("nse archive bytes", blob.byteLength);
  const bse = new BSEClient();
  const idx = await bse.api<{ Table?: unknown[] }>("IndexArchDaily/w", { fmdt: "11/09/2026", todt: "11/09/2026", index: 16, period: "D" });
  console.log("bse api", JSON.stringify(idx).slice(0, 80));
}
main().catch((e) => { console.error(e); process.exit(1); });
