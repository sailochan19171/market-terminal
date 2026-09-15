// Full-text indexes over exchange announcements (SQLite FTS5, external content, kept current by triggers).
import type { Db } from "../db";
import { logger } from "../log";

const log = logger("core.search_index");

const INDEXES: [fts: string, src: string, cols: string[]][] = [
  ["nse_announcement_fts", "nse_announcement", ["subject", "company", "symbol"]],
  ["announcement_fts", "announcement", ["headline", "category"]],
];

function ddl(fts: string, src: string, cols: string[]) {
  const c = cols.join(", ");
  const nw = cols.map((x) => `new.${x}`).join(", ");
  const old = cols.map((x) => `old.${x}`).join(", ");
  return `
CREATE VIRTUAL TABLE IF NOT EXISTS ${fts} USING fts5(${c}, content='${src}', content_rowid='rowid', tokenize='unicode61');
CREATE TRIGGER IF NOT EXISTS ${fts}_ai AFTER INSERT ON ${src} BEGIN
  INSERT INTO ${fts}(rowid, ${c}) VALUES (new.rowid, ${nw});
END;
CREATE TRIGGER IF NOT EXISTS ${fts}_ad AFTER DELETE ON ${src} BEGIN
  INSERT INTO ${fts}(${fts}, rowid, ${c}) VALUES ('delete', old.rowid, ${old});
END;
CREATE TRIGGER IF NOT EXISTS ${fts}_au AFTER UPDATE ON ${src} BEGIN
  INSERT INTO ${fts}(${fts}, rowid, ${c}) VALUES ('delete', old.rowid, ${old});
  INSERT INTO ${fts}(rowid, ${c}) VALUES (new.rowid, ${nw});
END;`;
}

/** Create the indexes and triggers if missing. True when usable. */
export function ensure(db: Db, rebuild = false): boolean {
  try {
    for (const [fts, src, cols] of INDEXES) {
      if (!db.hasTable(src)) continue;
      const exists = db.hasTable(fts);
      db.exec(ddl(fts, src, cols));
      if (rebuild || !exists) {
        log.info(`building full-text index ${fts}`);
        db.exec(`INSERT INTO ${fts}(${fts}) VALUES ('rebuild')`);
      }
    }
    return true;
  } catch (e) {
    log.warn(`full-text search unavailable: ${(e as Error).message}`);
    return false;
  }
}

export const available = (db: Db) => INDEXES.every(([fts]) => db.hasTable(fts));

/** User text -> FTS5 query: every word must appear, as a prefix. */
export function matchQuery(text: string): string {
  const words = (text ?? "").match(/[\p{L}\p{N}_]+/gu) ?? [];
  return words.slice(0, 8).map((w) => `"${w.replace(/"/g, "")}"*`).join(" ");
}
