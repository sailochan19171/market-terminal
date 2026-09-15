// Times each query behind /api/v2/home (read-only).
import { DatabaseSync } from "node:sqlite";
import { config } from "../src/server/config";

const db = new DatabaseSync(config.DB_PATH, { readOnly: true });
const q = (label: string, sql: string) => {
  const t = Date.now();
  db.prepare(sql).all();
  console.log(`${String(Date.now() - t).padStart(6)} ms  ${label}`);
};
q("max index date", "SELECT MAX(trade_date) FROM nse_index_history");
q("breadth", "SELECT SUM(pct_1d > 0) FROM company_metrics WHERE close IS NOT NULL");
q("announcements latest", "SELECT symbol FROM nse_announcement ORDER BY ann_dt DESC LIMIT 20");
q("count distinct index", "SELECT COUNT(DISTINCT index_name) FROM nse_index_history");
q("count nse_announcement", "SELECT COUNT(*) FROM nse_announcement");
q("count announcement", "SELECT COUNT(*) FROM announcement");
for (const r of db.prepare("EXPLAIN QUERY PLAN SELECT symbol FROM nse_announcement ORDER BY ann_dt DESC LIMIT 20").all()) console.log(r);
