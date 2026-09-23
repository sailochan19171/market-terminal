// The ratio engine, tested two ways (spec §10).
//
// First against hand-made figures, where every answer is known and the null cases can be pinned: a missing
// denominator must produce a null with a reason, never a zero and never an infinity. Then against real companies
// on file, printed so the numbers can be read against the published accounts.
//   npm run check:ratios            — the unit tests
//   npm run check:ratios RELIANCE   — plus a printout for those symbols
import { Db } from "../src/server/db";
import { ratioReport } from "../src/server/agents/ratios";
import { loadRawData } from "../src/server/agents/data";
import type { AnnualFigures, RawData } from "../src/server/agents/state";

let failed = 0;
function eq(what: string, got: unknown, want: unknown, tolerance = 0.0001) {
  const ok = typeof got === "number" && typeof want === "number"
    ? Math.abs(got - want) <= tolerance * Math.max(1, Math.abs(want))
    : got === want;
  if (!ok) failed++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}: ${JSON.stringify(got)}${ok ? "" : ` (expected ${JSON.stringify(want)})`}`);
}

/** A year of accounts with everything present, so each test can knock out one field at a time. */
function year(n: number, over: Partial<AnnualFigures> = {}): AnnualFigures {
  return {
    year: n, periodEnd: `${n}-03-31`, consolidated: true,
    revenue: 1000, costOfGoodsSold: 600, grossProfit: 400, operatingIncome: 200, ebit: 200, ebitda: 250,
    interestExpense: 20, taxExpense: 45, netIncome: 135, epsDiluted: 13.5, sharesDiluted: 10, depreciation: 50,
    cash: 100, receivables: 150, inventory: 120, currentAssets: 400, totalAssets: 1200, payables: 90,
    currentLiabilities: 250, totalDebt: 300, totalLiabilities: 500, shareholdersEquity: 700,
    operatingCashFlow: 180, capitalExpenditure: -60, dividendsPaid: -40,
    netInterestIncome: null, interestEarningAssets: null, advances: null, deposits: null,
    otherIncome: 0, operatingExpenses: null, sources: {},
    ...over,
  };
}

function raw(annual: AnnualFigures[], over: Partial<RawData> = {}): RawData {
  return {
    symbol: "TEST", company: "Test Ltd", market: "IN", currency: "INR", exchange: "NSE", ticker: "TEST.NS", fiscalYearEnd: "03-31", quarterly: [], ttm: null, industry: null, sectorSet: "standard",
    quote: null, marketCap: null, sharesOutstanding: 10, referencePe: null, bookValuePerShare: 70, dividendPerShare: 4,
    annual, prices: [], yearEndPrices: {}, peerMultiples: { count: 0, pe: null, pb: null }, filings: [], peers: [], fetchedAt: new Date().toISOString(), sources: [], unavailable: [],
    ...over,
  };
}

const db = new Db({ kind: "local", readOnly: true });
const find = (r: ReturnType<typeof ratioReport>, key: string) => Object.values(r.categories).map((c) => c[key]).find(Boolean);

console.log("Profitability, on figures whose answers are known");
{
  const r = ratioReport(db, raw([year(2025), year(2026)]));
  eq("gross margin 400/1000", find(r, "grossMargin")?.latest, 0.4);
  eq("operating margin 200/1000", find(r, "operatingMargin")?.latest, 0.2);
  eq("net margin 135/1000", find(r, "netMargin")?.latest, 0.135);
  eq("EBITDA margin 250/1000", find(r, "ebitdaMargin")?.latest, 0.25);
  eq("ROE uses the average equity, not the closing one", find(r, "roe")?.latest, 135 / 700);
  eq("ROA 135/1200", find(r, "roa")?.latest, 135 / 1200);
  eq("ROCE 200/(1200-250)", find(r, "roce")?.latest, 200 / 950);
  eq("interest coverage 200/20", find(r, "interestCoverage")?.latest, 10);
  eq("debt to equity 300/700", find(r, "debtToEquity")?.latest, 300 / 700);
  eq("net debt to EBITDA (300-100)/250", find(r, "netDebtToEbitda")?.latest, 0.8);
  eq("current ratio 400/250", find(r, "currentRatio")?.latest, 1.6);
  eq("quick ratio (400-120)/250", find(r, "quickRatio")?.latest, 1.12);
  eq("free cash flow 180-60", find(r, "freeCashFlow")?.latest, 120);
  eq("cash conversion 180/135", find(r, "cashConversion")?.latest, 180 / 135);
  eq("payout ratio 40/135", find(r, "payoutRatio")?.latest, 40 / 135);
  eq("every figure keeps its inputs", JSON.stringify(find(r, "netMargin")?.series.at(-1)?.inputs), JSON.stringify({ net_income: 135, revenue: 1000 }));
  eq("and its formula id", find(r, "netMargin")?.formulaId, "net_margin_v1");
}

console.log("\nAverage balances: the second year averages the opening and closing figure");
{
  const r = ratioReport(db, raw([year(2025, { totalAssets: 1000 }), year(2026, { totalAssets: 1400 })]));
  eq("ROA on the average of 1000 and 1400", find(r, "roa")?.latest, 135 / 1200);
  eq("asset turnover likewise", find(r, "assetTurnover")?.latest, 1000 / 1200);
}

console.log("\nMissing and impossible denominators produce a null with a reason (spec §4.1)");
{
  const r = ratioReport(db, raw([year(2025), year(2026, { revenue: null })]));
  eq("no revenue: null", find(r, "netMargin")?.latest, null);
  eq("and the reason is recorded", find(r, "netMargin")?.series.at(-1)?.reason, "missing_input");
  eq("the report lists it as unavailable", r.unavailable.some((u) => u.key === "netMargin"), true);
}
{
  const r = ratioReport(db, raw([year(2025), year(2026, { revenue: 0 })]));
  eq("zero revenue is not an infinity", find(r, "netMargin")?.latest, null);
  eq("it says zero_denominator", find(r, "netMargin")?.series.at(-1)?.reason, "zero_denominator");
}
{
  const r = ratioReport(db, raw([year(2025, { shareholdersEquity: -100 }), year(2026, { shareholdersEquity: -200 })]));
  eq("negative equity suppresses ROE", find(r, "roe")?.latest, null);
  eq("with the reason named", find(r, "roe")?.series.at(-1)?.reason, "negative_equity");
  eq("and suppresses debt to equity too", find(r, "debtToEquity")?.latest, null);
}
{
  const r = ratioReport(db, raw([year(2025), year(2026, { inventory: null })]));
  eq("a service company has no inventory turnover", find(r, "inventoryTurnover")?.latest, null);
  eq("and says so rather than reporting zero", find(r, "inventoryTurnover")?.series.at(-1)?.reason, "missing_inventory");
}

console.log("\nGrowth (spec §4.3)");
{
  const years = [2021, 2022, 2023, 2024, 2025, 2026].map((y, i) => year(y, { revenue: 1000 * 1.1 ** i, epsDiluted: 13.5 * 1.1 ** i }));
  const r = ratioReport(db, raw(years));
  eq("revenue CAGR over 5 years of 10% compounding", find(r, "revenueCagr5y")?.latest, 0.1, 0.001);
  eq("EPS CAGR the same", find(r, "epsCagr5y")?.latest, 0.1, 0.001);
  eq("10-year CAGR is unavailable on six years", find(r, "revenueCagr10y")?.latest, null);
  eq("and says why", find(r, "revenueCagr10y")?.series.at(-1)?.reason, "insufficient_history");
}
{
  const r = ratioReport(db, raw([year(2021, { revenue: -50 }), year(2022), year(2023), year(2024)]));
  eq("a loss-making base gives no CAGR", find(r, "revenueCagr3y")?.latest, null);
  eq("because the base is not positive", find(r, "revenueCagr3y")?.series.at(-1)?.reason, "non_positive_base");
}

console.log("\nValuation (spec §4.3)");
{
  const years = [2022, 2023, 2024, 2025, 2026, 2027].map((y, i) => year(y, { epsDiluted: 10 * 1.15 ** i }));
  const r = ratioReport(db, raw(years, { marketCap: 2000, quote: { lastPrice: 200, changeAbs: 0, changePct: 0, asOfTimestamp: "", source: "test", isLive: false, currency: "INR" } }));
  eq("P/E 200 / 20.11", find(r, "pe")?.latest, 200 / (10 * 1.15 ** 5), 0.001);
  eq("P/B 200/70", find(r, "pb")?.latest, 200 / 70);
  eq("dividend yield 4/200", find(r, "dividendYield")?.latest, 0.02);
  eq("free cash flow yield 120/2000", find(r, "fcfYield")?.latest, 0.06);
  eq("PEG is P/E over growth in whole numbers", find(r, "peg")?.latest, (200 / (10 * 1.15 ** 5)) / 15, 0.01);
}
{
  const r = ratioReport(db, raw([year(2025), year(2026, { epsDiluted: -3 })], { quote: { lastPrice: 200, changeAbs: null, changePct: null, asOfTimestamp: null, source: "test", isLive: false, currency: "INR" } }));
  eq("a loss-maker has no P/E", find(r, "pe")?.latest, null);
  eq("and it says negative_earnings", find(r, "pe")?.series.at(-1)?.reason, "negative_earnings");
  eq("nor a PEG", find(r, "peg")?.latest, null);
}

console.log("\nCurrencies are never mixed inside a ratio (spec §5.4)");
{
  const r = ratioReport(db, raw([year(2025), year(2026)], { quote: { lastPrice: 20, changeAbs: null, changePct: null, asOfTimestamp: null, source: "test", isLive: false, currency: "USD" } }));
  eq("a dollar price against rupee accounts gives no P/E", find(r, "pe")?.latest, null);
  eq("and says why", find(r, "pe")?.series.at(-1)?.reason, "currency_mismatch");
}
{
  const r = ratioReport(db, raw([year(2025), year(2026)], { ttm: year(2027, { revenue: 2000, netIncome: 300 }) }));
  eq("trailing twelve months are computed beside the annual series", find(r, "netMargin")?.ttm?.value, 0.15);
}

console.log("\nA lender gets the financial set and not the industrial one (spec §4.2, §4.4)");
{
  const bank = (y: number) => year(y, {
    revenue: 1000, netInterestIncome: 400, interestEarningAssets: 9000, advances: 7000, deposits: 8000,
    otherIncome: 100, operatingExpenses: 200, inventory: null,
  });
  const r = ratioReport(db, raw([bank(2025), bank(2026)], { sectorSet: "financial" }));
  eq("net interest margin 400/9000", find(r, "netInterestMargin")?.latest, 400 / 9000);
  eq("cost to income 200/(400+100)", find(r, "costToIncome")?.latest, 0.4);
  eq("credit to deposit 7000/8000", find(r, "creditToDeposit")?.latest, 0.875);
  eq("no current ratio for a bank", find(r, "currentRatio"), undefined);
  eq("no inventory turnover either", find(r, "inventoryTurnover"), undefined);
  eq("and no Altman Z", r.qualityScores.altmanZ.score, null);
  const ind = ratioReport(db, raw([year(2025), year(2026)]));
  eq("an industrial gets no net interest margin", find(ind, "netInterestMargin"), undefined);
}

console.log("\nQuality scores (spec §4.6)");
{
  const r = ratioReport(db, raw([year(2025), year(2026)]));
  const d = r.qualityScores.dupont.at(-1)!;
  eq("DuPont multiplies back to ROE", (d.netMargin! * d.assetTurnover! * d.equityMultiplier!), d.roe!);
  eq("DuPont ROE matches the direct one", d.roe, find(r, "roe")?.latest, 0.0001);
  eq("Piotroski scores nine tests", r.qualityScores.piotroski.tests.length, 9);
  eq("Altman Z needs a market cap", r.qualityScores.altmanZ.score, null);
}
{
  // Improving on every count: profit up, debt down, margins up, no new shares.
  const before = year(2025, { netIncome: 100, operatingCashFlow: 120, totalDebt: 400, currentAssets: 300, grossProfit: 300, revenue: 1000, totalAssets: 1200 });
  const after = year(2026, { netIncome: 150, operatingCashFlow: 200, totalDebt: 300, currentAssets: 450, grossProfit: 420, revenue: 1200, totalAssets: 1250 });
  const r = ratioReport(db, raw([before, after]));
  eq("a company improving on every count scores 9", r.qualityScores.piotroski.score, 9);
}
{
  const r = ratioReport(db, raw([year(2026)]));
  eq("one year is not enough for Piotroski", r.qualityScores.piotroski.score, null);
  eq("nor for Beneish", r.qualityScores.beneishM.score, null);
  eq("and Beneish says why", r.qualityScores.beneishM.reason, "needs two consecutive years");
}
{
  const clean = ratioReport(db, raw([year(2025), year(2026)]));
  eq("steady books do not raise the Beneish flag", clean.qualityScores.beneishM.flag, false);
  // Receivables tripling while cash flow falls behind profit is what the model is built to catch.
  const cooked = ratioReport(db, raw([
    year(2025, { receivables: 100, netIncome: 100, operatingCashFlow: 110 }),
    year(2026, { receivables: 400, netIncome: 200, operatingCashFlow: 20, revenue: 1100 }),
  ]));
  eq("books stuffed with receivables do", cooked.qualityScores.beneishM.flag, true);
}

console.log("\nTrend labels (spec §4.5)");
{
  const rising = [2022, 2023, 2024, 2025, 2026].map((y, i) => year(y, { netIncome: 100 + i * 30 }));
  eq("rising margins read as improving", find(ratioReport(db, raw(rising)), "netMargin")?.trend, "improving");
  const falling = [2022, 2023, 2024, 2025, 2026].map((y, i) => year(y, { netIncome: 220 - i * 30 }));
  eq("falling margins read as declining", find(ratioReport(db, raw(falling)), "netMargin")?.trend, "declining");
  const flat = [2022, 2023, 2024, 2025, 2026].map((y) => year(y));
  eq("flat margins read as stable", find(ratioReport(db, raw(flat)), "netMargin")?.trend, "stable");
  const risingDebt = [2022, 2023, 2024, 2025, 2026].map((y, i) => year(y, { totalDebt: 100 + i * 80 }));
  eq("rising debt reads as declining, because less is better", find(ratioReport(db, raw(risingDebt)), "debtToEquity")?.trend, "declining");
}

// --- real companies, printed for reading against the published accounts -------------------

for (const sym of process.argv.slice(2)) {
  const data = loadRawData(db, sym);
  const r = ratioReport(db, data);
  console.log(`\n=== ${r.symbol} (${r.company ?? "?"}) — ${r.sectorSet} set, ${r.industry ?? "no industry"}, ${r.years.length} years ${r.years[0] ?? "?"}–${r.years.at(-1) ?? "?"}`);
  for (const [category, ratios] of Object.entries(r.categories)) {
    const line = Object.entries(ratios)
      .map(([k, s]) => {
        if (s.latest === null) return null;
        const v = s.unit === "percent" ? `${(s.latest * 100).toFixed(1)}%` : s.unit === "currency" ? `₹${(s.latest / 1e7).toFixed(0)}cr` : s.latest.toFixed(2);
        const extra = [s.trend, s.percentileInSector !== null ? `p${s.percentileInSector}` : null].filter(Boolean).join(" ");
        return `${k}=${v}${extra ? `(${extra})` : ""}`;
      })
      .filter(Boolean);
    if (line.length) console.log(`  ${category.padEnd(15)} ${line.join("  ")}`);
  }
  const q = r.qualityScores;
  console.log(`  quality         piotroski=${q.piotroski.score ?? "—"}/9  altmanZ=${q.altmanZ.score?.toFixed(2) ?? `— (${q.altmanZ.reason})`} ${q.altmanZ.zone ?? ""}  beneishM=${q.beneishM.score?.toFixed(2) ?? "—"}${q.beneishM.flag ? " FLAG" : ""}`);
  console.log(`  scores          ${JSON.stringify(r.categoryScores)}  peers=${r.peers.count}`);
  const missing = r.unavailable.filter((u) => !/^(gross_npa|net_npa|provision|capital_adeq|casa)/.test(u.key));
  if (missing.length) console.log(`  unavailable     ${missing.slice(0, 8).map((u) => `${u.key} (${u.reason})`).join("; ")}`);
}

db.close();
console.log(failed ? `\n${failed} check${failed === 1 ? "" : "s"} failed` : "\nAll checks passed");
process.exit(failed ? 1 : 0);
