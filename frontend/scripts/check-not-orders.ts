// Every filing the reader decided was not an order win, checked against the document itself.
//
//   npx tsx scripts/check-not-orders.ts
//
// The reader can refuse a filing for a good reason - a tax demand, a court order, a clarification - and if it
// ever refuses one wrongly, that company's order is missing from the site and nothing says so. This opens each
// refused filing and looks for the words that justify the refusal. Anything without them is printed for a
// person to look at.
import { Db } from "../src/server/db";
import { BSEClient } from "../src/server/bse/client";
import { NSEClient } from "../src/server/nse/client";
import { extract as extractText } from "../src/server/docs/extract";

/** What makes a refusal right: the document is about an order of some other kind. */
const JUSTIFIED = /\b(income tax|gst|customs|excise|adjudicat|order[- ]in[- ]original|show cause|penalty|demand|assessment order|court|tribunal|nclt|nclat|sebi order|litigation|arbitrat|recovery)\b/i;
/** What a real order win says. */
const ORDER_WIN = /\b(work order|purchase order|letter of award|letter of intent|loa\b|bagged|has been awarded|secured an order|receipt of order for|order for supply)\b/i;

async function main() {
  const db = new Db();
  const rows = db.all<Record<string, unknown>>(
    `SELECT company, exchange, pdf_url, substr(announced_at,1,10) d FROM company_order WHERE is_order = 0 ORDER BY announced_at DESC LIMIT 40`);
  const nse = new NSEClient({ rps: 1.2, maxRetries: 2, timeoutS: 45 });
  const bse = new BSEClient({ rps: 1.2, maxRetries: 2, timeoutS: 45 });
  let right = 0, doubtful = 0, unread = 0;

  for (const r of rows) {
    const who = String(r.company ?? "?").slice(0, 30).padEnd(32);
    try {
      const bytes = r.exchange === "NSE" ? await nse.archive(String(r.pdf_url)) : await bse.getBytes(String(r.pdf_url));
      const text = (await extractText(bytes, String(r.pdf_url))).pages.join(" ").replace(/\s+/g, " ");
      const justified = JUSTIFIED.test(text.slice(0, 4_000));
      const looksLikeWin = ORDER_WIN.test(text.slice(0, 4_000));
      if (justified && !looksLikeWin) { right++; continue; }
      doubtful++;
      console.log(`DOUBTFUL ${String(r.d)} ${who} ${justified ? "reads as another kind of order, but also" : "nothing says it is another kind of order, and it"} ${looksLikeWin ? "uses the words of an order win" : "does not say what it is"}`);
      console.log(`         ${String(r.pdf_url).slice(0, 110)}`);
    } catch (e) {
      unread++;
      console.log(`UNREAD   ${String(r.d)} ${who} ${(e as Error).message.slice(0, 50)}`);
    }
  }
  console.log(`\n${right} refusals are justified by the document, ${doubtful} deserve a look, ${unread} could not be fetched`);
  db.close();
  process.exit(doubtful > 0 ? 1 : 0);
}

void main();
