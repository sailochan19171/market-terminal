// The announcement watcher, as a background loop beside the other job loops.
//
// Two paths to the same row, so a filing cannot go missing: this polls the live feed every minute and writes
// new filings as they appear, while the daily sweep re-walks the last days in full. A day the exchange answers
// with nothing is left open and tried again rather than marked done (bse/announcements.ts).
import type { Db } from "../db";
import { logger } from "../log";
import { watch } from "../bse/live";
import type { StopSignal } from "./worker";

const log = logger("watch");

/** Filings arrive through the day; polling every minute keeps the gap to about that. */
const EVERY_MS = 60_000;

export async function watchLoop(db: Db, stop: StopSignal) {
  log.info("watching BSE announcements for new filings");
  const seen = await watch(db, { intervalMs: EVERY_MS, readOrders: true, stop });
  log.info(`watcher stopped after ${seen.polls} polls: ${seen.filings} filings, ${seen.orders} order wins`);
}
