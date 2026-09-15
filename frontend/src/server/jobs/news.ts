// Intraday refresh: exchanges publish filings all day, so the last day or two of announcements, board meetings
// and corporate actions are re-read every half hour rather than waiting for the 19:30 daily run. The publisher
// then carries them to the hosted site on its own half-hourly turn.
import type { Db } from "../db";
import { logger } from "../log";
import { addDays, sleep, todayIso } from "../util";
import { BSEClient } from "../bse/client";
import { NSEClient } from "../nse/client";
import * as bseAnnouncements from "../bse/announcements";
import * as corporate from "../nse/corporate";
import type { StopSignal } from "./worker";

const log = logger("news");

const EVERY_MS = 30 * 60_000;
const QUIET_MS = 2 * 3600_000;
/** Filings appear from before the open until well after the close (IST). */
const FROM_HOUR = 7;
const TO_HOUR = 22;

function tradingHours(at = new Date()): boolean {
  const ist = new Date(at.toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  return ist.getDay() >= 1 && ist.getDay() <= 5 && ist.getHours() >= FROM_HOUR && ist.getHours() < TO_HOUR;
}

export async function newsLoop(db: Db, stop: StopSignal) {
  const nse = new NSEClient({ rps: 1, maxRetries: 2, timeoutS: 40 });
  const bse = new BSEClient({ rps: 2 });
  log.info("intraday filings refresh every 30 minutes on weekdays");
  while (!stop.stopped) {
    if (tradingHours()) {
      const today = todayIso();
      const from = addDays(today, -1);
      try {
        const counts = {
          nse: await corporate.syncAnnouncements(nse, db, from, today),
          bse: await bseAnnouncements.sync(bse, db, from, today, { refetch: true }),
          meetings: await corporate.syncBoardMeetings(nse, db, from, today),
          actions: await corporate.syncCorpActions(nse, db, from, addDays(today, 30)),
        };
        if (Object.values(counts).some(Boolean)) log.info(`intraday: ${counts.nse} NSE + ${counts.bse} BSE filings, ${counts.meetings} board meetings, ${counts.actions} corporate actions`);
      } catch (e) {
        log.warn(`intraday refresh: ${(e as Error).message}`);
      }
    }
    const until = Date.now() + (tradingHours() ? EVERY_MS : QUIET_MS);
    while (!stop.stopped && Date.now() < until) await sleep(5_000);
  }
}
