// Background job process: the data worker, the company refresh queue and the daily update.
//
// Started by the Next.js server (src/instrumentation.ts) as a child process, so heavy SQLite and XML work
// never blocks web requests, or directly: `npm run jobs`. A PID lock keeps it to one instance.
import { logToFile, logger } from "../log";
import { getDb } from "../db";
import { db as apiDb } from "../api/common";
import * as lock from "./lock";
import * as state from "./state";
import { companyQueueLoop, dataLoop, type StopSignal } from "./worker";
import { schedulerLoop } from "./scheduler";
import { dailySteps } from "./steps";
import { publishDataLoop, publishLiveLoop } from "./publishLoop";

const log = logger("jobs");
export const LOCK = "jobs";
export const EXIT_LOCKED = 3;

async function main() {
  logToFile("jobs");
  if (!lock.acquire(LOCK)) {
    log.info(`another job runner (pid ${lock.lockOwner(LOCK)}) is active; exiting`);
    process.exit(EXIT_LOCKED);
  }
  const stop: StopSignal = { stopped: false };
  const shutdown = (why: string) => {
    if (stop.stopped) return;
    log.info(`stopping (${why})`);
    stop.stopped = true;
    // Loops notice within a couple of seconds; do not wait on a long download.
    setTimeout(() => process.exit(0), 15_000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  // Started by the web server: exit with it.
  process.on("disconnect", () => shutdown("web server exited"));
  process.on("exit", () => lock.release(LOCK));

  apiDb(); // every module's tables in place
  const db = getDb();
  state.ensureSchema(db);
  state.mark(db, "runner", { status: "running", last_started: new Date().toISOString(), pid: process.pid, message: null });

  // The publish loops do nothing unless Turso credentials are configured for a hosted copy.
  const loops: Promise<void>[] = [companyQueueLoop(db, stop), schedulerLoop(db, dailySteps, stop), publishDataLoop(db, stop), publishLiveLoop(stop)];
  // The Python worker may still be running during the switch-over; two parsers would fight over the same rows.
  const legacy = lock.lockOwner("fundamentals_run");
  if (legacy) log.warn(`the Python data worker (pid ${legacy}) is still running; the TypeScript data loop stays off until it stops`);
  else loops.push(dataLoop(db, stop));

  await Promise.all(loops);
  state.mark(db, "runner", { status: "stopped", last_finished: new Date().toISOString() });
  process.exit(0);
}

main().catch((e) => {
  log.error(`job runner crashed: ${(e as Error).stack ?? e}`);
  process.exit(1);
});
