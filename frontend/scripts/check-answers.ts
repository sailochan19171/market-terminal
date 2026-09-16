// Exercises the research answers against real companies (read-only).
import { Db } from "../src/server/db";
import { ask } from "../src/server/research/answer";
import { decide } from "../src/server/research/decision";

const QUESTIONS = [
  "Should I invest in this company?",
  "When should I buy and when should I avoid it?",
  "What are the biggest risks?",
  "How was the last quarter, profit and revenue?",
  "How much debt does it have?",
  "What changed recently?",
];

async function main() {
  const db = new Db({ kind: "local", readOnly: true });
  for (const sym of process.argv.slice(2).length ? process.argv.slice(2) : ["HDFCBANK", "ITC"]) {
    const d = decide(db, sym);
    console.log(`\n================ ${d.company} (${d.symbol})`);
    console.log(`verdict ${d.verdict} | score ${d.score}/100 | risk ${d.risk.level} | confidence ${d.confidence} | ${d.conditionsMet}`);
    for (const c of d.conditions) console.log(`  [${c.met === null ? "?" : c.met ? "x" : " "}] ${c.label}: ${c.detail.slice(0, 110)}`);
    for (const q of QUESTIONS) {
      const a = await ask(db, sym, q);
      console.log(`\n  Q: ${q}`);
      console.log(`  ${a.headline}`);
      for (const p of a.points.slice(0, 5)) console.log(`   • ${p.slice(0, 190)}`);
      console.log(`   sources: ${a.citations.slice(0, 4).map((c) => `[${c.n}] ${c.label.slice(0, 40)}${c.period ? ` ${c.period}` : ""}`).join(", ")} (written by ${a.writtenBy})`);
    }
  }
  db.close();
}
main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
