// What the local database holds and what is still pending, per data type (read-only).
//   npx tsx scripts/coverage-report.ts [SYMBOL]
import { DatabaseSync } from "node:sqlite";
import { config } from "../src/server/config";

const db = new DatabaseSync(config.DB_PATH, { readOnly: true });
const one = (sql: string, ...p: (string | number)[]) => db.prepare(sql).get(...p) as Record<string, unknown>;
const all = (sql: string, ...p: (string | number)[]) => db.prepare(sql).all(...p) as Record<string, unknown>[];

console.log("== price history");
for (const t of ["nse_bhavcopy_day", "bhavcopy_day", "nse_index_history_day"]) console.log(t.padEnd(24), JSON.stringify(one(`SELECT MIN(trade_date) first, MAX(trade_date) last, COUNT(*) sessions FROM ${t} WHERE status = 'ok'`)));
console.log("announcements (NSE)".padEnd(24), JSON.stringify(one("SELECT MIN(substr(ann_dt,1,10)) first, MAX(substr(ann_dt,1,10)) last, COUNT(*) n FROM nse_announcement")));
console.log("announcements (BSE)".padEnd(24), JSON.stringify(one("SELECT MIN(substr(news_dt,1,10)) first, MAX(substr(news_dt,1,10)) last, COUNT(*) n FROM announcement")));

console.log("\n== quarterly results (NSE filings vs parsed figures), by financial-year end");
for (const r of all(`SELECT substr(r.period_end,1,4) yr, COUNT(*) filings, SUM(f.symbol IS NOT NULL) parsed, COUNT(DISTINCT r.symbol) companies
  FROM nse_financial_result r LEFT JOIN nse_fundamental f ON f.symbol = r.symbol AND f.period_end = r.period_end AND f.consolidated = r.consolidated
  WHERE r.xbrl_url IS NOT NULL AND r.xbrl_url != '' GROUP BY yr ORDER BY yr`)) {
  console.log(`  ${r.yr}: ${String(r.parsed).padStart(6)} of ${String(r.filings).padStart(6)} filings parsed (${Math.round((Number(r.parsed) / Number(r.filings)) * 100)}%), ${r.companies} companies`);
}
const listed = one("SELECT COUNT(*) n FROM company_metrics WHERE close IS NOT NULL").n;
console.log("companies with any parsed results:", one("SELECT COUNT(DISTINCT symbol) n FROM nse_fundamental").n, "of", listed, "with prices");
console.log("companies with 4+ quarters parsed:", one("SELECT COUNT(*) n FROM (SELECT symbol FROM nse_fundamental WHERE quality = 'ok' GROUP BY symbol HAVING COUNT(DISTINCT period_end) >= 4)").n);
console.log("companies with balance sheet/cash flow:", one("SELECT COUNT(DISTINCT symbol) n FROM nse_statement WHERE kind != 'none'").n);
console.log("companies with shareholding detail:", one("SELECT COUNT(DISTINCT symbol) n FROM nse_shareholding_detail").n, "| shareholding filings listed:", one("SELECT COUNT(DISTINCT symbol) n FROM nse_shareholding").n);

const sym = process.argv[2];
if (sym) {
  console.log(`\n== ${sym}`);
  console.log("result filings:", JSON.stringify(one("SELECT COUNT(*) n, MIN(period_end) first, MAX(period_end) last FROM nse_financial_result WHERE symbol = ? AND xbrl_url != ''", sym)));
  console.log("parsed quarters:", JSON.stringify(one("SELECT COUNT(*) n, MIN(period_end) first, MAX(period_end) last FROM nse_fundamental WHERE symbol = ?", sym)));
  console.log("statements:", one("SELECT COUNT(*) n FROM nse_statement WHERE symbol = ?", sym).n, "| shareholding detail:", one("SELECT COUNT(*) n FROM nse_shareholding_detail WHERE symbol = ?", sym).n);
  console.log("metrics row:", JSON.stringify(one("SELECT close, pe, market_cap_cr, sales_qtr_cr, np_qtr_cr FROM company_metrics WHERE symbol = ?", sym)));
}
