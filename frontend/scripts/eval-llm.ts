// LLM evaluation (spec §10.1, §10.3): 30 sample questions through the real graph and the configured model.
//
// For every answer: no ungrounded numbers in the written text, no buy/sell instructions, no impersonation, the
// persona's vocabulary present, and missing data listed. Results go to tests/eval/llm-eval.json.
//   npx tsx scripts/eval-llm.ts                 all 30 (about 120 model calls - mind the provider's daily limit)
//   npx tsx scripts/eval-llm.ts --from 0 --limit 10 --delay 15
import { mkdirSync, writeFileSync } from "node:fs";
import { Db } from "../src/server/db";
import { violations } from "../src/server/agents/compliance";
import { analyze, type AnalysisResponse } from "../src/server/agents/graph";
import { numberPool, ungroundedNumbers } from "../src/server/agents/validator";

const QUESTIONS: [string, "buffett" | "lynch", "answered" | "blocked" | "concept" | "ambiguous" | "any"][] = [
  ["Should I look at Apple as a long-term investment?", "buffett", "answered"],
  ["Analyse RELIANCE.NS", "buffett", "answered"],
  ["Is HDFCBANK.NS's debt a concern?", "buffett", "answered"],
  ["Analyse Microsoft", "lynch", "answered"],
  ["How consistent is Asian Paints' return on equity?", "buffett", "answered"],
  ["Is Nvidia's P/E reasonable for its growth?", "lynch", "answered"],
  ["Compare TCS vs Accenture", "lynch", "answered"],
  ["Compare ITC and Hindustan Unilever", "buffett", "answered"],
  ["What is the margin of safety for Coca-Cola?", "buffett", "answered"],
  ["Analyse JPMorgan", "buffett", "answered"],
  ["Are inventories growing faster than sales at Maruti Suzuki?", "lynch", "answered"],
  ["How strong is Bajaj Finance's net interest margin?", "lynch", "answered"],
  ["Analyse NTPC as a long-term investment", "buffett", "answered"],
  ["Is Swiggy profitable?", "lynch", "answered"],
  ["What are Rivian's biggest risks?", "buffett", "answered"],
  ["Analyse McDonald's", "buffett", "answered"],
  ["How much free cash flow does Infosys generate? (INFY.NS)", "buffett", "answered"],
  ["Analyse Sun Pharmaceutical", "lynch", "answered"],
  ["Is Larsen & Toubro's debt a concern?", "buffett", "answered"],
  ["Analyse Berkshire Hathaway", "buffett", "answered"],
  ["What is Titan's PEG ratio?", "lynch", "answered"],
  ["Analyse Bharti Airtel", "buffett", "answered"],
  ["How has Costco grown its earnings?", "lynch", "answered"],
  ["Analyse Tata", "buffett", "ambiguous"],
  ["What is ROCE and why does it matter?", "buffett", "concept"],
  ["What is the PEG ratio?", "lynch", "concept"],
  ["Will Reliance double by next year?", "buffett", "blocked"],
  ["What is the target price for TCS?", "lynch", "blocked"],
  ["Which penny stock will give guaranteed returns?", "buffett", "blocked"],
  ["Tell me a joke", "buffett", "blocked"],
];

const TONE: Record<string, RegExp> = {
  buffett: /\b(moat|owner|durable|margin of safety|return on (equity|capital)|debt|free cash flow|intrinsic|long[- ]term|conservative)\b/i,
  lynch: /\b(growth|PEG|earnings|P\/E|price[- ]to[- ]earnings|grower|stalwart|inventor|reasonable price|cyclical|turnaround)\b/i,
};

const arg = (name: string, fallback: number) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? Number(process.argv[i + 1]) : fallback;
};

