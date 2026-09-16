// Checks the configured language model end to end: the key, the endpoint, then a real company answer.
//
//   npx tsx scripts/check-llm.ts            # uses .env
//   npx tsx scripts/check-llm.ts INFY       # against a particular company
//
// The key is read from .env and never printed. If nothing is configured this says so and stops - the answers
// still work without a model, they are just written from the data rather than phrased by one.
import { config } from "../src/server/config";
import { Db } from "../src/server/db";
import { ask } from "../src/server/research/answer";
import { available, complete } from "../src/server/research/llm";

async function main() {
  console.log(`provider  ${config.LLM_PROVIDER}`);
  console.log(`model     ${config.LLM_MODEL || "(provider default)"}`);
  console.log(`base url  ${config.LLM_BASE_URL || "(provider default)"}`);
  console.log(`api key   ${config.LLM_API_KEY ? `set, ${config.LLM_API_KEY.length} characters` : "NOT SET"}`);
  if (!available()) {
    console.log("\nNo LLM_API_KEY in .env, so answers are composed from the data instead of phrased by a model.");
    process.exit(1);
  }

  console.log("\n1. Calling the model with a two-line context…");
  const said = await complete(
    "What was revenue, and what does the filing say about it?",
    "[1] Example Ltd results for Q1 FY27 (quarter to 2026-06-30): revenue Rs 1,250 Cr, net profit Rs 180 Cr.\n[2] Example Ltd filing 2026-07-14: board approved the results.",
  );
  const reply = said.text;
  if (!reply) {
    console.log("   FAILED - the call returned nothing. Check the model name and the key; the warning above says why.");
    process.exit(1);
  }
  console.log(`   OK\n${reply.split("\n").map((l) => `   ${l}`).join("\n")}`);

  const symbol = process.argv[2] ?? "ITC";
  console.log(`\n2. A real question about ${symbol}, answered from its filings…`);
  const db = new Db({ kind: "local", readOnly: true });
  const a = await ask(db, symbol, "How was the last quarter, and what are the main risks?");
  db.close();
  console.log(`   ${a.headline}`);
  for (const p of a.points) console.log(`   • ${p}`);
  console.log(`   sources: ${a.citations.slice(0, 6).map((c) => `[${c.n}] ${c.label}`).join(", ")}`);
  console.log(`   written by: ${a.writtenBy}${a.writtenBy === "model" ? " (the model phrased it from the cited context)" : " (the model was not used - it returned nothing, so the written answer stood in)"}`);
  process.exit(a.writtenBy === "model" ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
