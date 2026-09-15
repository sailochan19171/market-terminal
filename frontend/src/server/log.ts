// Small logger: timestamped lines to the console and, for background jobs, a log file.
import fs from "node:fs";
import path from "node:path";
import { config, ensureDirs } from "./config";

type Level = "debug" | "info" | "warn" | "error";
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const MIN = ORDER[(process.env.MARKET_LOG_LEVEL as Level) ?? "info"] ?? 20;

let fileStream: fs.WriteStream | null = null;

/** Also write log lines to data/logs/<name>.log (used by the job runner and CLI). */
export function logToFile(name: string) {
  ensureDirs();
  fileStream = fs.createWriteStream(path.join(config.LOG_DIR, `${name}.log`), { flags: "a" });
}

function stamp() {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function write(level: Level, scope: string, msg: string, extra: unknown[]) {
  if (ORDER[level] < MIN) return;
  const text = extra.length ? `${msg} ${extra.map((e) => (e instanceof Error ? e.message : typeof e === "string" ? e : JSON.stringify(e))).join(" ")}` : msg;
  const line = `${stamp()} ${level.toUpperCase().padEnd(7)} ${scope}: ${text}`;
  if (level === "error" || level === "warn") console.error(line);
  else console.log(line);
  fileStream?.write(line + "\n");
}

export function logger(scope: string) {
  return {
    debug: (msg: string, ...extra: unknown[]) => write("debug", scope, msg, extra),
    info: (msg: string, ...extra: unknown[]) => write("info", scope, msg, extra),
    warn: (msg: string, ...extra: unknown[]) => write("warn", scope, msg, extra),
    error: (msg: string, ...extra: unknown[]) => write("error", scope, msg, extra),
  };
}
