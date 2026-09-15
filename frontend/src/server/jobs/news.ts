// Filings refresh: exchanges publish announcements at all hours, including weekends, so the last day or two of
// announcements, board meetings and corporate actions are re-read every 20 minutes rather than waiting for the
// 19:30 daily run. The publisher carries them to the hosted site on its own 20-minute turn.
import type { Db } from "../db";
import { logger } from "../log";
import { addDays, sleep, todayIso } from "../util";
import { BSEClient } from "../bse/client";
import { NSEClient } from "../nse/client";
import * as bseAnnouncements from "../bse/announcements";
import * as corporate from "../nse/corporate";
import type { StopSignal } from "./worker";

const log = logger("news");

const EVERY_MS = 20 * 60_000;

export async function newsLoop(db: Db, stop: StopSignal) {
  const nse = new NSEClient({ rps: 1, maxRetries: 2, timeoutS: 40 });
  const bse = new BSEClient({ rps: 2 });
  log.info("filings refresh every 20 minutes, every day");
  while (!stop.stopped) {
    const today = todayIso();
    const from = addDays(today, -1);
    try {
      const counts = {
        nse: await corporate.syncAnnouncements(nse, db, from, today),
        bse: await bseAnnouncements.sync(bse, db, from, today, { refetch: true }),
        meetings: await corporate.syncBoardMeetings(nse, db, from, today),
        actions: await corporate.syncCorpActions(nse, db, from, addDays(today, 30)),
      };
      if (Object.values(counts).some(Boolean)) log.info(`${counts.nse} NSE + ${counts.bse} BSE filings, ${counts.meetings} board meetings, ${counts.actions} corporate actions`);
    } catch (e) {
      log.warn(`filings refresh: ${(e as Error).message}`);
    }
    const until = Date.now() + EVERY_MS;
    while (!stop.stopped && Date.now() < until) await sleep(5_000);
  }
}
