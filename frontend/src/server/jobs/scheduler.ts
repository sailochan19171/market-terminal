// Daily end-of-day update: runs on weekday evenings once the exchanges publish their files, and catches up
// on start when the app was not running at the scheduled time.
import type { Db } from "../db";
import { now } from "../db";
import { logger } from "../log";
import * as state from "./state";
import type { StopSignal } from "./worker";

const log = logger("scheduler");

export const DAILY_JOB = "daily";
/** Local time (the machine runs on IST) after which the day's bhavcopy and filings are available. */
const RUN_AT = { hour: Number(process.env.MARKET_DAILY_HOUR ?? 19), minute: Number(process.env.MARKET_DAILY_MINUTE ?? 30) };
const CHECK_EVERY_MS = 60_000;

export interface Step {
  name: string;
  run: () => Promise<number>;
}

/** The most recent weekday slot at or before `at`. */
export function lastSlot(at = new Date()): Date {
  const d = new Date(at.getFullYear(), at.getMonth(), at.getDate(), RUN_AT.hour, RUN_AT.minute);
  if (d > at) d.setDate(d.getDate() - 1);
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() - 1);
  return d;
}

export function isDue(db: Db, at = new Date()): boolean {
  const row = state.get(db, DAILY_JOB);
  // Before the first run here, the last end-of-day download the earlier pipeline logged stands in.
  const last = row?.last_started ?? db.scalar<string>("SELECT MAX(started_at) FROM run_log WHERE task = 'nse_bhavcopy' AND status = 'ok'");
  const started = last ? new Date(last) : null;
  return !started || started < lastSlot(at);
}

/** Run each step in order; a failing step is logged and the rest still run. */
export async function runSteps(db: Db, steps: Step[], stop?: StopSignal): Promise<{ ok: number; failed: string[] }> {
  state.ensureSchema(db);
  state.mark(db, DAILY_JOB, { status: "running", last_started: now(), pid: process.pid, message: null });
  const failed: string[] = [];
  let ok = 0;
  for (const step of steps) {
    if (stop?.stopped) break;
    const t0 = Date.now();
    state.heartbeat(db, DAILY_JOB, `step ${step.name}`);
    try {
      const rows = await step.run();
      ok++;
      log.info(`=== ${step.name}: ${rows} rows in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    } catch (e) {
      failed.push(step.name);
      log.error(`=== ${step.name} failed: ${(e as Error).message}`);
    }
  }
  const status = stop?.stopped ? "error" : failed.length ? (ok ? "ok" : "error") : "ok";
  const message = stop?.stopped ? "interrupted" : failed.length ? `failed steps: ${failed.join(", ")}` : `${ok} steps`;
  state.mark(db, DAILY_JOB, { status, last_finished: now(), message, ...(status === "ok" ? { last_ok: now() } : {}) });
  return { ok, failed };
}

export async function schedulerLoop(db: Db, steps: () => Step[], stop: StopSignal) {
  state.ensureSchema(db);
  log.info(`daily update scheduled for weekdays at ${String(RUN_AT.hour).padStart(2, "0")}:${String(RUN_AT.minute).padStart(2, "0")}`);
  while (!stop.stopped) {
    try {
      if (isDue(db)) {
        log.info("########## daily update starting");
        const { ok, failed } = await runSteps(db, steps(), stop);
        log.info(`########## daily update finished: ${ok} ok, ${failed.length} failed`);
      }
    } catch (e) {
      log.error(`scheduler: ${(e as Error).message}`);
    }
    const until = Date.now() + CHECK_EVERY_MS;
    while (!stop.stopped && Date.now() < until) await new Promise((r) => setTimeout(r, 1_000));
  }
}
