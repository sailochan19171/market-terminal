// The continuous data worker: parses result filings, shareholding and statements until nothing is pending,
// serves on-demand company refreshes queued by the API, and keeps derived tables fresh.
import type { Db } from "../db";
import { now } from "../db";
import { logger } from "../log";
import { config } from "../config";
import { sleep } from "../util";
import { NSEClient } from "../nse/client";
import * as F from "../nse/fundamentals";
import * as SH from "../nse/shareholding";
import * as STM from "../nse/statements";
import * as sync from "../nse/companySync";
import { rebuild } from "../core/metrics";
import { runScheduled } from "../core/analysis";
import { buildAll } from "../research/kb";
import * as state from "./state";

const log = logger("worker");

const BATCH = 500; // filings per round before re-checking state
const MAX_ERRORS = 50; // consecutive failed rounds before giving up
const REBUILD_EVERY_MS = 20 * 60_000; // refresh company_metrics and analyses this often while data flows
const SHAREHOLDING_PER_ROUND = 15;
const STATEMENTS_PER_ROUND = 200;
const IDLE_SLEEP_MS = 30 * 60_000;
const QUEUE_POLL_MS = 3_000;
const CHECKPOINT_EVERY_MS = 10 * 60_000;

export interface StopSignal {
  stopped: boolean;
}

/** Sleep in short steps so a stop request is honoured quickly. */
async function nap(ms: number, stop: StopSignal, wake?: () => boolean) {
  const until = Date.now() + ms;
  while (!stop.stopped && Date.now() < until && !wake?.()) await sleep(Math.min(2_000, until - Date.now()));
}

function progress(db: Db): string {
  const rows = db.scalar<number>("SELECT COUNT(*) FROM nse_fundamental");
  const companies = db.scalar<number>("SELECT COUNT(DISTINCT symbol) FROM nse_fundamental");
  return `${rows} rows, ${companies} companies`;
}

/** Recompute derived figures so pages and screens pick up new filings. */
export function afterNewData(db: Db) {
  const t0 = Date.now();
  rebuild(db);
  try {
    const docs = buildAll(db).docs;
    if (docs) log.info(`knowledge base: ${docs} documents rebuilt`);
    const made = runScheduled(db);
    log.info(`metrics rebuilt in ${((Date.now() - t0) / 1000).toFixed(1)}s; scheduled analyses: ${made} new versions`);
  } catch (e) {
    // Analyses must never stop data collection.
    log.warn(`scheduled analyses failed: ${(e as Error).message}`);
  }
}

/** Keep the WAL from growing without bound while readers are active. */
function checkpoint(db: Db) {
  try {
    const r = db.get("PRAGMA wal_checkpoint(TRUNCATE)");
    if (r?.busy) db.get("PRAGMA wal_checkpoint(PASSIVE)");
  } catch (e) {
    log.debug(`checkpoint skipped: ${(e as Error).message}`);
  }
}

const archiveClient = () => new NSEClient({ rps: config.FUNDAMENTALS_RPS });
// The JSON API is stricter than the static archive.
const wwwClient = () => new NSEClient({ rps: 1, maxRetries: 1, timeoutS: 25 });

/** Refresh one company end to end, reporting progress in its company_sync row. */
export async function refreshCompany(db: Db, symbol: string) {
  const client = new NSEClient();
  try {
    const total = F.pending(db, { symbol }).length;
    sync.setStatus(db, symbol, { status: "running", stage: "results", done: 0, total, started_at: now(), finished_at: null, error: null });
    if (total) await F.sync(client, db, { symbol, limit: null, progress: (done, n) => sync.setStatus(db, symbol, { done, total: n }) });

    sync.setStatus(db, symbol, { stage: "shareholding", done: 0, total: 0 });
    try {
      await SH.syncSymbol(client, db, symbol, { progress: (done, n) => sync.setStatus(db, symbol, { done, total: n }) });
    } catch (e) {
      log.warn(`shareholding sync ${symbol}: ${(e as Error).message}`); // best-effort; results matter more
    }

    sync.setStatus(db, symbol, { stage: "statements", done: 0, total: 0 });
    try {
      await STM.sync(client, db, { limit: null, symbol });
    } catch (e) {
      log.warn(`statements sync ${symbol}: ${(e as Error).message}`);
    }

    sync.setStatus(db, symbol, { stage: "metrics", done: 0, total: 0 });
    rebuild(db);
    sync.setStatus(db, symbol, { status: "done", stage: null, finished_at: now() });
    log.info(`company sync ${symbol}: done (${total} filings)`);
  } catch (e) {
    log.error(`company sync ${symbol} failed: ${(e as Error).stack ?? e}`);
    try {
      sync.setStatus(db, symbol, { status: "error", error: String((e as Error).message).slice(0, 500), finished_at: now() });
    } catch {
      /* the status row is informational */
    }
  }
}

