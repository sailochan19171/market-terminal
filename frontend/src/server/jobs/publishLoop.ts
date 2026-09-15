// Keeps the hosted site's Turso copy current from this PC: data every 30 minutes, the live pulse every
// minute while NSE is trading (every 15 minutes otherwise). Runs only when Turso credentials are in .env.
import type { Db } from "../db";
import { logger } from "../log";
import { sleep } from "../util";
import { isConfigured, marketHours, publish, publishLive } from "./publish";
import type { StopSignal } from "./worker";

const log = logger("publish");

const DATA_EVERY_MS = 30 * 60_000;
const LIVE_OPEN_MS = 60_000;
const LIVE_CLOSED_MS = 15 * 60_000;

async function waitFor(ms: number, stop: StopSignal) {
  const until = Date.now() + ms;
  while (!stop.stopped && Date.now() < until) await sleep(Math.min(2_000, until - Date.now()));
}

export async function publishDataLoop(db: Db, stop: StopSignal) {
  if (!isConfigured()) return;
  log.info("publishing to the hosted database every 30 minutes");
  while (!stop.stopped) {
    try {
      const sent = publish(db);
      const total = Object.values(sent).reduce((a, b) => a + b, 0);
      log.info(`published ${total} rows`);
    } catch (e) {
      log.error(`publish failed: ${(e as Error).message}`);
    }
    await waitFor(DATA_EVERY_MS, stop);
  }
}

export async function publishLiveLoop(stop: StopSignal) {
  if (!isConfigured()) return;
  while (!stop.stopped) {
    try {
      await publishLive();
    } catch (e) {
      log.warn(`live pulse publish failed: ${(e as Error).message}`);
    }
    await waitFor(marketHours() ? LIVE_OPEN_MS : LIVE_CLOSED_MS, stop);
  }
}
