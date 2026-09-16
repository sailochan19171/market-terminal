// Prints the valuation of a few companies, to sanity-check the models against known figures (read-only).
import { Db } from "../src/server/db";
import { valuation } from "../src/server/research/valuation";

const db = new Db({ kind: "local", readOnly: true });
for (const sym of process.argv.slice(2).length ? process.argv.slice(2) : ["RELIANCE", "TCS", "HDFCBANK", "ITC", "ZENTEC"]) {
  const v = valuation(db, sym);
  console.log(`\n=== ${v.symbol} (${v.company ?? "?"}) ${v.kind}`);
  console.log(`price ₹${v.price.close} (${v.price.session}) | fair value ₹${v.fairValue} | range ₹${v.range.bear}–₹${v.range.bull} | MoS ${v.marginOfSafety}% | ${v.status} | confidence ${v.confidence}`);
  console.log("inputs:", JSON.stringify(v.inputs));
  for (const m of v.models) console.log(`  ${m.key.padEnd(12)} ${m.fairValue === null ? `— (${m.unavailable})` : `₹${String(m.fairValue).padStart(9)}  w=${m.weight}  ${m.basis}`}`);
  console.log("  history:", JSON.stringify({ medianPe: v.history.medianPe, min: v.history.minPe, max: v.history.maxPe, percentile: v.history.percentile, points: v.history.points.length }));
  console.log("  peers:", JSON.stringify(v.peers));
  for (const r of v.reasons) console.log("  + " + r);
  for (const c of v.cautions) console.log("  ! " + c);
}
db.close();
