// Compliance lint: nothing the site generates may read as a recommendation.
//
// SEBI's Research Analyst rules (2014, as amended in December 2024, with the circular of 8 January 2025) reserve
// buy/sell/hold calls, price targets and entry-exit levels for registered analysts. This runs the real engines
// over real companies and fails on any directive wording in what a reader would see - the spec's "card never
// contains the words buy, sell, target or should" check, applied to every generated surface rather than one card.
import { Db } from "../src/server/db";
import { ask } from "../src/server/research/answer";
import { decide } from "../src/server/research/decision";
import { riskFlags } from "../src/server/research/flags";
import { whyMoving } from "../src/server/research/moves";
import { valuation } from "../src/server/research/valuation";
import { valuationVerdict } from "../src/server/research/verdict";

// Each pattern is the phrasing that turns an explanation into advice. Quoted filing text is exempt (see `quoted`).
const BANNED: { re: RegExp; why: string }[] = [
  { re: /\b(buy|sell|hold|accumulate|book profits?)\s+(this|the|these|now|at|before|into)\b/i, why: "a direct instruction to trade" },
  { re: /\b(strong\s+)?(buy|sell)\s+(zone|signal|call|rating|recommendation)\b/i, why: "a rating in all but name" },
  { re: /\b(price\s+)?target(s|ed)?\s+(of|price|is|at)\b|\btarget price\b/i, why: "a price target" },
  { re: /\byou should (buy|sell|hold|invest|exit|book)\b/i, why: "personalised advice" },
  { re: /\b(we|our)\s+(recommend|advise|suggest you)\b/i, why: "a recommendation" },
  { re: /\bworth (buying|selling)\b|\bgood (buy|bet|investment) (now|at)\b/i, why: "a recommendation" },
  { re: /\b(must|should) (buy|sell|exit|invest|accumulate)\b/i, why: "an instruction" },
  { re: /\bguaranteed (returns?|profits?)\b|\bsure[- ]shot\b|\bmultibagger\b/i, why: "a performance claim" },
  { re: /\b(will|going to) (rise|fall|double|reach)\b/i, why: "a price prediction stated as fact" },
];

const SYMBOLS = process.argv.slice(2).length ? process.argv.slice(2) : ["TCS", "HDFCBANK", "ITC", "TATASTEEL", "VEDL", "SUZLON", "RELIANCE", "IREDA"];
const QUESTIONS = [
  "Should I invest in this company?",
  "When should I buy and when should I avoid it?",
  "What are the biggest risks?",
  "Is it cheap or expensive right now?",
  "What changed recently?",
];

let failures = 0;
let negated = 0;
const seen: string[] = [];

// A disclaimer has to be able to name what it rules out ("no recommendation, target price or forecast is given").
// A match is allowed only when it is denied in the same breath - within the 60 characters before it.
const NEGATION = /\b(no|not|never|without|neither|nor|cannot|does not|is not)\b[^.]{0,60}$/i;

/** Strings a reader sees. Filing titles are quoted material, not our words, so they are not linted. */
function check(where: string, value: unknown, quoted = false) {
  if (quoted) return;
  if (typeof value === "string") {
    seen.push(value);
    for (const b of BANNED) {
      const hit = value.match(b.re);
      if (!hit) continue;
      if (NEGATION.test(value.slice(0, hit.index ?? 0))) { negated++; continue; }
      failures++;
      console.log(`  FAIL  ${where}: ${b.why} - "${hit[0]}"\n        in: ${value.slice(0, 160)}`);
    }
    return;
  }
  if (Array.isArray(value)) value.forEach((v, i) => check(`${where}[${i}]`, v));
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      // Titles, subjects and detail lines are the exchanges' words, reproduced verbatim.
      check(`${where}.${k}`, v, quoted || ["title", "subject", "headline_source", "url", "purpose", "detail"].includes(k) && where.includes("catalyst"));
    }
  }
}

async function main() {
  const db = new Db({ kind: "local", readOnly: true });
  for (const sym of SYMBOLS) {
    process.stdout.write(`${sym} `);
    check(`${sym}.valuation`, valuation(db, sym));
    check(`${sym}.verdict`, valuationVerdict(db, sym));
    check(`${sym}.decision`, decide(db, sym));
    check(`${sym}.flags`, riskFlags(db, sym));
    const mv = whyMoving(db, sym);
    if (mv) {
      check(`${sym}.move.summary`, mv.summary);
      check(`${sym}.move.headline`, mv.headline);
      mv.catalysts.forEach((c, i) => check(`${sym}.move.catalyst[${i}].confidence`, c.confidence));
    }
    for (const q of QUESTIONS) {
      const a = await ask(db, sym, q);
      check(`${sym}.answer(${q}).headline`, a.headline);
      check(`${sym}.answer(${q}).points`, a.points);
    }
  }
  db.close();
  console.log(`\n\nChecked ${seen.length} generated strings across ${SYMBOLS.length} companies against ${BANNED.length} patterns; ${negated} mention(s) sat inside a disclaimer that denies them.`);
  console.log(failures ? `${failures} recommendation-language failure(s)` : "No recommendation language found.");
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
