// Keeps the hosted site's Turso copy current from this PC: data every 30 minutes, the live pulse every
// minute while NSE is trading (every 15 minutes otherwise). Runs only when Turso credentials are in .env.
//
// Each publish runs as a separate process. Turso calls block the calling thread while they wait on the
// network, and inside the job runner that would stall every download in flight until it timed out.
import { execFile } from "node:child_process";
import path from "node:path";
import { logger } from "../log";
import { sleep } from "../util";
import { isConfigured, marketHours } from "./publish";
import type { StopSignal } from "./worker";

const log = logger("publish");

const DATA_EVERY_MS = 30 * 60_000;
const LIVE_OPEN_MS = 60_000;
const LIVE_CLOSED_MS = 15 * 60_000;
const CLI = path.join(process.cwd(), "src", "server", "cli.ts");

async function waitFor(ms: number, stop: StopSignal) {
  const until = Date.now() + ms;
  while (!stop.stopped && Date.now() < until) await sleep(Math.min(2_000, until - Date.now()));
}

/** `npm run market -- publish ...` in a child process; resolves with its last output line. */
function runCli(args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, ["--disable-warning=ExperimentalWarning", "--import", "tsx", CLI, ...args], {
      cwd: process.cwd(), timeout: timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, MARKET_JOBS: "off" },
    }, (err, stdout, stderr) => {
      const last = `${stdout}`.trim().split(/\r?\n/).filter((l) => !/^\d\d:\d\d:\d\d /.test(l)).slice(-12).join(" | ");
      if (err) reject(new Error(`${err.message.split("\n")[0]} ${`${stderr}`.trim().split(/\r?\n/).slice(-2).join(" ")}`));
      else resolve(last);
    });
  });
}

export async function publishDataLoop(stop: StopSignal) {
  if (!isConfigured()) return;
  log.info("publishing to the hosted database every 30 minutes");
  while (!stop.stopped) {
    try {
      log.info(`published: ${(await runCli(["publish"], 3 * 3600_000)) || "nothing new"}`);
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
      await runCli(["publish", "live"], 5 * 60_000);
    } catch (e) {
      log.warn(`live pulse publish failed: ${(e as Error).message}`);
    }
    await waitFor(marketHours() ? LIVE_OPEN_MS : LIVE_CLOSED_MS, stop);
  }
}
