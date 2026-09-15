// What the hosted (Turso) database holds, compared with this PC's copy.
//   MARKET_DB=turso npx tsx scripts/hosted-report.ts
import { Db, defaultTarget } from "../src/server/db";

const QUERIES: [string, string][] = [
  ["NSE sessions", "SELECT COUNT(*) FROM nse_bhavcopy_day WHERE status = 'ok'"],
  ["NSE price rows", "SELECT COUNT(*) FROM nse_bhavcopy"],
  ["BSE sessions", "SELECT COUNT(*) FROM bhavcopy_day WHERE status = 'ok'"],
  ["BSE price rows", "SELECT COUNT(*) FROM bhavcopy"],
  ["index history rows", "SELECT COUNT(*) FROM nse_index_history"],
  ["results parsed", "SELECT COUNT(*) FROM nse_fundamental"],
  ["balance sheet / cash flow", "SELECT COUNT(*) FROM nse_statement"],
  ["shareholding detail", "SELECT COUNT(*) FROM nse_shareholding_detail"],
  ["NSE announcements", "SELECT COUNT(*) FROM nse_announcement"],
  ["BSE announcements", "SELECT COUNT(*) FROM announcement"],
  ["BSE corp actions dated", "SELECT COUNT(*) FROM corp_action WHERE record_date != ''"],
  ["company metrics", "SELECT COUNT(*) FROM company_metrics"],
  ["stored analyses", "SELECT COUNT(*) FROM analysis_version"],
];

async function main() {
  const hosted = new Db(defaultTarget());
  const local = new Db({ kind: "local", readOnly: true });
  console.log(`${"".padEnd(26)} ${"hosted (Netlify)".padStart(16)} ${"local (this PC)".padStart(16)}`);
  for (const [label, sql] of QUERIES) {
    const h = hosted.scalar<number>(sql) ?? 0;
    const l = local.scalar<number>(sql) ?? 0;
    console.log(`${label.padEnd(26)} ${String(h).padStart(16)} ${String(l).padStart(16)}${h < l ? "   (publishing)" : ""}`);
  }
  console.log("live pulse published at", hosted.scalar("SELECT updated_at FROM published_value WHERE key = 'live_pulse'"));
  console.log("site counts published at", hosted.scalar("SELECT updated_at FROM published_value WHERE key = 'site_stats'"));
  hosted.close();
  local.close();
}
main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
