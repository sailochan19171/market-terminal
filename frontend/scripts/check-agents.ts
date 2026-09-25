// The agent graph, checked (spec §10): guardrails, company resolution, intent, the validator's rules, number
// grounding, the compliance scrub, the persona files, the technical indicators - and, with --live, full requests
// through the graph with the configured model.
//   npm run check:agents              — no model calls
//   npm run check:agents -- --live    — plus end-to-end requests (uses model tokens)
import { readFileSync } from "node:fs";
import { Db } from "../src/server/db";
import { fieldMapping, parseYaml, personas, scoring, settings } from "../src/server/agents/config";
import { scrub, violations } from "../src/server/agents/compliance";
import { analyze, graphDiagram } from "../src/server/agents/graph";
import { findCompanies, readInput } from "../src/server/agents/input";
import { checkPlan } from "../src/server/agents/orchestrator";
import { rsi, sma, trendLabel } from "../src/server/agents/technical";
import { Trace } from "../src/server/agents/trace";
import { contradictions, numberPool, ungroundedNumbers, wrongComparisons } from "../src/server/agents/validator";
import { comparisonFacts } from "../src/server/agents/synthesis";
import { debate } from "../src/server/agents/debate";
import { dcf, justifiedPb, RANGES, valuationReport } from "../src/server/agents/valuation";
import { findUsCompanies } from "../src/server/agents/input";
import { setListingsForTests } from "../src/server/agents/providers/us";
import { ratioReport } from "../src/server/agents/ratios";
import { validateContract } from "../src/server/agents/schemas";
import { validate } from "../src/server/agents/validator";
import { technicalReport } from "../src/server/agents/technical";
import type { RawData } from "../src/server/agents/state";
import type { ChatOptions, Completion } from "../src/server/research/llm";
import { config } from "../src/server/config";

