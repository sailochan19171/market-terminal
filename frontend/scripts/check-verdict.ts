// Pins the valuation verdict to the worked examples in the product spec, then runs it against real companies.
//
// The spec's acceptance criterion is that the recomputation is deterministic and reproduces the examples to two
// decimals, so these are assertions, not printouts: if the formula drifts, this fails.
import { Db } from "../src/server/db";
import { combine, graham, lynch, peg } from "../src/lib/valuationMath";
import { valuationVerdict } from "../src/server/research/verdict";

let failures = 0;
function eq(label: string, got: unknown, want: unknown) {
  const ok = got === want;
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}: ${got}${ok ? "" : ` (expected ${want})`}`);
}

console.log("Worked example 1 - spec §3.3, illustrative inputs: price 3657, growth 10.69%, yield 1.6%, P/E 27.17");
{
  const r = lynch({ price: 3657, epsTtm: 3657 / 27.17, pe: 27.17, growthPct: 10.69, dividendYieldPct: 1.6 });
  eq("Lynch ratio", r.ratio, 0.45);
  eq("verdict", r.verdict, "Overvalued");
  eq("fair value (rounded to the rupee)", Math.round(r.fairValue!), 1654);
  eq("PEGY is the reciprocal", r.pegy, 2.21);
}

console.log("\nWorked example 2 - spec §3.3: price 2200.80, P/E 16.0, yield 2.95%, growth 5.3%");
{
  const r = lynch({ price: 2200.8, epsTtm: 2200.8 / 16, pe: 16, growthPct: 5.3, dividendYieldPct: 2.95 });
  eq("Lynch ratio", r.ratio, 0.52);
  eq("verdict", r.verdict, "Overvalued");
  eq("fair value (rounded to the rupee)", Math.round(r.fairValue!), 1135);
}

console.log("\nWorked example 3 - same price on 1.1% EPS growth");
{
  const r = lynch({ price: 2200.8, epsTtm: 2200.8 / 16, pe: 16, growthPct: 1.1, dividendYieldPct: 2.95 });
  eq("Lynch ratio", r.ratio, 0.25);
  eq("fair value (rounded to the rupee)", Math.round(r.fairValue!), 557);
}

console.log("\nBand boundaries - spec §3.2");
{
  const at = (ratio: number) => lynch({ price: 100, epsTtm: 10, pe: 10, growthPct: ratio * 10, dividendYieldPct: 0 }).verdict;
  eq("0.99", at(0.99), "Overvalued");
  eq("1.00", at(1.0), "Fairly valued");
  eq("1.50", at(1.5), "Fair to attractive");
  eq("2.00", at(2.0), "Undervalued");
}

console.log("\nEdge cases - spec §3.5");
{
  eq("loss-maker is suppressed", lynch({ price: 100, epsTtm: -4, pe: null, growthPct: 12, dividendYieldPct: 0 }).verdict, "Not applicable");
  eq("zero dividend still computes", lynch({ price: 100, epsTtm: 5, pe: 20, growthPct: 20, dividendYieldPct: 0 }).ratio, 1);
  eq("shrinking earnings are suppressed", lynch({ price: 100, epsTtm: 5, pe: 20, growthPct: -8, dividendYieldPct: 2 }).verdict, "Not applicable");
  eq("missing growth is suppressed", lynch({ price: 100, epsTtm: 5, pe: 20, growthPct: null, dividendYieldPct: 2 }).applicable, false);
  eq("Graham number", graham(10, 90), 142.3); // sqrt(22.5 x 10 x 90) = sqrt(20250)
  eq("Graham needs a positive book value", graham(10, -5), null);
  eq("PEG", peg(30, 15), 2);
  eq("combined headline", combine(["Overvalued", "Overvalued", "Fairly valued", "Undervalued", null]).summary, "2 of 4 models screen overvalued");
}

const symbols = process.argv.slice(2).length ? process.argv.slice(2) : ["TCS", "HDFCBANK", "ITC", "TATASTEEL"];
const db = new Db({ kind: "local", readOnly: true });
for (const sym of symbols) {
  const v = valuationVerdict(db, sym);
  console.log(`\n================ ${v.company ?? sym} (${v.symbol}) · ${v.kind}`);
  console.log(`price ₹${v.inputs.price ?? "—"} (${v.price?.source ?? "no quote"}) · P/E ${v.inputs.pe ?? "—"} · EPS ${v.inputs.epsTtm ?? "—"} · yield ${v.inputs.dividendYieldPct}%`);
  console.log(`growth ${v.inputs.growthPct ?? "—"}% on the ${v.inputs.growthBasis} basis${v.inputs.growthCapped ? " (capped)" : ""}`);
  console.log(`LYNCH  ${v.lynch.verdict}${v.lynch.applicable ? ` · ratio ${v.lynch.ratio} · fair value ₹${v.lynch.fairValue}` : ""}`);
  console.log(`COMBINED  ${v.combined.summary}`);
  for (const mdl of v.models) console.log(`  ${(mdl.verdict ?? "n/a").padEnd(18)} ${mdl.label}: ${mdl.unavailable ?? mdl.reading}`);
  for (const c of v.caveats) console.log(`  ! ${c}`);
}
db.close();

console.log(failures ? `\n${failures} assertion(s) failed` : "\nAll spec assertions passed");
process.exit(failures ? 1 : 0);
