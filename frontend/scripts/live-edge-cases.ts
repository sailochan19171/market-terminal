// Edge cases against the live site, all at once (multi-job): each request must answer its own question with its own
// company - no crossed wires between concurrent jobs - and pass the compliance, grounding and direction checks.
//   npx tsx scripts/live-edge-cases.ts [--base https://market-terminal-sai.netlify.app]
import { violations } from "../src/server/agents/compliance";
import type { AnalysisResponse } from "../src/server/agents/graph";
import { validateContract } from "../src/server/agents/schemas";
import { contradictions, numberPool, ungroundedNumbers } from "../src/server/agents/validator";

const i = process.argv.indexOf("--base");
const BASE = i >= 0 ? process.argv[i + 1] : "https://market-terminal-sai.netlify.app";

type Check = [string, (r: AnalysisResponse) => boolean];
interface Case { name: string; body: Record<string, unknown>; checks: Check[] }

const ratio = (r: AnalysisResponse, k: string, company = 0) => {
  const c = r.companies[company]?.ratios;
  return c ? Object.values(c.categories).map((x) => x[k]).find(Boolean) : undefined;
};
const tickers = (r: AnalysisResponse) => r.companies.map((c) => c.ticker);

const CASES: Case[] = [
  { name: "US large-cap, Lynch persona", body: { message: "Analyse Microsoft", persona: "lynch" }, checks: [
    ["answered about MSFT only", (r) => r.status === "answered" && tickers(r).join() === "MSFT"],
    ["in dollars from SEC EDGAR", (r) => r.companies[0]?.currency === "USD" && r.companies[0].sources.some((s) => /SEC EDGAR/.test(s.source))],
    ["all four reports", (r) => [r.companies[0]?.ratios, r.companies[0]?.valuation, r.companies[0]?.technical, r.companies[0]?.qualitative].every(Boolean)],
    ["Lynch persona used", (r) => r.persona.id === "lynch"],
  ] },
  { name: "Indian bank, single metric", body: { message: "Is Kotak Mahindra Bank's debt a concern?", persona: "buffett" }, checks: [
    ["answered about KOTAKBANK", (r) => r.status === "answered" && tickers(r).join() === "KOTAKBANK.NS"],
    ["financial-sector ratio set", (r) => r.companies[0]?.sectorSet === "financial" && ratio(r, "netInterestMargin") !== undefined && ratio(r, "currentRatio") === undefined],
    ["single-metric intent", (r) => r.intent === "single_metric"],
  ] },
  { name: "comparison of two dual-listed Indian companies", body: { message: "compare infosys vs wipro", persona: "buffett" }, checks: [
    ["a comparison of both, on NSE", (r) => r.intent === "comparison" && tickers(r).join() === "INFY.NS,WIPRO.NS"],
    ["says which listings were used", (r) => /listed in both India and the US/.test(r.message ?? "")],
  ] },
  { name: "cross-market comparison", body: { message: "Compare TCS vs Accenture", persona: "lynch" }, checks: [
    ["TCS (India) against Accenture (US)", (r) => r.intent === "comparison" && tickers(r).join() === "TCS.NS,ACN"],
    ["each in its own currency", (r) => r.companies.map((c) => c.currency).join() === "INR,USD"],
  ] },
  { name: "one company listed in both markets", body: { message: "Analyse Infosys", persona: "buffett" }, checks: [
    ["asks which listing", (r) => r.status === "ambiguous" && r.options.map((o) => o.market).sort().join() === "IN,US"],
  ] },
  { name: "many companies share a name", body: { message: "Analyse Tata", persona: "buffett" }, checks: [
    ["asks which company", (r) => r.status === "ambiguous" && r.options.length >= 3],
  ] },
  { name: "loss-making growth company", body: { message: "Analyse Rivian", persona: "buffett" }, checks: [
    ["answered about RIVN", (r) => r.status === "answered" && tickers(r).join() === "RIVN"],
    ["no P/E, with the reason negative_earnings", (r) => ratio(r, "pe")?.latest === null && ratio(r, "pe")?.series.at(-1)?.reason === "negative_earnings"],
  ] },
  { name: "negative equity", body: { message: "Analyse McDonald's", persona: "buffett" }, checks: [
    ["answered about MCD", (r) => r.status === "answered" && tickers(r).join() === "MCD"],
    ["no ROE, with the reason negative_equity", (r) => ratio(r, "roe")?.latest === null && ratio(r, "roe")?.series.at(-1)?.reason === "negative_equity"],
  ] },
  { name: "recent IPO", body: { message: "Analyse Swiggy", persona: "lynch" }, checks: [
    ["answered about SWIGGY", (r) => r.status === "answered" && tickers(r).join() === "SWIGGY.NS"],
    ["short history is listed as missing", (r) => (r.companies[0]?.years.length ?? 9) < 5 && (r.final?.missingData.some((m) => /history depth/.test(m)) ?? false)],
  ] },
  { name: "high-debt utility", body: { message: "Analyse NTPC as a long-term investment", persona: "buffett" }, checks: [
    ["answered about NTPC", (r) => r.status === "answered" && tickers(r).join() === "NTPC.NS"],
    ["debt to equity above 1", (r) => (ratio(r, "debtToEquity")?.latest ?? 0) > 1],
  ] },
  { name: "follow-up with the company in view", body: { message: "Is its debt a concern?", persona: "buffett", symbol: "AAPL", market: "US" }, checks: [
    ["answered about Apple", (r) => r.status === "answered" && tickers(r).join() === "AAPL"],
  ] },
  { name: "US comparison", body: { message: "Compare Apple and Microsoft", persona: "buffett" }, checks: [
    ["both US companies", (r) => r.intent === "comparison" && tickers(r).join() === "AAPL,MSFT"],
    ["sector peers are US only", (r) => r.companies.every((c) => c.sources.some((s) => /US peers|no US peers|fewer than 5 US peers/.test(s.source)))],
  ] },
  { name: "price prediction", body: { message: "Will Nvidia double next year?", persona: "lynch" }, checks: [
    ["refused", (r) => r.status === "blocked" && /price prediction/i.test(r.message ?? "")],
  ] },
  { name: "target price", body: { message: "Give me a target price and stop loss for Reliance", persona: "buffett" }, checks: [
    ["refused", (r) => r.status === "blocked"],
  ] },
  { name: "explain a concept", body: { message: "What is DuPont analysis?", persona: "buffett" }, checks: [
    ["explained with the engine's formula", (r) => r.status === "concept" && /net margin/i.test(r.concept?.concept?.formula ?? "")],
  ] },
  { name: "a company that does not exist", body: { message: "Analyse Zyxqorp Holdings", persona: "buffett" }, checks: [
    ["no invented analysis", (r) => r.status !== "answered"],
  ] },
  // Streaming jobs running beside the others, as several workspace tabs would.
  { name: "streamed: Indian large-cap", body: { message: "Analyse RELIANCE.NS", persona: "buffett", stream: true }, checks: [
    ["answered about RELIANCE", (r) => r.status === "answered" && tickers(r).join() === "RELIANCE.NS"],
  ] },
  { name: "streamed: US bank", body: { message: "Analyse JPMorgan", persona: "buffett", stream: true }, checks: [
    ["answered about JPM with the financial set", (r) => r.status === "answered" && tickers(r).join() === "JPM" && r.companies[0].sectorSet === "financial"],
  ] },
  { name: "streamed: concept named like a company", body: { message: "What is DuPont analysis?", persona: "lynch", stream: true }, checks: [
    ["explained, not analysed as DuPont de Nemours", (r) => r.status === "concept"],
  ] },
  { name: "streamed: Lynch on a consumer company", body: { message: "Is Asian Paints' P/E reasonable for its growth?", persona: "lynch", stream: true }, checks: [
    ["answered about ASIANPAINT", (r) => r.status === "answered" && tickers(r).join() === "ASIANPAINT.NS"],
  ] },
];

