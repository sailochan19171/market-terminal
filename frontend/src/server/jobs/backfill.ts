// Full-history backfill: walks every exchange source backwards, one window at a time, until the exchange has
// nothing older. Progress is stored, so it resumes after restarts; sources take turns so all of them advance.
// Old sessions are kept locally only: the publisher sends the hosted site recent prices and filings.
import { now, type Db } from "../db";
import { logger } from "../log";
import { addDays, sleep, todayIso } from "../util";
import { BSEClient } from "../bse/client";
import { NSEClient } from "../nse/client";
import * as bseBhavcopy from "../bse/bhavcopy";
import * as bseAnnouncements from "../bse/announcements";
import * as nseBhavcopy from "../nse/bhavcopy";
import * as nseIndexHistory from "../nse/indexHistory";
import * as corporate from "../nse/corporate";
import type { StopSignal } from "./worker";

const log = logger("backfill");

interface Source {
  name: string;
  /** Earliest date worth asking for; the walk also stops after two empty years in a row. */
  floor: string;
  /** Days per step, walking back from the earliest date on record. */
  step: number;
  /** Earliest date already on record (where the walk starts). */
  earliest: (db: Db) => string | null;
  /** Rows on record inside [start, end], to tell "the exchange has nothing" from "already collected". */
  count: (db: Db, start: string, end: string) => number;
  run: (db: Db, start: string, end: string) => Promise<number>;
}

const nse = new NSEClient({ rps: 2 });
const nseApi = new NSEClient({ rps: 1, maxRetries: 2, timeoutS: 40 });
const bse = new BSEClient({ rps: 2 });

const between = (table: string, column: string, extra = "") => (db: Db, start: string, end: string) =>
  db.scalar<number>(`SELECT COUNT(*) FROM ${table} WHERE substr(${column}, 1, 10) BETWEEN ? AND ?${extra}`, [start, end]) ?? 0;
const minOf = (table: string, column: string, extra = "") => (db: Db) =>
  db.scalar<string>(`SELECT MIN(substr(${column}, 1, 10)) FROM ${table} WHERE ${column} IS NOT NULL AND ${column} != ''${extra}`);

