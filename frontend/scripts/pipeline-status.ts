// What the pipeline holds right now: how fresh the announcements are, and how many orders have been read.
// Printed at the end of each scheduled run so a glance at the log says whether data is still flowing.
//   npx tsx scripts/pipeline-status.ts
import { Db } from "../src/server/db";

// The exchanges write their timestamps in Indian time with no zone on them, so a run on a UTC machine has to
// add the offset back or every filing looks like it is from the future.
const IST_OFFSET = "+05:30";

const ago = (iso: string | null) => {
  if (!iso) return "never";
  const stamped = /[zZ]|[+-]\d\d:\d\d$/.test(iso) ? iso : `${iso.replace(" ", "T")}${IST_OFFSET}`;
  const mins = Math.round((Date.now() - new Date(stamped).getTime()) / 60_000);
  if (mins < 60) return `${mins} min ago`;
  if (mins < 1440) return `${Math.round(mins / 60)} h ago`;
  return `${Math.round(mins / 1440)} days ago`;
};

function main() {
  const db = new Db();
  const n = (q: string) => Number(db.scalar<number>(q) ?? 0).toLocaleString("en-IN");
  const t = (q: string) => db.scalar<string>(q) ?? null;

  console.log(`database: ${db.isRemote ? "the hosted copy" : "this machine"}`);
  console.log(`BSE announcements: ${n("SELECT COUNT(*) FROM announcement")} (newest ${ago(t("SELECT MAX(news_dt) FROM announcement"))})`);
  console.log(`NSE announcements: ${n("SELECT COUNT(*) FROM nse_announcement")} (newest ${ago(t("SELECT MAX(ann_dt) FROM nse_announcement"))})`);
  console.log(`orders read      : ${n("SELECT COUNT(*) FROM company_order WHERE is_order = 1")} (newest ${ago(t("SELECT MAX(announced_at) FROM company_order"))})`);
  console.log(`  with a value   : ${n("SELECT COUNT(*) FROM company_order WHERE contract_value_cr IS NOT NULL")}`);
  console.log(`  with a customer: ${n("SELECT COUNT(*) FROM company_order WHERE customer IS NOT NULL")}`);
  console.log(`order filings still unread: ${n(`SELECT COUNT(*) FROM announcement a WHERE a.subcategory = 'Award of Order / Receipt of Order' AND a.news_dt >= date('now','-7 days') AND NOT EXISTS (SELECT 1 FROM company_order_seen s WHERE s.id = 'BSE:' || a.news_id)`)}`);
  db.close();
}

main();