async function run(c: Case) {
  const started = Date.now();
  try {
    const res = await fetch(`${BASE}/api/v2/agents/analyze`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ stream: false, ...c.body }), signal: AbortSignal.timeout(90_000),
    });
    const text = await res.text();
    if (c.body.stream) {
      // Streaming jobs, as the workspace sends them: step events, then the result line.
      const events = text.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as { type: string; data?: AnalysisResponse; message?: string });
      const result = events.find((e) => e.type === "result")?.data;
      if (!result) throw new Error(events.find((e) => e.type === "error")?.message ?? `no result line (HTTP ${res.status})`);
      const steps = events.filter((e) => e.type === "step").length;
      return { c, ms: Date.now() - started, r: result, err: null as string | null, steps };
    }
    return { c, ms: Date.now() - started, r: JSON.parse(text) as AnalysisResponse, err: null as string | null, steps: 0 };
  } catch (e) {
    return { c, ms: Date.now() - started, r: null, err: (e as Error).message, steps: 0 };
  }
}

async function main() {
  console.log(`${CASES.length} edge cases fired at once against ${BASE}\n`);
  const started = Date.now();
  const results = await Promise.all(CASES.map(run));
  let failed = 0;
  const ids = new Set<string>();
  for (const { c, ms, r, err } of results) {
    const line = r ? `${r.status}${r.final ? `, ${r.final.writtenBy}` : ""}, ${r.llmCalls} model calls, ${(ms / 1000).toFixed(1)}s${c.body.stream ? ", streamed" : ""}` : err;
    console.log(`${c.name}  [${String(c.body.message)}]  -> ${line}`);
    if (!r) { failed++; console.log("  FAIL request failed"); continue; }
    const checks: Check[] = [...c.checks,
      ["own request id (no shared state between jobs)", (x) => !ids.has(x.requestId)],
      ["disclaimer attached", (x) => x.disclaimer.includes("educational research")],
    ];
    if (r.final) {
      const text = [r.final.summary, ...r.final.strengths, ...r.final.concerns];
      const pool = numberPool([r.companies, r.final.categoryScores, r.final.personaFit, r.persona, [1, 0.5, 0.02, 0.0178, 0.026, 0.011, 0.14, 0.09, 0.365]]);
      for (const v of numberPool(r.companies)) if (Math.abs(v) >= 1e6) pool.push(v / 1e6, v / 1e9);
      checks.push(
        ["no buy/sell instruction", () => violations(text.join(" ")).length === 0],
        ["no ungrounded numbers", () => ungroundedNumbers(text.join(" "), pool).length === 0],
        ["no wrong-direction comparisons", () => {
          const wrong = text.flatMap((t) => contradictions(t));
          if (wrong.length) console.log(`    wrong: ${wrong.join(" | ")}  (written by ${r.final?.writtenBy})`);
          return wrong.length === 0;
        }],
        ["final analysis validates", () => validateContract("FinalAnalysis", r.final).length === 0],
        ["missing data listed", () => r.final!.missingData.length > 0],
      );
    }
    for (const [what, fn] of checks) {
      let ok = false;
      try { ok = fn(r); } catch { ok = false; }
      if (!ok) failed++;
      console.log(`  ${ok ? "ok  " : "FAIL"} ${what}`);
    }
    ids.add(r.requestId);
    if (r.final) console.log(`  summary: ${r.final.summary.slice(0, 160)}…`);
    if (r.status !== "answered" && r.message) console.log(`  message: ${r.message.slice(0, 160)}`);
  }
  const within60 = results.filter((x) => x.r && x.ms < 60_000).length;
  console.log(`\n${within60} of ${results.length} jobs answered inside 60 s`);
  if (within60 < results.length) failed++;
  console.log(`wall time ${((Date.now() - started) / 1000).toFixed(1)}s for ${CASES.length} concurrent jobs; ${failed ? `${failed} checks failed` : "all checks passed"}`);
  process.exit(failed ? 1 : 0);
}

void main();