export const SOURCES: Source[] = [
  {
    name: "nse-bhavcopy", floor: "1994-11-01", step: 365,
    earliest: minOf("nse_bhavcopy_day", "trade_date", " AND status = 'ok'"),
    count: between("nse_bhavcopy_day", "trade_date", " AND status = 'ok'"),
    run: (db, s, e) => nseBhavcopy.sync(nse, db, s, e, false, false),
  },
  {
    name: "bse-bhavcopy", floor: "2000-01-01", step: 365,
    earliest: minOf("bhavcopy_day", "trade_date", " AND status = 'ok'"),
    count: between("bhavcopy_day", "trade_date", " AND status = 'ok'"),
    run: (db, s, e) => bseBhavcopy.sync(bse, db, s, e, { saveRaw: false }),
  },
  {
    name: "nse-index-history", floor: "2005-01-01", step: 365,
    earliest: minOf("nse_index_history_day", "trade_date", " AND status = 'ok'"),
    count: between("nse_index_history_day", "trade_date", " AND status = 'ok'"),
    run: (db, s, e) => nseIndexHistory.sync(nse, db, s, e),
  },
  {
    name: "nse-announcements", floor: "2005-01-01", step: 90,
    earliest: minOf("nse_announcement", "ann_dt"), count: between("nse_announcement", "ann_dt"),
    run: (db, s, e) => corporate.syncAnnouncements(nseApi, db, s, e),
  },
  {
    name: "nse-board-meetings", floor: "2005-01-01", step: 365,
    earliest: minOf("nse_board_meeting", "meeting_dt"), count: between("nse_board_meeting", "meeting_dt"),
    run: (db, s, e) => corporate.syncBoardMeetings(nseApi, db, s, e),
  },
  {
    name: "nse-corp-actions", floor: "2000-01-01", step: 365,
    earliest: minOf("nse_corp_action", "ex_date"), count: between("nse_corp_action", "ex_date"),
    run: (db, s, e) => corporate.syncCorpActions(nseApi, db, s, e),
  },
  {
    name: "nse-insider-trades", floor: "2010-01-01", step: 180,
    earliest: minOf("nse_insider_trade", "broadcast"), count: between("nse_insider_trade", "broadcast"),
    run: (db, s, e) => corporate.syncInsider(nseApi, db, s, e),
  },
  {
    name: "bse-announcements", floor: "2005-01-01", step: 30,
    earliest: minOf("announcement", "news_dt"), count: between("announcement", "news_dt"),
    run: (db, s, e) => bseAnnouncements.sync(bse, db, s, e),
  },
];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS backfill_state (
    source      TEXT PRIMARY KEY,
    reached     TEXT,               -- earliest date covered so far
    empty_days  INTEGER DEFAULT 0,  -- consecutive days walked with nothing on record
    status      TEXT,               -- running | complete | error
    rows        INTEGER DEFAULT 0,
    message     TEXT,
    updated_at  TEXT
);
`;

export function ensureSchema(db: Db) {
  db.exec(SCHEMA);
}

export const progress = (db: Db) => (db.hasTable("backfill_state") ? db.all("SELECT * FROM backfill_state ORDER BY source") : []);

/** One step back for one source. False when that source is complete. */
async function stepSource(db: Db, src: Source): Promise<boolean> {
  const row = db.get<{ reached: string | null; empty_days: number; status: string; rows: number }>("SELECT reached, empty_days, status, rows FROM backfill_state WHERE source = ?", [src.name]);
  if (row?.status === "complete") return false;
  const reached = row?.reached ?? src.earliest(db) ?? todayIso();
  if (reached <= src.floor) {
    db.run("INSERT INTO backfill_state (source, reached, status, message, updated_at) VALUES (?, ?, 'complete', 'reached the floor', ?) ON CONFLICT(source) DO UPDATE SET status = 'complete', message = excluded.message, updated_at = excluded.updated_at", [src.name, reached, now()]);
    return false;
  }
  const end = addDays(reached, -1);
  const start = [addDays(end, -(src.step - 1)), src.floor].sort()[1];
  const t0 = Date.now();
  let written = 0;
  try {
    written = await src.run(db, start, end);
  } catch (e) {
    const message = String((e as Error).message).slice(0, 300);
    log.warn(`${src.name} ${start}..${end}: ${message}`);
    db.run("INSERT INTO backfill_state (source, reached, status, message, updated_at) VALUES (?, ?, 'error', ?, ?) ON CONFLICT(source) DO UPDATE SET status = 'error', message = excluded.message, updated_at = excluded.updated_at", [src.name, reached, message, now()]);
    return true; // retried on a later turn
  }
  const onRecord = src.count(db, start, end);
  const emptyDays = onRecord ? 0 : (row?.empty_days ?? 0) + src.step;
  const complete = emptyDays >= 730; // two years with nothing: the exchange's history starts later
  db.run(`INSERT INTO backfill_state (source, reached, empty_days, status, rows, message, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source) DO UPDATE SET reached = excluded.reached, empty_days = excluded.empty_days, status = excluded.status, rows = backfill_state.rows + excluded.rows, message = excluded.message, updated_at = excluded.updated_at`,
    [src.name, start, emptyDays, complete ? "complete" : "running", written, `${start}..${end}: ${written} rows (${onRecord} on record) in ${Math.round((Date.now() - t0) / 1000)}s`, now()]);
  log.info(`${src.name} ${start}..${end}: ${written} rows${complete ? " - no older data, complete" : ""}`);
  return !complete;
}

/** Take turns across sources until every one is complete, then check again daily. */
export async function backfillLoop(db: Db, stop: StopSignal) {
  ensureSchema(db);
  log.info(`full-history backfill: ${SOURCES.map((s) => s.name).join(", ")}`);
  while (!stop.stopped) {
    let active = 0;
    for (const src of SOURCES) {
      if (stop.stopped) break;
      if (await stepSource(db, src)) active++;
      await sleep(2_000);
    }
    if (!active) {
      log.info("full-history backfill complete; checking again tomorrow");
      const until = Date.now() + 24 * 3600_000;
      while (!stop.stopped && Date.now() < until) await sleep(5_000);
    }
  }
}
