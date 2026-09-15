// Consistent, compacted copy of the live database (safe while the app and jobs are running).
//   npx tsx scripts/snapshot-db.ts D:/market-deploy/bse.db
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { config } from "../src/server/config";

const target = process.argv[2];
if (!target) {
  console.error("usage: snapshot-db.ts <target file>");
  process.exit(2);
}
fs.mkdirSync(path.dirname(target), { recursive: true });
if (fs.existsSync(target)) fs.unlinkSync(target);

const t = Date.now();
const db = new DatabaseSync(config.DB_PATH, { readOnly: true });
db.exec("PRAGMA busy_timeout = 120000");
db.prepare("VACUUM INTO ?").run(target);
db.close();
const check = new DatabaseSync(target, { readOnly: true });
const ok = (check.prepare("PRAGMA quick_check").get() as { quick_check: string }).quick_check;
const rows = (check.prepare("SELECT COUNT(*) AS n FROM nse_bhavcopy").get() as { n: number }).n;
check.close();
console.log(`snapshot ${target}: ${(fs.statSync(target).size / 1e9).toFixed(2)} GB in ${((Date.now() - t) / 1000).toFixed(0)}s, quick_check=${ok}, nse_bhavcopy=${rows}`);
