// Data commands shared by the daily update and the CLI (formerly run.py).
import { config } from "../config";
import { runTask, type Db } from "../db";
import { logger } from "../log";
import { addDays, todayIso } from "../util";
import { BSEClient } from "../bse/client";
import { NSEClient } from "../nse/client";
import * as scripMaster from "../bse/scripMaster";
import * as bseBhavcopy from "../bse/bhavcopy";
import * as bseAnnouncements from "../bse/announcements";
import * as corpActions from "../bse/corpActions";
import * as bseIndices from "../bse/indices";
import * as nseSymbols from "../nse/symbols";
import * as nseBhavcopy from "../nse/bhavcopy";
import * as nseIndices from "../nse/indices";
import * as nseIndexHistory from "../nse/indexHistory";
import { CORPORATE_STEPS, corporateWindow } from "../nse/corporate";
import { rebuild } from "../core/metrics";
import { runScheduled } from "../core/analysis";
import { evaluate, markSent, unsent } from "../alerts/rules";
import { buildChannels, sendAll } from "../alerts/channels";
import { getBroker, saveHoldings } from "../brokers";
import { saveWatchlist } from "../core/portfolio";

const log = logger("commands");

export interface Window {
  start?: string | null;
  end?: string | null;
  years?: number | null;
}

/** run.py date_window: an explicit start, or `years` back from the end date. */
export function dateWindow(w: Window, defaultYears = config.BACKFILL_YEARS): [string, string] {
  const end = w.end || todayIso();
  if (w.start) return [w.start, end];
  return [addDays(end, -Math.round((w.years || defaultYears) * 365.25)), end];
}

export const scrips = (db: Db, opts: scripMaster.ScripSyncOptions = {}) =>
  runTask(db, "scrips", () => scripMaster.sync(new BSEClient(), db, opts));

export const bseIndexSync = (db: Db) => runTask(db, "indices", () => bseIndices.sync(new BSEClient(), db));

export const bseCorpActions = (db: Db, opts: corpActions.CorpActionSyncOptions = {}) =>
  runTask(db, "corp_actions", () => corpActions.sync(new BSEClient(), db, opts));

export function bhavcopy(db: Db, w: Window, opts: bseBhavcopy.BhavcopySyncOptions = {}) {
  const [start, end] = dateWindow(w);
  log.info(`bhavcopy ${start} -> ${end}`);
  return runTask(db, "bhavcopy", () => bseBhavcopy.sync(new BSEClient(), db, start, end, opts));
}

export function announcements(db: Db, w: Window, opts: bseAnnouncements.AnnouncementSyncOptions = {}) {
  const [start, end] = dateWindow(w);
  log.info(`announcements ${start} -> ${end}`);
  return runTask(db, "announcements", () => bseAnnouncements.sync(new BSEClient(), db, start, end, opts));
}

export const nseSymbolSync = (db: Db) => runTask(db, "nse_symbols", () => nseSymbols.sync(new NSEClient(), db));

export const nseIndexSync = (db: Db, constituents = true) =>
  runTask(db, "nse_indices", () => nseIndices.sync(new NSEClient(), db, constituents));

export function nseBhavcopySync(db: Db, w: Window, opts: { refetch?: boolean; saveRaw?: boolean } = {}) {
  const [start, end] = dateWindow(w);
  log.info(`nse bhavcopy ${start} -> ${end}`);
  return runTask(db, "nse_bhavcopy", () => nseBhavcopy.sync(new NSEClient(), db, start, end, opts.refetch ?? false, opts.saveRaw ?? true));
}

export function nseIndexHistorySync(db: Db, w: Window) {
  const [start, end] = dateWindow(w);
  return runTask(db, "nse_index_history", () => nseIndexHistory.sync(new NSEClient(), db, start, end));
}

/** NSE corporate feeds; a failing step is logged and the others still run. */
export async function nseCorporate(db: Db, w: Window, only?: string[]) {
  const [start, end] = corporateWindow(w);
  log.info(`nse corporate window ${start} -> ${end}`);
  const client = new NSEClient();
  let total = 0;
  for (const step of only ?? Object.keys(CORPORATE_STEPS)) {
    const fn = CORPORATE_STEPS[step.trim()];
    if (!fn) {
      log.warn(`unknown step '${step}' (known: ${Object.keys(CORPORATE_STEPS).join(", ")})`);
      continue;
    }
    try {
      total += await runTask(db, `nse_${step.trim()}`, () => fn(client, db, start, end));
    } catch (e) {
      log.error(`nse ${step} failed: ${(e as Error).message}`);
    }
  }
  return total;
}

export const metrics = (db: Db) => runTask(db, "metrics", () => rebuild(db));

export const analyses = (db: Db, limit?: number) => runTask(db, "analyses", () => runScheduled(db, limit));

/** Pull holdings (and a watchlist seeded from them) from the configured broker. Null when none is set up. */
export async function broker(db: Db, opts: { name?: string; watchlist?: string | null } = {}) {
  const b = getBroker(opts.name);
  if (!b) return null;
  const holdings = saveHoldings(db, b.name, await b.holdings());
  const watchlist = opts.watchlist === null ? 0 : saveWatchlist(db, opts.watchlist ?? "default", await b.watchlist(), b.name);
  return { broker: b.name, holdings, watchlist };
}

/** Evaluate alert rules and deliver new hits through the configured channels. */
export async function alerts(db: Db, opts: { rule?: string; channels?: string[]; dryRun?: boolean; resend?: boolean; limit?: number; print?: (s: string) => void } = {}) {
  const limit = opts.limit ?? 25;
  const hits = evaluate(db, opts.rule);
  const fresh = opts.resend ? hits : unsent(db, hits);
  const channels = buildChannels(opts.channels);
  let sent = 0;
  if (fresh.length && channels.length && !opts.dryRun) {
    for (const h of fresh.slice(0, limit)) {
      const delivered = await sendAll(channels, h.subject, h.body);
      if (delivered.length) {
        markSent(db, h, delivered);
        sent++;
      }
    }
  } else if (opts.print) {
    for (const h of fresh.slice(0, limit)) opts.print(`\n--- ${h.subject}\n${h.body}`);
  }
  return { hits: hits.length, fresh: fresh.length, sent, channels: channels.map((c) => c.name) };
}
