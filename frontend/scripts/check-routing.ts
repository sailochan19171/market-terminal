// Does a question reach the answer it asks for?
//
// The written answers are chosen by a regular expression over the question, and a pattern without word
// boundaries is a quiet trap: "p/e" matched the "pe" inside "operating", sending a question about margins to
// the valuation answer. These cases pin the routing so that cannot come back.
//   npm run check:routing
import { intentOf } from "../src/server/research/answer";
const CASES: [string, string][] = [
  ["What are the operating and net margins?", "profit"],
  ["How fast are revenue and profit growing?", "profit"],
  ["What is the dividend history and the payout ratio?", "dividend"],
  ["How much debt does the company carry?", "debt"],
  ["Is the stock cheap or expensive against its peers?", "valuation"],
  ["What is the P/E?", "valuation"],
  ["Who holds the shares - promoters, FIIs or the public?", "shareholding"],
  ["How much free cash flow does it generate?", "cash"],
  ["What are the biggest risks?", "risks"],
  ["What did the company file with the exchanges recently?", "news"],
  ["How has the share price performed over the last year?", "overview"],
  ["Should I invest in this company?", "invest"],
  ["When should I buy?", "when_buy"],
];
let bad = 0;
console.log("question routing\n");
for (const [q, want] of CASES) {
  const got = intentOf(q);
  if (got !== want) bad++;
  console.log(`${got === want ? "ok  " : "WRONG"} ${got.padEnd(12)} want ${want.padEnd(12)} ${q}`);
}
console.log(bad ? `\n${bad} question(s) routed to the wrong answer` : `\nAll ${CASES.length} questions routed correctly`);
process.exit(bad ? 1 : 0);
