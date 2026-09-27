import { orderBookFromText, readAsOf } from "../src/server/orders/orderBook";

const cases: [string, number | null, string | null][] = [
  ["Order Book: Rs. 1,854.14 Cr as on 30th June, 2026", 1854.14, "2026-06-30"],
  ["Total Order Book stands at INR 6,630 crore as on June 30, 2026", 6630, "2026-06-30"],
  ["Our order book position as on 31.03.2026 is Rs 5,143.3 crores", 5143.3, "2026-03-31"],
  ["Outstanding order book of ₹12,115 Cr (Q1 FY27)", 12115, "2026-06-30"],
  ["Order book 1945.5", null, null],
  ["Order book Rs 1,945.5 Cr", 1945.5, null],
  ["Current Order Book as experience in Ashoka Family st on 31 March 2026 construction ACUITE 16,000 LANE Kms", null, null],
  ["Order Book Execution (as of June, 26) 5 COMPANY OVERVIEW", null, null],
  ["Revenue of Rs 245.03 Cr for FY2026", null, null],
  ["Market capitalisation Rs 4,000 crore", null, null],
];
let bad = 0;
for (const [text, wantValue, wantAsOf] of cases) {
  const got = orderBookFromText(text);
  const okValue = (got?.valueCr ?? null) === wantValue;
  const okAsOf = (got?.asOf ?? null) === wantAsOf;
  if (!okValue || !okAsOf) bad++;
  console.log(`${okValue && okAsOf ? "ok  " : "FAIL"} "${text.slice(0, 52)}" -> ${got?.valueCr ?? null} cr, as on ${got?.asOf ?? "-"} (want ${wantValue}, ${wantAsOf})`);
}
console.log("\ndates on their own:");
for (const [t, want] of [["as on 30 September 2026", "2026-09-30"], ["Q3 FY2026", "2025-12-31"], ["Q4 FY26", "2026-03-31"]] as const) {
  const got = readAsOf(t);
  if (got !== want) bad++;
  console.log(`${got === want ? "ok  " : "FAIL"} ${t} -> ${got} (want ${want})`);
}
console.log(bad ? `\n${bad} failed` : "\nall passed");