let failed = 0;
function eq(what: string, got: unknown, want: unknown, tolerance = 0.0001) {
  const ok = typeof got === "number" && typeof want === "number" ? Math.abs(got - want) <= tolerance * Math.max(1, Math.abs(want)) : JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}: ${JSON.stringify(got)}${ok ? "" : ` (expected ${JSON.stringify(want)})`}`);
}

const db = new Db({ kind: "local", readOnly: true });
const live = process.argv.includes("--live");

async function main() {
  console.log("Guardrails (spec §3.1): refused the same way every time");
  const trace = new Trace(null);
  for (const q of ["Will Reliance double by next year?", "What is the target price for TCS?", "Which penny stock will double my money?", "Give me guaranteed returns stocks", "Tell me a joke"]) {
    const r = await readInput(db, q, trace);
    eq(`"${q}" is refused`, r.isAllowed, false);
  }

  console.log("\nCompany resolution and intent");
  eq("a trading symbol", findCompanies(db, "Analyse RELIANCE").found.map((m) => m.symbol), ["RELIANCE"]);
  eq("a name in lower case", findCompanies(db, "analyse infosys for the long term").found.map((m) => m.symbol), ["INFY"]);
  eq("a possessive two-word name", findCompanies(db, "Is HDFC Bank's debt a concern?").found.map((m) => m.symbol), ["HDFCBANK"]);
  eq("two companies in order", findCompanies(db, "Compare TCS vs WIPRO").found.map((m) => m.symbol), ["TCS", "WIPRO"]);
  eq("an ordinary word is not a company", findCompanies(db, "what is the best idea here").found.length, 0);
  eq("a name several listings share asks which", Boolean(findCompanies(db, "analyse tata").ambiguous), true);
  eq("full analysis", (await readInput(db, "Analyse Infosys as a long-term investment", trace)).intent, "full_analysis");
  eq("single metric", (await readInput(db, "Is HDFC Bank's debt a concern?", trace)).intent, "single_metric");
  eq("comparison", (await readInput(db, "Compare TCS vs WIPRO", trace)).intent, "comparison");
  eq("explain a concept", (await readInput(db, "What is ROCE and why does it matter?", trace)).intent, "explain_concept");
  eq("a measure named like a company is still a concept", (await readInput(db, "What is DuPont analysis?", trace)).intent, "explain_concept");
  eq("the company in view is used when none is named", (await readInput(db, "How much debt does it carry?", trace, { symbol: "ITC" })).companies.map((c) => c.symbol), ["ITC"]);

  console.log("\nThe orchestrator's plan is checked against the registered workers (spec §3.2)");
  eq("a valid plan passes", checkPlan({ tasks: [{ worker: "ratio_engine", focus: ["profitability"] }, { worker: "valuation_agent" }], reasoning: "x" }).problems, []);
  eq("an invented worker is rejected", checkPlan({ tasks: [{ worker: "ratio_engine" }, { worker: "stock_picker" }] }).plan, null);
  eq("a plan without the ratio engine is rejected", checkPlan({ tasks: [{ worker: "technical_agent" }] }).plan, null);
  eq("not JSON at all is rejected", checkPlan("buy it").plan, null);

  console.log("\nNumber grounding (spec §8.1)");
  const pool = numberPool({ roe: 0.2153, price: 1432.5, marketCap: 9.69e12, pe: 24.36 });
  eq("a percentage from a decimal is grounded", ungroundedNumbers("ROE was 21.5%.", pool), []);
  eq("a rupee price is grounded", ungroundedNumbers("The price is ₹1,432.50.", pool), []);
  eq("crore from rupees is grounded", ungroundedNumbers("Market cap ₹9,69,000 Cr.", pool), []);
  eq("a multiple is grounded", ungroundedNumbers("P/E of 24.4x.", pool), []);
  eq("an invented figure is caught", ungroundedNumbers("Margins will reach 35.2% next year.", pool), ["35.2%"]);
  eq("years and small counts are not claims", ungroundedNumbers("In FY2025, 3 of 5 tests passed.", pool), []);

  console.log("\nComparison words must match the figures");
  eq("'exceeds' a larger median is caught", contradictions("Operating margin 22.6% exceeds sector peers 18.6% and the company's own 7-year median 23.7%.").length, 1);
  eq("'below' a smaller figure is caught", contradictions("Net profit margin 16.5% is declining from the 7-year median 17.2% and below sector peers 11.4%.").length, 1);
  eq("a correct 'above' passes", contradictions("Return on equity 35.0% is well above sector peers 15.8% and close to the 7-year median 35.2%.").length, 0);
  eq("mixed but correct directions pass", contradictions("Operating margin of 20.2% is below its own median 23.7% but above the sector median 18.6%.").length, 0);
  eq("a two-company sentence is read correctly", contradictions("Infosys has an ROE of 35.0% against Wipro's 15.2%, and a net margin of 16.5% above Wipro's 12.1%.").length, 0);
  // A list of separate points, and a sentence that moves on to another measure, are not contradictions. Each
  // wrongly flagged draft used to cost a second writing by the model, which is what ran the free tier dry.
  eq("a clause about another measure is judged on its own", contradictions("Accenture's price to earnings is 14.67x, lower than TCS 15.90x, and price to book is 3.75x, lower than TCS 7.38x.").length, 0);
  eq("two separate points on their own lines pass", contradictions("Operating margin 23.3% higher than the peer 14.7%.\nNet profit margin 18.4% higher than the peer 11.0%.").length, 0);

  console.log("\nCompliance (spec §8.3)");
  eq("a buy instruction is caught", violations("You should buy this stock now.").length > 0, true);
  eq("a target price is caught", violations("Our target price is 2,000.").length > 0, true);
  eq("impersonation is caught", violations("As Warren Buffett, I love this business.").length > 0, true);
  eq("a denial is allowed", violations("This is not a recommendation to buy or sell.").length, 0);
  eq("scrub removes only the offending sentence", scrub("Returns are high. You should buy this now. Debt is low.").text, "Returns are high. Debt is low.");

  console.log("\nPersonas are files (spec §3.9, §10.3)");
  const ids = personas().map((p) => p.id);
  eq("buffett and lynch load from config/personas", ["buffett", "lynch"].every((id) => ids.includes(id)), true);
  const buffett = personas().find((p) => p.id === "buffett")!;
  eq("Buffett weights", buffett.weights, { fundamental: 0.4, valuation: 0.35, technical: 0.05, qualitative: 0.2 });
  eq("Buffett growth cap", buffett.dcfGrowthCap, 0.08);
  eq("Lynch margin of safety", personas().find((p) => p.id === "lynch")?.requiredMarginOfSafety, 0.1);
  eq("scoring weights load", Object.keys(scoring().categories.fundamental).length > 0, true);
  eq("the YAML reader handles blocks and lists", parseYaml("id: x\nsystem_prompt: |\n  line one\n  line two\nlist:\n  - a\n  - b\nw:\n  k: 0.5\n"), { id: "x", system_prompt: "line one\nline two", list: ["a", "b"], w: { k: 0.5 } });

  console.log("\nTechnical indicators (spec §3.6)");
  eq("50-day average", sma(Array.from({ length: 60 }, (_, i) => i + 1), 50), 35.5);
  eq("too short for 200 days", sma([1, 2, 3], 200), null);
  eq("RSI of a steady rise is 100", rsi(Array.from({ length: 30 }, (_, i) => 100 + i)), 100);
  eq("RSI of a flat line is 50", rsi(Array.from({ length: 30 }, () => 100)), 50);
  eq("uptrend", trendLabel(120, 110, 100), "uptrend");
  eq("downtrend", trendLabel(80, 90, 100), "downtrend");
  eq("the averages together is sideways", trendLabel(105, 100.5, 100), "sideways");
  // From the TCS/Accenture review: a 50-day average well below the 200-day was called "sideways" for one
  // company and "downtrend" for another. The same picture must get the same label.
  eq("Accenture: 50-day 16% below the 200-day, price below it too", trendLabel(178.9, 169.08, 200.8), "downtrend");
  eq("TCS: 50-day 11% below the 200-day", trendLabel(2188.8, 2300, 2600), "downtrend");
  eq("a bounce above the 50-day does not undo a falling 200-day", trendLabel(205, 169.08, 200.8), "sideways");

  console.log("\nComparisons are worked out in code, not by the writer (review fixes 1, 2, 4)");
  {
    const company = (symbol: string, name: string, currency: "INR" | "USD", vals: Record<string, number>, mos: number | null, meets: boolean | null) => ({
      raw: { symbol, company: name, currency, ticker: symbol, exchange: currency === "USD" ? "NASDAQ" : "NSE", market: currency === "USD" ? "US" : "IN", sectorSet: "standard", annual: [], quote: null, marketCap: null, industry: null, fiscalYearEnd: null, unavailable: [] },
      ratios: {
        years: [2024, 2025, 2026], currency,
        categories: { profitability: Object.fromEntries(Object.entries(vals).map(([k, v]) => [k, {
          formulaId: `${k}_v1`,
          label: k === "currentRatio" ? "Current ratio" : k === "freeCashFlow" ? "Free cash flow" : "Net profit margin",
          unit: k === "currentRatio" ? "times" : k === "freeCashFlow" ? "currency" : "percent",
          series: [{ year: 2026, value: v, inputs: {} }], latest: v, median10y: null, min10y: null, max10y: null, std10y: null,
          trend: null, consistency: null, sectorMedian: null, percentileInSector: null,
        }])) },
        qualityScores: { dupont: [], piotroski: { score: null, tests: [] }, altmanZ: { score: null, zone: null, variant: "" }, beneishM: { score: null, flag: null } },
        categoryScores: { fundamental: null, growth: null, valuation: null, financialHealth: null }, unavailable: [], peers: { count: 0, industry: null },
      },
      valuation: mos === null ? null : { marginOfSafety: mos, requiredMarginOfSafety: 0.25, meetsRequirement: meets, scenarios: [], relativeMultiples: {}, models: [], assumptionNotes: [], unavailable: [] },
      technical: null, qualitative: null,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;
    const tcs = company("TCS", "Tata Consultancy Services Limited", "INR", { currentRatio: 2.01, netMargin: 0.184, freeCashFlow: 425160000000 }, -0.283, false);
    const acn = company("ACN", "Accenture plc", "USD", { currentRatio: 1.42, netMargin: 0.11, freeCashFlow: 10900000000 }, null, null);
    const facts = comparisonFacts([tcs, acn]);
    const fact = (key: string) => facts.find((f) => f.key === key);
    eq("the higher current ratio is found in code", fact("currentRatio")?.leader, "TCS");
    eq("and the sentence says which is stronger", /Tata Consultancy Services Limited 2.01x vs Accenture plc 1.42x/.test(fact("currentRatio")?.sentence ?? ""), true);
    eq("amounts in different currencies are never compared", fact("freeCashFlow"), undefined);
    eq("a margin of safety that fails says so", /does NOT meet/.test(fact("marginOfSafety:TCS")?.sentence ?? ""), true);

    const claim = (text: string) => wrongComparisons(text, facts);
    eq("\"both clear the 25% margin of safety\" is caught", claim("Both companies clear the 25% margin of safety this persona requires.").length, 1);
    eq("a backwards liquidity claim is caught", claim("Accenture's liquidity is higher than TCS's.").length, 1);
    eq("the right way round passes", claim("TCS's current ratio is higher than Accenture's.").length, 0);
    eq("a backwards margin claim is caught", claim("Accenture has a higher net profit margin than TCS.").length, 1);
    eq("a sentence with no comparison is left alone", claim("TCS reported a current ratio of 2.01x.").length, 0);
    // The comparison word belongs to the company named just before it, not to the first company in the sentence,
    // and on a lower-is-better ratio the "stronger" company is the one with the smaller number.
    const pbFacts = [{
      key: "pb", label: "Price to book", better: "lower" as const, leader: "ACN",
      values: [{ symbol: "TCS", company: "Tata Consultancy Services Limited", value: 7.38, shown: "7.38x" }, { symbol: "ACN", company: "Accenture plc", value: 3.89, shown: "3.89x" }],
      sentence: "",
    }];
    eq("\"...for TCS and 3.89x for Accenture, Accenture is stronger\" passes", wrongComparisons("Price to book is 7.38x for TCS and 3.89x for Accenture, Accenture is stronger.", pbFacts).length, 0);
    eq("\"TCS trades at a higher price to book\" passes", wrongComparisons("TCS trades at a higher price to book than Accenture.", pbFacts).length, 0);
    eq("\"TCS trades at a lower price to book\" is caught", wrongComparisons("TCS trades at a lower price to book than Accenture.", pbFacts).length, 1);
    // A company named in an earlier clause is not the subject of the comparison word, and a word with no
    // measure near it is not judged at all.
    eq("a comparison across clauses reads the opening company", claim("Accenture offers a stronger margin of safety at 32.7% versus TCS's -28.3% and a higher free cash flow yield of 9.0% versus 5.4% for TCS.").length, 0);
    eq("a loose \"superior\" with no measure beside it is left alone", claim("The investor must weigh TCS's superior returns against Accenture's more attractive cash conversion efficiency.").length, 0);
    eq("\"...for Accenture, indicating a higher premium for TCS\" passes", wrongComparisons("Price to book is 7.38x for TCS versus 3.89x for Accenture, indicating a higher valuation premium for TCS.", pbFacts).length, 0);
  }

  console.log("\nThe validator reconciles ratios that share inputs (review fix 8)");
  {
    const reports = (roe: number, dupont: { netMargin: number; assetTurnover: number; equityMultiplier: number }) => ({
      raw: { symbol: "X", annual: [{ year: 2026, netIncome: 100, totalAssets: 1000, totalLiabilities: 600, shareholdersEquity: 400, sources: {} }], prices: [], filings: [], unavailable: [], marketCap: 1000, quote: null },
      ratios: {
        years: [2026],
        categories: { profitability: { roe: { formulaId: "roe_v1", label: "Return on equity", unit: "percent", series: [{ year: 2026, value: roe, inputs: {} }], latest: roe, median10y: null, min10y: null, max10y: null, std10y: null, trend: null, consistency: null, sectorMedian: null, percentileInSector: null } } },
        qualityScores: { dupont: [{ year: 2026, ...dupont, roe: null }], piotroski: { score: null, tests: [] }, altmanZ: { score: null, zone: null, variant: "" }, beneishM: { score: null, flag: null } },
        categoryScores: {}, unavailable: [], peers: { count: 0, industry: null },
      },
      valuation: null, technical: null, qualitative: null,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;
    const agrees = validate(reports(0.25, { netMargin: 0.1, assetTurnover: 1, equityMultiplier: 2.5 }));
    eq("ROE that matches its DuPont parts raises nothing", agrees.warnings.some((w) => w.check === "dupont_reconciliation"), false);
    const disagrees = validate(reports(0.614, { netMargin: 0.184, assetTurnover: 1.1, equityMultiplier: 1.6 }));
    eq("ROE that does not match its parts is flagged", disagrees.warnings.some((w) => w.check === "dupont_reconciliation"), true);
    eq("and the return figures are marked low confidence", disagrees.lowConfidence.includes("roe"), true);
  }

  console.log("\nValuation arithmetic (spec §3.5)");
  // Zero growth, 10% discount, 0% terminal: a perpetuity of 100 is worth 1,000; less 200 net debt over 10 shares = 80.
  eq("DCF reduces to a perpetuity when growth is zero", dcf(100, 0, 0.1, 0, 200, 10), 80, 0.001);
  eq("no DCF on negative cash flow", dcf(-5, 0.05, 0.12, 0.04, 0, 10), null);
  eq("justified P/B: ROE 15%, g 5%, r 10% doubles book", justifiedPb(0.15, 0.05, 0.1, 100), 200);

  const fixture = (name: string) => JSON.parse(readFileSync(`tests/fixtures/${name}`, "utf8"));
  setListingsForTests(fixture("us-listings.json"));

  console.log("\nBoth markets (spec §3.1, §5.0), against a saved SEC listing");
  eq("a US company by name", (await findUsCompanies("Should I look at Apple as a long-term investment?", new Set())).found.map((m) => m.symbol), ["AAPL"]);
  eq("a US ticker typed in capitals", (await findUsCompanies("Analyse MSFT", new Set())).found.map((m) => m.symbol), ["MSFT"]);
  eq("a bare symbol listed in India defaults to NSE", (await findUsCompanies("Analyse INFY", new Set(["INFY"]))).found.length, 0);
  eq("unless it is marked as US", (await findUsCompanies("Analyse INFY.US", new Set(["INFY"]))).found.map((m) => m.symbol), ["INFY"]);
  eq("the P in P/E is not the ticker P", (await findUsCompanies("Is Asian Paints' P/E reasonable for its growth?", new Set(["ASIANPAINT"]))).found.length, 0);
    eq("ratio vocabulary is not a ticker", (await findUsCompanies("What is the ROE and PE of KO", new Set())).found.map((m) => m.symbol), ["KO"]);
  const both = await readInput(db, "Analyse Infosys", trace);
  eq("a company listed in both markets is put to the reader", both.ambiguous?.options.map((o) => o.market).sort(), ["IN", "US"]);
  eq("but not when it is the company already in view", (await readInput(db, "Analyse Infosys", trace, { symbol: "INFY", market: "IN" })).companies.map((c) => `${c.symbol}/${c.market}`), ["INFY/IN"]);
  eq("a cross-market comparison", (await readInput(db, "Compare TCS vs Accenture", trace)).companies.map((c) => `${c.symbol}/${c.market}`), ["TCS/IN", "ACN/US"]);
  const twins = await readInput(db, "compare infosys vs wipro", trace);
  eq("a comparison of two companies listed in both markets stays in one market", [twins.intent, twins.companies.map((c) => `${c.symbol}/${c.market}`)], ["comparison", ["INFY/IN", "WIPRO/IN"]]);
  eq("and says which listings were used", /listed in both India and the US/.test(twins.note ?? ""), true);
  eq("a ticker that picks one listing keeps the comparison", (await readInput(db, "compare INFY.NS vs wipro", trace)).companies.map((c) => c.symbol), ["INFY", "WIPRO"]);

  console.log("\nConfiguration files (spec §4.7, §5.0, §7.3)");
  eq("per-agent settings load", settings().agents.synthesis?.temperature, 0.3);
  eq("the input layer runs on the small model tier", settings().agents.input_layer?.model, "small");
  eq("the call and loop limits cannot be raised past the spec", [settings().request.maxLlmCalls <= 12, settings().request.maxLoops <= 2], [true, true]);
  eq("the US GAAP field mapping loads", (fieldMapping("us_gaap") as Record<string, Record<string, string[]>>).duration.revenue[0], "us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax");
  eq("the Ind AS field mapping loads", (fieldMapping("in_xbrl") as Record<string, Record<string, string[]>>).cash_flow.operating_cash_flow, ["cfo"]);

  console.log("\nContracts (spec §6, §10.1): every agent's output validates");
  const inRaw = fixture("raw-IN-ITC.json") as RawData;
  const usRaw = fixture("raw-US-AAPL.json") as RawData;
  const buffettP = personas().find((p) => p.id === "buffett")!;
  for (const raw of [inRaw, usRaw]) {
    const ratios = ratioReport(db, raw, buffettP.thresholds);
    const valuation = valuationReport(raw, ratios, buffettP);
    const technical = technicalReport(raw);
    const validation = validate({ raw, ratios, valuation, technical, qualitative: null });
    eq(`${raw.ticker}: raw data`, validateContract("RawData", raw), []);
    eq(`${raw.ticker}: ratio report`, validateContract("RatioReport", ratios), []);
    eq(`${raw.ticker}: valuation report`, validateContract("ValuationReport", valuation), []);
    eq(`${raw.ticker}: technical report`, validateContract("TechnicalReport", technical), []);
    eq(`${raw.ticker}: validation report`, validateContract("ValidationReport", validation), []);
  }
  eq("a report missing a field fails its contract", validateContract("TechnicalReport", { symbol: "X" }).length > 0, true);
  eq("a score out of range fails", validateContract("FinalAnalysis", { personaId: "b", personaName: "B", summary: "", strengths: [], concerns: [], keyNumbers: [], categoryScores: { fundamental: 140, valuation: null, technical: null, qualitative: null }, personaFit: null, missingData: [], writtenBy: "data", removed: [], disclaimer: "" }).some((p) => p.includes("fundamental")), true);

  console.log("\nThe model's valuation assumptions are clamped (spec §3.5)");
  {
    const ratios = ratioReport(db, usRaw, buffettP.thresholds);
    const v = valuationReport(usRaw, ratios, buffettP, { growth: 0.4, discountRate: 0.02, terminalGrowth: 0.09, by: "model", rationale: "test" });
    const base = v.scenarios.find((x) => x.name === "base")!.assumptions;
    eq("growth above the persona cap is held at the cap", base.growth_start, buffettP.dcfGrowthCap);
    eq("a discount rate below the range is raised to its floor", base.discount_rate, RANGES.discountRate.USD[0]);
    eq("terminal growth above the range is lowered to its ceiling", base.terminal_growth, RANGES.terminalGrowth.USD[1]);
    eq("and every clamp is written down", v.assumptionNotes.filter((n) => n.includes("clamped")).length, 3);
  }

  console.log("\nGraph integration with mocked vendors and a mocked model (spec §10.1)");
  {
    const calls: string[] = [];
    const mock = async (o: ChatOptions): Promise<Completion> => {
      const reply = (text: string): Completion => ({ text, model: "mock", promptTokens: 10, completionTokens: 10, latencyMs: 1 });
      if (/research orchestrator/.test(o.system)) { calls.push("orchestrator"); return reply(JSON.stringify({ tasks: [{ worker: "ratio_engine", focus: ["profitability"] }, { worker: "made_up_worker" }], reasoning: "x" })); }
      if (/Suggest discounted-cash-flow/.test(o.system)) { calls.push("valuation"); return reply(JSON.stringify({ growth: 0.3, discount_rate: 0.09, terminal_growth: 0.03, rationale: "mock" })); }
      if (/extract evidence/.test(o.system)) { calls.push("news"); return reply(JSON.stringify({ moat_signals: [{ summary: "A cited finding.", sentiment: "positive", source: 1 }, { summary: "An invented finding.", sentiment: "positive", source: 999 }], management_signals: [], risks: [] })); }
      if (/Extract the names/.test(o.system)) { calls.push("input"); return reply("{\"companies\": []}"); }
      calls.push("synthesis");
      return reply(JSON.stringify({
        summary: "Returns on capital are high. Margins will reach 99.9% next year. You should buy this stock now.",
        strengths: ["Debt is modest."], concerns: ["Growth has slowed."], follow_up: null,
      }));
    };
    const provider = (market: "IN" | "US") => ({ market, name: "fixtures", load: async () => (market === "US" ? usRaw : inRaw) });
    const r = await analyze(db, { message: "Should I look at Apple as a long-term investment?", personaId: "buffett", record: false, chat: mock, provider });
    eq("the request is answered", r.status, "answered");
    eq("the US fixture was analysed", r.companies[0]?.ticker, "AAPL");
    eq("an invalid plan is retried once, then the default plan is used", [calls.filter((c) => c === "orchestrator").length, r.plan?.plannedBy], [2, "default"]);
    eq("all four reports are produced", [r.companies[0]?.ratios, r.companies[0]?.valuation, r.companies[0]?.technical, r.companies[0]?.qualitative].every(Boolean), true);
    eq("a finding that cites no real source is dropped", r.companies[0]?.qualitative?.moatSignals.some((m) => m.summary === "An invented finding."), false);
    eq("an ungrounded number is stripped after one regeneration", /99\.9%/.test(r.final?.summary ?? ""), false);
    eq("advice language is stripped", /should buy/i.test(r.final?.summary ?? ""), false);
    eq("what was removed is recorded", (r.final?.removed.length ?? 0) >= 2, true);
    eq("the model budget is respected", r.llmCalls <= 12, true);
    eq("the disclaimer is attached", r.final?.disclaimer, "This is educational research, not investment advice. Consult a registered adviser before investing.");
    eq("the final analysis validates", validateContract("FinalAnalysis", r.final), []);
    eq("missing data is listed", (r.final?.missingData.length ?? 0) > 0, true);

    const failing = async () => { throw new Error("vendor down"); };
    const down = await analyze(db, { message: "Analyse Apple", personaId: "lynch", record: false, chat: mock, provider: (m) => ({ market: m, name: "down", load: failing }) });
    eq("a vendor failure never crashes the graph (spec §6.5)", down.status, "no_data");
    eq("and it is recorded as an agent error", down.errors.some((e) => e.agent === "data_agent" && /vendor down/.test(e.message)), true);

    console.log("\nLangGraph: the path each kind of request takes");
    const node = (p: string[], n: string) => p.indexOf(n);
    eq("a full analysis visits every agent node", ["input_layer", "orchestrator", "data_agent", "ratio_engine", "valuation_agent", "technical_agent", "news_moat_agent", "validator", "synthesis", "response_layer"].every((n) => r.path.includes(n)), true);
    eq("the three workers run after the ratio engine and before the validator", ["valuation_agent", "technical_agent", "news_moat_agent"].every((n) => node(r.path, n) > node(r.path, "ratio_engine") && node(r.path, n) < node(r.path, "validator")), true);
    eq("the validator runs once for the parallel step, not once per worker", r.path.filter((n) => n === "validator").length, 1);
    eq("the response layer is last", r.path.at(-1), "response_layer");
    const refused = await analyze(db, { message: "Will Apple double next year?", personaId: "buffett", record: false, chat: mock, provider });
    eq("a refusal goes straight from the input layer to the response layer", refused.path, ["input_layer", "response_layer"]);
    const concept = await analyze(db, { message: "What is DuPont analysis?", personaId: "buffett", record: false, chat: mock, provider });
    eq("a concept is explained without the data agents", concept.path, ["input_layer", "explain_concept", "response_layer"]);

    // Synthesis asks once for more news; the orchestrator loops back to that worker, then validator and synthesis again.
    let asked = false;
    const loopingMock = async (o: ChatOptions): Promise<Completion> => {
      if (/You write an analysis|Return JSON only: \{"summary"/.test(o.system) && !asked) {
        asked = true;
        return { text: JSON.stringify({ summary: "Returns are high.", strengths: ["Debt is modest."], concerns: [], follow_up: { worker: "news_moat_agent", questions: ["pricing power"], reason: "moat evidence is thin" } }), model: "mock", promptTokens: 1, completionTokens: 1, latencyMs: 1 };
      }
      return mock(o);
    };
    const thin = { ...usRaw, filings: [] };
    const looped = await analyze(db, { message: "Should I look at Apple as a long-term investment?", personaId: "buffett", record: false, chat: loopingMock, provider: (m) => ({ market: m, name: "fixtures", load: async () => thin }) });
    eq("a request for more work loops back through the orchestrator", looped.loops, 1);
    eq("the loop path is loop_back -> news_moat_agent -> validator -> synthesis", looped.path.slice(node(looped.path, "loop_back"), node(looped.path, "loop_back") + 4), ["loop_back", "news_moat_agent", "validator", "synthesis"]);

    // Impossible values send the data agent back exactly once (spec §8.1).
    let loads = 0;
    const bad = { ...usRaw, annual: usRaw.annual.map((a, i) => (i === 0 ? { ...a, revenue: -1 } : a)) };
    const refetched = await analyze(db, { message: "Should I look at Apple as a long-term investment?", personaId: "buffett", record: false, chat: mock, provider: (m) => ({ market: m, name: "fixtures", load: async () => (++loads === 1 ? bad : usRaw) }) });
    eq("impossible values trigger one re-fetch", [loads, refetched.path.filter((n) => n === "data_agent").length], [2, 2]);
    eq("and the analysis completes after it", refetched.status, "answered");

    const diagram = await graphDiagram();
    eq("the compiled graph draws as a diagram with every node", ["input_layer", "orchestrator", "data_agent", "ratio_engine", "valuation_agent", "technical_agent", "news_moat_agent", "validator", "synthesis", "loop_back", "response_layer"].every((n) => diagram.includes(n)), true);
  }

  if (live) {
    console.log("\nEnd to end (--live)");
    const cases: [string, string, (r: Awaited<ReturnType<typeof analyze>>) => [string, unknown, unknown][]][] = [
      ["Analyse Infosys as a long-term investment", "buffett", (r) => [
        ["answered", r.status, "answered"], ["four reports", [r.companies[0]?.ratios, r.companies[0]?.valuation, r.companies[0]?.technical, r.companies[0]?.qualitative].every(Boolean), true],
        ["within the model budget", r.llmCalls <= 12, true], ["the disclaimer is attached", r.final?.disclaimer.includes("educational research"), true],
        ["missing data is listed", Array.isArray(r.final?.missingData), true],
        ["no advice language survived", violations([r.final?.summary, ...(r.final?.strengths ?? []), ...(r.final?.concerns ?? [])].join(" ")).length, 0],
      ]],
      ["Is HDFCBANK.NS's debt a concern?", "buffett", (r) => [["answered", r.status, "answered"], ["financial-sector set", r.companies[0]?.sectorSet, "financial"]]],
      ["Should I look at Apple as a long-term investment?", "buffett", (r) => [["answered", r.status, "answered"], ["a US company", r.companies[0]?.market, "US"], ["in dollars", r.companies[0]?.currency, "USD"]]],
      ["Compare TCS vs Accenture", "lynch", (r) => [["answered", r.status, "answered"], ["two companies in two markets", r.companies.map((c) => c.market), ["IN", "US"]]]],
      ["Will ITC double next year?", "buffett", (r) => [["refused", r.status, "blocked"]]],
    ];
    for (const [q, persona, checks] of cases) {
      const started = Date.now();
      const r = await analyze(db, { message: q, personaId: persona, record: false });
      console.log(`  "${q}" (${persona}) -> ${r.status} in ${((Date.now() - started) / 1000).toFixed(1)} s, ${r.llmCalls} model calls, ${r.loops} loops, written by ${r.final?.writtenBy ?? "-"}`);
      if (r.final) {
        console.log(`    summary: ${r.final.summary.slice(0, 300)}`);
        console.log(`    scores: ${JSON.stringify(r.final.categoryScores)} fit ${r.final.personaFit}; removed ${r.final.removed.length}`);
      }
      for (const [what, got, want] of checks(r)) eq(what, got, want);
    }
  }

  console.log("\nA backup model host answers when the primary is out of quota");
  {
    const cfg = config as unknown as Record<string, string>;
    const saved = { p: cfg.LLM_PROVIDER, k: cfg.LLM_API_KEY, bp: cfg.LLM_BACKUP_PROVIDER, bk: cfg.LLM_BACKUP_API_KEY };
    Object.assign(cfg, { LLM_PROVIDER: "cerebras", LLM_API_KEY: "primary-key", LLM_BACKUP_PROVIDER: "groq", LLM_BACKUP_API_KEY: "backup-key" });
    const calls: string[] = [];
    const t = new Trace(null, undefined, async (o) => {
      calls.push(o.host?.provider ?? "primary");
      return o.host ? { text: "{}", model: "backup", promptTokens: 1, completionTokens: 1, latencyMs: 1 }
        : { text: null, model: "primary", promptTokens: null, completionTokens: null, latencyMs: 1, error: "HTTP 429: tokens per day limit reached" };
    });
    const r = await t.llm("orchestrator", { system: "s", user: "u" });
    eq("the primary is tried, then the backup", calls, ["primary", "groq"]);
    eq("the backup's answer is used", r.text, "{}");
    eq("the small tier maps to the backup's own small model", await (async () => {
      let model: string | undefined;
      await new Trace(null, undefined, async (o) => { if (o.host) model = o.model; return { text: o.host ? "{}" : null, model: "", promptTokens: null, completionTokens: null, latencyMs: 1, error: o.host ? undefined : "rate limit" }; })
        .llm("input_layer", { system: "s", user: "u" });
      return model;
    })(), "openai/gpt-oss-20b");
    Object.assign(cfg, { LLM_PROVIDER: saved.p, LLM_API_KEY: saved.k, LLM_BACKUP_PROVIDER: saved.bp, LLM_BACKUP_API_KEY: saved.bk });
  }

  console.log("\nThe case for and the case against are argued under the same rules as the analysis");
  {
    const one = {
      raw: { symbol: "TCS", company: "Tata Consultancy Services Limited", currency: "INR", ticker: "TCS", exchange: "NSE", market: "IN", sectorSet: "standard", annual: [], quote: null, marketCap: null, industry: null, fiscalYearEnd: null, unavailable: [] },
      ratios: {
        years: [2026], currency: "INR",
        categories: { profitability: { netMargin: { formulaId: "netMargin_v1", label: "Net profit margin", unit: "percent", series: [{ year: 2026, value: 0.184, inputs: {} }], latest: 0.184, median10y: 0.19, min10y: null, max10y: null, std10y: null, trend: null, consistency: null, sectorMedian: null, percentileInSector: null } } },
        qualityScores: { dupont: [], piotroski: { score: null, tests: [] }, altmanZ: { score: null, zone: null, variant: "" }, beneishM: { score: null, flag: null } },
        categoryScores: { fundamental: null, growth: null, valuation: null, financialHealth: null }, unavailable: [], peers: { count: 0, industry: null },
      },
      valuation: null, technical: null, qualitative: null,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    const facts = "TCS net profit margin 18.4% in FY2026, against its own 8-year median of 19.0%.";
    const pool = numberPool({ netMargin: 0.184, ownMedian: 0.19 });
    // Three points on each side: one sound, one carrying a figure no report holds, one telling the reader what to do.
    const replies = (side: string) => JSON.stringify({ points: [
      `Net profit margin is 18.4% in FY2026, against its own 8-year median of 19.0%.`,
      `${side === "bull" ? "Growth" : "Decline"} of 42.7% is the story here.`,
      "Investors should buy the stock at this level.",
    ] });
    let asked = 0;
    const t = new Trace(null, undefined, async (o) => {
      asked++;
      return { text: replies(/AGAINST/.test(o.system ?? "") ? "bear" : "bull"), model: "test", promptTokens: null, completionTokens: null, latencyMs: 1 };
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const args = { persona: personas()[0], companies: [one], facts, pool, question: "Analyse TCS as a long-term holding" } as any;
    const d = await debate(t, args);
    eq("both sides are argued", asked, 2);
    eq("the model's points are used", d.writtenBy, "model");
    eq("a figure no report holds is dropped from the case for", d.bull, ["Net profit margin is 18.4% in FY2026, against its own 8-year median of 19.0%."]);
    eq("and from the case against", d.bear.length, 1);
    eq("neither side tells the reader what to do", d.bull.concat(d.bear).some((p) => violations(p).length > 0), false);

    // With no model, the rules' own strengths and concerns stand in, so the section is never empty.
    const quiet = new Trace(null, undefined, async () => ({ text: null, model: "", promptTokens: null, completionTokens: null, latencyMs: 1, error: "no key" }));
    const fallback = await debate(quiet, args);
    eq("without a model the section falls back to the rules", fallback.writtenBy, "data");
  }

  db.close();
  console.log(failed ? `\n${failed} check${failed === 1 ? "" : "s"} failed` : "\nAll checks passed");
  process.exit(failed ? 1 : 0);
}

void main();
