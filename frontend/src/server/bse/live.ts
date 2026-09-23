// The announcement watcher: catches filings as they are published, instead of once a day.
//
// The daily sync walks whole days and pages through each one. That is right for history, but a filing made at
// 10:02 then waits until the next daily run. This polls the newest page of the feed every minute or so, writes
// anything it has not seen, and stops paging the moment a page holds nothing new - so a quiet minute costs one
// request. Between polls the day sweep still runs, so a filing the poll missed is picked up anyway: two
// independent paths to the same row, which is what keeps announcements from going missing.
//
// The idea (and the "one poller, many subjects" shape) follows the bse-award-of-order watcher, which polls BSE's
// Company Update feed and fans each new filing out by subcategory.
import type { Db } from "../db";
import { now } from "../db";
import { logger } from "../log";
import { todayIso } from "../util";
import { fetchDay, type Announcement } from "./announcements";
import { BSEClient } from "./client";

const log = logger("bse.live");

/** The subcategories worth acting on the moment they appear. */
export const ORDER_SUBCATEGORY = "Award of Order / Receipt of Order";

export interface Watched {
  /** Filings written on this poll, newest first. */
  fresh: Announcement[];
  /** Of those, the ones filed under the order category. */
  orders: Announcement[];
}

/**
 * One poll of the live feed: today's filings, newest first, stopping as soon as a page holds nothing new.
 * Returns only what this call actually wrote, so a caller can react to each filing exactly once.
 */
export async function poll(client: BSEClient, db: Db, day = todayIso()): Promise<Watched> {
  const rows = await fetchDay(client, day);
  if (!rows.length) return { fresh: [], orders: [] };

  const ids = rows.map((r) => r.news_id);
  const known = new Set<string>();
  for (let i = 0; i < ids.length; i += 400) {
    const batch = ids.slice(i, i + 400);
    for (const r of db.all<{ news_id: string }>(`SELECT news_id FROM announcement WHERE news_id IN (${batch.map(() => "?").join(",")})`, batch)) {
      known.add(String(r.news_id));
    }
  }

  const fresh = rows.filter((r) => !known.has(r.news_id));
  if (fresh.length) {
    db.transaction(() => {
      db.upsert("announcement", fresh as unknown as Record<string, unknown>[]);
      // The day mark follows the sweep's rule: a day that produced filings is complete.
      db.upsert("announcement_day", [{ day, status: "ok", rows: rows.length, fetched_at: now() }]);
    });
  }
  const orders = fresh.filter((r) => r.subcategory === ORDER_SUBCATEGORY);
  return { fresh, orders };
}

export interface WatchOptions {
  /** How often to poll, in milliseconds (default one minute). */
  intervalMs?: number;
  /** Stop after this long; omit to run until the stop signal. */
  runForMs?: number;
  /** Read the PDF of every new order filing as it arrives, so the orders dashboard follows within a minute. */
  readOrders?: boolean;
  /** Called with each new filing, for alerting. */
  onFiling?: (a: Announcement) => void;
  stop?: { stopped: boolean };
}

/** Poll until stopped. Each new order filing is read straight away when `readOrders` is set. */
export async function watch(db: Db, opts: WatchOptions = {}): Promise<{ polls: number; filings: number; orders: number }> {
  const client = new BSEClient({ rps: 1, maxRetries: 2, timeoutS: 45 });
  const interval = opts.intervalMs ?? 60_000;
  const until = opts.runForMs ? Date.now() + opts.runForMs : Number.POSITIVE_INFINITY;
  let polls = 0, filings = 0, orders = 0;

  log.info(`watching BSE announcements every ${Math.round(interval / 1000)}s`);
  while (!opts.stop?.stopped && Date.now() < until) {
    try {
      const seen = await poll(client, db);
      polls++;
      filings += seen.fresh.length;
      orders += seen.orders.length;
      for (const a of seen.fresh) opts.onFiling?.(a);
      if (seen.fresh.length) {
        log.info(`${seen.fresh.length} new filing${seen.fresh.length === 1 ? "" : "s"}${seen.orders.length ? `, ${seen.orders.length} an order win` : ""}`);
        for (const a of seen.orders) log.info(`  order: ${a.headline?.slice(0, 80) ?? a.scrip_cd}`);
      }
      if (seen.orders.length && opts.readOrders !== false) {
        const { runOrders } = await import("../orders/extract");
        const read = await runOrders(db, { days: 2, limit: seen.orders.length + 5, concurrency: 2, deadlineMs: 4 * 60_000 });
        if (read.orders) log.info(`  read ${read.orders} order filing${read.orders === 1 ? "" : "s"} into figures`);
      }
    } catch (e) {
      log.warn(`poll failed, will try again: ${(e as Error).message}`);
    }
    const waitUntil = Date.now() + interval;
    while (!opts.stop?.stopped && Date.now() < waitUntil) await new Promise((r) => setTimeout(r, Math.min(2_000, waitUntil - Date.now())));
  }
  return { polls, filings, orders };
}
