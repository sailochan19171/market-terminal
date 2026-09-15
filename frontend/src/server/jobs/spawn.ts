// Supervises the job runner child process from inside the Next.js server.
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { config } from "../config";

const EXIT_LOCKED = 3; // runner.ts: another runner already holds the lock
const MAX_BACKOFF_MS = 10 * 60_000;

let child: ChildProcess | null = null;
let started = false;

export function startJobs() {
  if (started) return;
  started = true;
  if (!config.JOBS_ENABLED) {
    console.log("[jobs] background jobs disabled (MARKET_JOBS=off)");
    return;
  }
  const runner = path.join(process.cwd(), "src", "server", "jobs", "runner.ts");
  let failures = 0;

  const launch = () => {
    const startedAt = Date.now();
    // stdio "ipc" lets the runner notice when this server goes away and exit with it.
    child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "--import", "tsx", runner], {
      cwd: process.cwd(),
      stdio: ["ignore", "ignore", "inherit", "ipc"],
      windowsHide: true,
      env: { ...process.env, NODE_OPTIONS: "" },
    });
    console.log(`[jobs] runner started (pid ${child.pid}); log: data/logs/jobs.log`);
    child.on("exit", (code, signal) => {
      child = null;
      if (code === EXIT_LOCKED) {
        console.log("[jobs] another job runner is already active; not starting a second one");
        return;
      }
      if (code === 0 && !signal) return;
      // Crashed: restart with a growing delay, reset once it has stayed up for a while.
      failures = Date.now() - startedAt > 30 * 60_000 ? 1 : failures + 1;
      const delay = Math.min(MAX_BACKOFF_MS, 5_000 * 2 ** (failures - 1));
      console.error(`[jobs] runner exited (code ${code}, signal ${signal}); restarting in ${Math.round(delay / 1000)}s`);
      setTimeout(launch, delay).unref();
    });
  };

  launch();
  // Next.js owns SIGINT/SIGTERM handling; the runner also exits on its own when the IPC channel closes.
  process.once("exit", () => child?.kill());
}
