// Row counts, primary keys and change-tracking columns per table (read-only).
import { DatabaseSync } from "node:sqlite";
import { config } from "../src/server/config";

const db = new DatabaseSync(config.DB_PATH, { readOnly: true });
const tables = db.prepare("SELECT name, type FROM sqlite_master WHERE type IN ('table') AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[];
for (const { name } of tables) {
  if (/_(data|idx|content|docsize|config)$/.test(name) && db.prepare("SELECT 1 FROM sqlite_master WHERE name = ?").get(name.replace(/_(data|idx|content|docsize|config)$/, ""))) continue;
  const cols = db.prepare(`PRAGMA table_info("${name}")`).all() as { name: string; pk: number }[];
  const pk = cols.filter((c) => c.pk).sort((a, b) => a.pk - b.pk).map((c) => c.name);
  const stamps = cols.map((c) => c.name).filter((c) => /(_at|_dt|date|as_of|updated|fetched)$/i.test(c));
  let n: number | string = "?";
  try {
    n = (db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get() as { n: number }).n;
  } catch (e) {
    n = `err ${(e as Error).message.slice(0, 40)}`;
  }
  console.log(`${String(n).padStart(9)}  ${name.padEnd(34)} pk=[${pk.join(",")}] stamps=[${stamps.join(",")}]`);
}