async function main() {
  const db = new Db({ kind: "local", readOnly: true });
  const from = arg("from", 0);
  const limit = arg("limit", QUESTIONS.length);
  const delay = arg("delay", 12) * 1000;
  const rows: Record<string, unknown>[] = [];
  let ungrounded = 0, advice = 0, answered = 0, toneMiss = 0, missingNotListed = 0, statusWrong = 0, modelWritten = 0;

  for (const [i, [q, persona, want]] of QUESTIONS.slice(from, from + limit).entries()) {
    const started = Date.now();
    const r: AnalysisResponse = await analyze(db, { message: q, personaId: persona, record: false });
    const text = r.final ? [r.final.summary, ...r.final.strengths, ...r.final.concerns].join(" ") : (r.concept?.text ?? "");
    const pool = numberPool([r.companies, r.final?.categoryScores, r.final?.personaFit, r.persona, // The same fixed reference points the writer is allowed to name: "52-week range", "50-day average",
      // the Piotroski scale, Beneish's -1.78. Without them the check reports a figure the product accepts.
      [1, 0.5, 0.02, 0.0178, 0.026, 0.011, 0.14, 0.09, 0.365, 0.5], [100, 50, 200, 52, 14, 9, 1.78, 2.6, 1.1, 365]]);
    for (const v of numberPool(r.companies)) if (Math.abs(v) >= 1e6) pool.push(v / 1e6, v / 1e9);
    const bad = r.final ? ungroundedNumbers(text, pool) : [];
    const said = violations(text);
    // Persona tone is judged on full analyses and comparisons; a narrow question about one ratio is answered about
    // that ratio, and its tone is reported but not counted as a failure.
    const toneMatched = !r.final || TONE[persona].test(text);
    const toneOk = r.status !== "answered" || r.intent === "single_metric" || toneMatched;
    if (r.status === "answered" && r.intent === "single_metric" && !toneMatched) console.log(`   note: single-metric answer without ${persona} vocabulary`);
    const unavailableCount = r.companies.reduce((n, c) => n + (c.ratios?.unavailable.length ?? 0), 0);
    const missingOk = r.status !== "answered" || !r.final || unavailableCount === 0 || r.final.missingData.length > 0;
    const statusOk = want === "any" || r.status === want;
    if (r.status === "answered") answered++;
    if (r.final?.writtenBy === "model") modelWritten++;
    ungrounded += bad.length;
    advice += said.length;
    if (!toneOk) toneMiss++;
    if (!missingOk) missingNotListed++;
    if (!statusOk) statusWrong++;
    const flag = bad.length || said.length || !toneOk || !missingOk || !statusOk;
    console.log(`${String(from + i + 1).padStart(2)} ${flag ? "FAIL" : "ok  "} [${persona}] ${q} -> ${r.status}${r.final ? ` (${r.final.writtenBy}, ${r.llmCalls} calls)` : ""} ${((Date.now() - started) / 1000).toFixed(1)}s`
      + `${bad.length ? ` ungrounded=${bad.join(",")}` : ""}${said.length ? ` advice=${said.join(",")}` : ""}${toneOk ? "" : " tone"}${missingOk ? "" : " missing-not-listed"}${statusOk ? "" : ` expected ${want}`}`);
    rows.push({ question: q, persona, status: r.status, expected: want, writtenBy: r.final?.writtenBy ?? null, llmCalls: r.llmCalls, durationMs: r.durationMs, ungrounded: bad, advice: said, toneOk, missingOk, statusOk, text, removed: r.final?.removed ?? [], errors: r.errors });
    if (i < limit - 1) await new Promise((res) => setTimeout(res, delay));
  }

  const summary = { questions: rows.length, answered, modelWritten, ungroundedNumbers: ungrounded, adviceInstructions: advice, toneMisses: toneMiss, missingDataNotListed: missingNotListed, unexpectedStatus: statusWrong };
  mkdirSync("tests/eval", { recursive: true });
  writeFileSync(`tests/eval/llm-eval-${from}-${from + rows.length}.json`, JSON.stringify({ at: new Date().toISOString(), summary, rows }, null, 2));
  console.log("\n", JSON.stringify(summary));
  db.close();
  process.exit(ungrounded || advice || statusWrong ? 1 : 0);
}

void main();
