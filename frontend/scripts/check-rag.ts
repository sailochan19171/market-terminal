// Does the answer address the question, and is every figure in it real?
//
// Two failure modes matter for a retrieval-grounded answer. It can answer a different question from the one
// asked, and it can state a number that was never in the retrieved material. This asks a spread of questions
// about a real company and checks both: the answer must mention what the question was about, and every number
// it prints must appear in the context the model was given.
//
//   npx tsx scripts/check-rag.ts            # ITC (one company: each question costs model tokens)
//   npx tsx scripts/check-rag.ts TCS VEDL
import { Db } from "../src/server/db";
import { ask } from "../src/server/research/answer";
import { available } from "../src/server/research/llm";

/** Each question, and the words an answer to it must contain to count as an answer to that question. */
const PROMPTS: { q: string; must: RegExp }[] = [
  { q: "What is the dividend history and the payout ratio?", must: /dividend|payout|yield/i },
  { q: "How much debt does the company carry?", must: /debt|borrow|leverage|deposit|lender/i },
  { q: "How fast are revenue and profit growing?", must: /growth|grew|fell|revenue|profit|cagr/i },
  { q: "What are the operating and net margins?", must: /margin/i },
  { q: "Who holds the shares - promoters, FIIs or the public?", must: /promoter|fii|dii|public|holding/i },
  { q: "Is the stock cheap or expensive against its peers?", must: /p\/e|peer|median|valuation|cheap|expensive|fair value/i },
  { q: "How has the share price performed over the last year?", must: /return|price|year|%/i },
  { q: "What did the company file with the exchanges recently?", must: /filing|announc|disclos|intimation|meeting|result/i },
  { q: "How much free cash flow does it generate?", must: /cash/i },
  { q: "What are the biggest risks?", must: /risk|concern|fell|debt|weak/i },
];

/** Figures a reader would check in an answer: rupee amounts, percentages and decimals. */
const claimed = (text: string): number[] =>
  (text.match(/₹\s?-?[\d,]+(?:\.\d+)?|-?[\d,]+(?:\.\d+)?\s?%|\b-?\d[\d,]*\.\d+\b/g) ?? [])
    .map((n) => Math.abs(Number(n.replace(/[₹%,\s]/g, ""))))
    .filter((n) => Number.isFinite(n) && n !== 0);

/** Every number in the source material, read liberally: an answer's figure has to be one of these. */
const present = (text: string): number[] =>
  (text.match(/-?[\d,]+(?:\.\d+)?/g) ?? [])
    .map((n) => Math.abs(Number(n.replace(/,/g, ""))))
    .filter((n) => Number.isFinite(n));

/** The same figure, allowing for rounding and for 16.6 being reprinted as 16.60. */
const matches = (want: number, pool: number[]) =>
  pool.some((v) => v === want
    || Math.abs(v - want) <= Math.max(0.011, Math.abs(want) * 0.001)
    || (Math.abs(want) >= 100 && Math.round(v) === Math.round(want)));

async function main() {
  console.log(available() ? "A model is configured: answers below are model-written.\n" : "No model configured: answers below are written from the data.\n");
  const db = new Db({ kind: "local", readOnly: true });
  let offTopic = 0;
  let ungrounded = 0;

  for (const sym of process.argv.slice(2).length ? process.argv.slice(2) : ["ITC"]) {
    console.log(`================================ ${sym}`);
    for (const { q, must } of PROMPTS) {
      const a = await ask(db, sym, q, { debug: true });
      const body = [a.headline, ...a.points].join(" ");
      const onTopic = must.test(body);
      // Every number the answer prints has to appear in the material it was built from.
      // Only the model's own words are linted; the written lines come straight from the database by construction.
      const pool = present(`${a.context ?? ""} ${JSON.stringify(a.citations)}`);
      const modelText = a.writtenBy === "model" ? (a.modelPoints ? body : a.headline) : "";
      const missing = claimed(modelText).filter((n) => !matches(n, pool));
      if (!onTopic) offTopic++;
      ungrounded += missing.length;
      console.log(`\n${onTopic ? "ON TOPIC " : "OFF TOPIC"}  Q: ${q}`);
      console.log(`  ${a.headline}`);
      for (const p of a.points) console.log(`   • ${p}`);
      console.log(`   [${a.writtenBy}] sources: ${a.citations.slice(0, 4).map((c) => `[${c.n}] ${c.label.slice(0, 34)}`).join(", ")}`);
      if (missing.length) console.log(`   UNGROUNDED FIGURES: ${missing.join(", ")}`);
    }
  }
  db.close();
  console.log(`\n${PROMPTS.length} questions: ${offTopic} answered something else.`);
  console.log(ungrounded ? `${ungrounded} figure(s) could not be traced.` : "Every figure printed traces back to the answer's own sources.");
  process.exit(offTopic ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
