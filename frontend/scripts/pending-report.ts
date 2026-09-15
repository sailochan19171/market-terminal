// Pending work per exchange, data type and year (read-only).
import { DatabaseSync } from "node:sqlite";
import { config } from "../src/server/config";

const db = new DatabaseSync(config.DB_PATH, { readOnly: true });
const all = (sql: string) => db.prepare(sql).all() as Record<string, unknown>[];
const one = (sql: string) => db.prepare(sql).get() as Record<string, unknown>;

console.log("RESULTS (NSE XBRL) pending by year");
for (const r of all(`SELECT substr(r.period_end,1,4) yr, COUNT(*) total, SUM(f.symbol IS NULL) pending FROM nse_financial_result r
  LEFT JOIN nse_fundamental f ON f.symbol=r.symbol AND f.period_end=r.period_end AND f.consolidated=r.consolidated
  WHERE r.xbrl_url != '' GROUP BY yr ORDER BY yr`)) console.log(`  ${r.yr}  pending ${String(r.pending).padStart(6)} of ${r.total}`);

console.log("STATEMENTS (balance sheet / cash flow, half-year and annual) pending by year");
for (const r of all(`SELECT substr(r.period_end,1,4) yr, COUNT(*) total, SUM(s.symbol IS NULL) pending FROM nse_financial_result r
  LEFT JOIN (SELECT DISTINCT symbol, period_end, consolidated FROM nse_statement) s ON s.symbol=r.symbol AND s.period_end=r.period_end AND s.consolidated=r.consolidated
  WHERE r.xbrl_url != '' AND substr(r.period_end,6,2) IN ('03','09') GROUP BY yr ORDER BY yr`)) console.log(`  ${r.yr}  pending ${String(r.pending).padStart(6)} of ${r.total}`);

console.log("SHAREHOLDING detail: filings listed vs read, by year");
for (const r of all(`SELECT substr(s.as_of_date,1,4) yr, COUNT(*) listed, SUM(d.symbol IS NOT NULL) have FROM nse_shareholding s
  LEFT JOIN nse_shareholding_detail d ON d.symbol=s.symbol AND d.as_of_date=s.as_of_date GROUP BY yr ORDER BY yr`)) console.log(`  ${r.yr}  read ${String(r.have).padStart(5)} of ${r.listed}`);

console.log("PRICES / FILINGS on record");
console.log("  NSE bhavcopy", JSON.stringify(one("SELECT MIN(trade_date) first, MAX(trade_date) last, COUNT(*) days FROM nse_bhavcopy_day WHERE status='ok'")));
console.log("  BSE bhavcopy", JSON.stringify(one("SELECT MIN(trade_date) first, MAX(trade_date) last, COUNT(*) days FROM bhavcopy_day WHERE status='ok'")));
console.log("  NSE announcements", JSON.stringify(one("SELECT MIN(substr(ann_dt,1,10)) first, COUNT(*) n FROM nse_announcement")));
console.log("  BSE announcements", JSON.stringify(one("SELECT MIN(substr(news_dt,1,10)) first, COUNT(*) n FROM announcement")));
console.log("  NSE corp actions", JSON.stringify(one("SELECT MIN(ex_date) first, COUNT(*) n FROM nse_corp_action WHERE ex_date != ''")));
console.log("  BSE corp actions", JSON.stringify(one("SELECT MIN(ex_date) first, COUNT(*) n FROM corp_action WHERE ex_date != ''")));
console.log("  NSE board meetings", JSON.stringify(one("SELECT MIN(substr(meeting_dt,1,10)) first, COUNT(*) n FROM nse_board_meeting")));
console.log("  NSE insider trades", JSON.stringify(one("SELECT MIN(substr(fetched_at,1,10)) fetched_from, COUNT(*) n FROM nse_insider_trade")));

console.log("COMPANIES");
console.log("  BSE-listed scrips (equity, active)", one("SELECT COUNT(*) n FROM scrip WHERE status='Active'").n);
console.log("  BSE-only companies (no NSE listing) with prices", one("SELECT COUNT(*) n FROM scrip s WHERE s.status='Active' AND (s.isin IS NULL OR s.isin NOT IN (SELECT isin FROM nse_symbol WHERE isin IS NOT NULL)) AND s.scrip_cd IN (SELECT DISTINCT scrip_cd FROM bhavcopy WHERE trade_date = (SELECT MAX(trade_date) FROM bhavcopy))").n);
console.log("  since the runner restart (15:08 IST): results saved", one("SELECT COUNT(*) n FROM nse_fundamental WHERE fetched_at >= '2026-09-15T09:38:00+00:00'").n,
  "| statements", one("SELECT COUNT(*) n FROM nse_statement WHERE fetched_at >= '2026-09-15T09:38:00+00:00'").n,
  "| shareholding", one("SELECT COUNT(*) n FROM nse_shareholding_detail WHERE fetched_at >= '2026-09-15T09:38:00+00:00'").n);