/** Serve company refreshes the API queued, a few seconds after they are requested. */
export async function companyQueueLoop(db: Db, stop: StopSignal) {
  sync.ensureSchema(db);
  // A refresh interrupted by a restart would otherwise look "running" forever.
  db.run("UPDATE company_sync SET status = 'queued', stage = 'queued' WHERE status = 'running'");
  while (!stop.stopped) {
    try {
      for (const symbol of sync.queued(db, 1)) {
        if (stop.stopped) break;
        await refreshCompany(db, symbol);
      }
    } catch (e) {
      log.warn(`company queue: ${(e as Error).message}`);
    }
    await nap(QUEUE_POLL_MS, stop);
  }
}

/** Parse filings, shareholding and statements to completion, then idle and look again. */
export async function dataLoop(db: Db, stop: StopSignal) {
  let archive = archiveClient();
  let www = wwwClient();
  let lastRebuild = 0;
  let lastCheckpoint = Date.now();
  let fresh = 0;
  let errors = 0;
  log.info(`data worker starting (pid ${process.pid}, ${config.FUNDAMENTALS_WORKERS} download workers)`);

  while (!stop.stopped) {
    try {
      const left = F.pendingCount(db);
      const parsed = left ? await F.sync(archive, db, { limit: BATCH }) : 0;
      const holdings = stop.stopped ? 0 : await SH.syncMany(www, db, { limit: SHAREHOLDING_PER_ROUND });
      const statements = stop.stopped ? 0 : await STM.sync(archive, db, { limit: STATEMENTS_PER_ROUND });
      fresh += parsed + holdings + statements;
      const summary = `${left} filings pending, ${parsed} parsed, ${holdings} shareholding quarters, ${statements} statements - ${progress(db)}`;
      log.info(`round: ${summary}`);
      state.mark(db, "worker", { status: "running", heartbeat: now(), pid: process.pid, message: summary });

      if (fresh && Date.now() - lastRebuild >= REBUILD_EVERY_MS) {
        afterNewData(db);
        lastRebuild = Date.now();
        fresh = 0;
      }
      if (Date.now() - lastCheckpoint >= CHECKPOINT_EVERY_MS) {
        checkpoint(db);
        lastCheckpoint = Date.now();
      }
      errors = 0;
      if (!left && !holdings && !statements) {
        log.info(`queues empty; sleeping ${IDLE_SLEEP_MS / 60_000} min`);
        state.mark(db, "worker", { status: "idle", heartbeat: now(), message: `idle since ${now()} - ${progress(db)}` });
        checkpoint(db);
        await nap(IDLE_SLEEP_MS, stop);
      }
    } catch (e) {
      if (e instanceof F.NetworkStall) {
        // New clients share the process-wide connection pool, so only a fresh process clears hung connections.
        // The web server restarts the runner after a short delay (jobs/spawn.ts).
        log.error(`${(e as Error).message}; restarting the job runner for fresh connections`);
        state.mark(db, "worker", { status: "error", heartbeat: now(), message: "network stalled; restarting" });
        process.exit(75);
      }
      // Network, a locked database, anything: back off with fresh sessions and retry.
      errors++;
      log.warn(`round failed (${errors} in a row): ${(e as Error).message}`);
      try {
        state.mark(db, "worker", { status: "error", heartbeat: now(), message: String((e as Error).message).slice(0, 500) });
      } catch {
        /* best effort */
      }
      if (errors >= MAX_ERRORS) {
        log.error(`giving up after ${errors} consecutive failures`);
        return;
      }
      archive = archiveClient();
      www = wwwClient();
      await nap(Math.min(300_000, 15_000 * errors), stop);
    }
  }
}
