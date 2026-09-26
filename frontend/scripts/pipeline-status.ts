// What the pipeline holds right now: how fresh each dataset is, and how many orders have been read.
// Printed at the end of each scheduled run so a glance at the log says whether data is still flowing.
//   npx tsx scripts/pipeline-status.ts            — print the state
//   npx tsx scripts/pipeline-status.ts --strict   — and fail the run when a dataset has fallen behind
//
// --strict is what the scheduled job uses. A step that quietly gives up - NSE refusing a request from a
// datacentre, say - otherwise leaves a green run with two-day-old data behind it, which is worse than a red one:
// nobody goes looking for a problem the log says is not there.
import { Db } from "../src/server/db";

// The exchanges write their timestamps in Indian time with no zone on them, so a run on a UTC machine has to
// add the offset back or every filing looks like it is from the future.
const IST_OFFSET = "+05:30";

// A date on its own - "2026-09-24", which is how a day's prices are keyed - is read as the end of that trading
// day, not midnight, so a file published after the close is not counted as eighteen hours late the moment it lands.
const stamp = (iso: string) => {
  if (/[zZ]|[+-]\d\d:\d\d$/.test(iso)) return iso;
  const withTime = /\d{2}:\d{2}/.test(iso) ? iso.replace(" ", "T") : `${iso}T18:00:00`;
  return `${withTime}${IST_OFFSET}`;
};

/** Hours since a timestamp, or null when there is none - and null too when it cannot be read at all. */
const hoursSince = (iso: string | null) => {
  if (iso === null) return null;
  const ms = new Date(stamp(iso)).getTime();
  return Number.isFinite(ms) ? (Date.now() - ms) / 3_600_000 : null;
};

const ago = (iso: string | null) => {
  const h = hoursSince(iso);
  if (h === null) return "never";
  const mins = Math.round(h * 60);
  if (mins < 60) return `${mins} min ago`;
  if (mins < 1440) return `${Math.round(mins / 60)} h ago`;
  return `${Math.round(mins / 1440)} days ago`;
};

/** Indian time, which is what the exchanges' days are counted in. */
const istNow = () => new Date(Date.now() + 5.5 * 3_600_000);
const isWeekend = (d: Date) => d.getUTCDay() === 0 || d.getUTCDay() === 6;

/**
 * How long a dataset may go without new rows before something is wrong. A weekend has no filings and no session,
 * so the allowance stretches over it rather than crying wolf every Saturday: three days covers Friday evening to
 * Monday morning, and a long weekend is caught by the next run after the holiday.
 */
function allowanceHours(base: number) {
  const d = istNow();
  return isWeekend(d) || d.getUTCDay() === 1 ? base + 72 : base;
}

/**
 * The last trading session that should already have a price file. Both exchanges publish one after the close, so
 * today counts only once the evening has passed; before that, and at a weekend, the answer is the Friday or
 * whichever weekday came last. A market holiday has no file and will read as one session behind for a day - a red
 * cross that takes a moment to check, which is the right way round compared with silence over stale prices.
 */
function lastExpectedSession(): string {
  const d = istNow();
  if (isWeekend(d) || d.getUTCHours() < 19) d.setUTCDate(d.getUTCDate() - 1);   // yesterday, or earlier
  while (isWeekend(d)) d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

interface Check { label: string; newest: string | null; count: string; allowHours: number | null; session?: boolean }

function main() {
  const strict = process.argv.includes("--strict");
  const db = new Db();
  const n = (q: string) => Number(db.scalar<number>(q) ?? 0).toLocaleString("en-IN");
  const t = (q: string) => db.scalar<string>(q) ?? null;

  console.log(`database: ${db.isRemote ? "the hosted copy" : "this machine"}`);

  // Each dataset, with how stale it may be before the run is called a failure. Announcements arrive through the
  // day, so a few hours of silence in market hours is already odd; prices arrive once, after the close.
  const checks: Check[] = [
    { label: "BSE announcements", newest: t("SELECT MAX(news_dt) FROM announcement"), count: n("SELECT COUNT(*) FROM announcement"), allowHours: 24 },
    { label: "NSE announcements", newest: t("SELECT MAX(ann_dt) FROM nse_announcement"), count: n("SELECT COUNT(*) FROM nse_announcement"), allowHours: 24 },
    { label: "BSE daily prices", newest: t("SELECT MAX(trade_date) FROM bhavcopy"), count: n("SELECT COUNT(*) FROM bhavcopy"), allowHours: null, session: true },
    { label: "NSE daily prices", newest: t("SELECT MAX(trade_date) FROM nse_bhavcopy"), count: n("SELECT COUNT(*) FROM nse_bhavcopy"), allowHours: null, session: true },
    { label: "orders read", newest: t("SELECT MAX(announced_at) FROM company_order"), count: n("SELECT COUNT(*) FROM company_order WHERE is_order = 1"), allowHours: 48 },
  ];

  const session = lastExpectedSession();
  const behind: string[] = [];
  for (const c of checks) {
    let late: boolean, why = "";
    if (c.session) {
      const day = (c.newest ?? "").slice(0, 10);
      late = day < session;
      why = `the newest price file is for ${day || "no day at all"}, and the session of ${session} should be in by now`;
    } else {
      const h = hoursSince(c.newest);
      const allow = allowanceHours(c.allowHours ?? 24);
      late = h === null || !Number.isFinite(h) || h > allow;
      why = `it last gained a row ${ago(c.newest)}, past the ${allow} h this dataset is allowed`;
    }
    console.log(`${late ? "BEHIND  " : "ok      "}${c.label.padEnd(18)}: ${c.count.padStart(9)} rows (newest ${c.session ? (c.newest ?? "never") : ago(c.newest)})`);
    if (late) behind.push(`${c.label}: ${why}`);
  }

  console.log(`  orders with a value   : ${n("SELECT COUNT(*) FROM company_order WHERE contract_value_cr IS NOT NULL")}`);
  console.log(`  orders with a customer: ${n("SELECT COUNT(*) FROM company_order WHERE customer IS NOT NULL")}`);
  console.log(`  order filings still unread: ${n(`SELECT COUNT(*) FROM announcement a WHERE a.subcategory = 'Award of Order / Receipt of Order' AND a.news_dt >= date('now','-7 days') AND NOT EXISTS (SELECT 1 FROM company_order_seen s WHERE s.id = 'BSE:' || a.news_id)`)}`);
  db.close();

  if (behind.length) {
    console.log(`\n${behind.length} dataset${behind.length === 1 ? " has" : "s have"} fallen behind:`);
    for (const b of behind) console.log(`  - ${b}`);
    if (strict) {
      console.log("\nFailing the run so this shows up as a red cross rather than a green tick over stale data.");
      process.exit(1);
    }
  } else {
    console.log("\nEvery dataset is current.");
  }
}

main();
