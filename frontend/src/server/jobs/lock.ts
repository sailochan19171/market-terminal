// Single-instance lock: a PID file that a second runner (or a stale file from a crash) is checked against.
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "../config";

export const lockPath = (name: string) => path.join(ROOT, "data", `${name}.pid`);

export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: the process exists but belongs to someone else.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The PID holding the lock, or null when it is free (a dead owner's file does not count). */
export function lockOwner(name: string): number | null {
  try {
    const pid = Number.parseInt(fs.readFileSync(lockPath(name), "utf8").trim(), 10);
    return pidAlive(pid) && pid !== process.pid ? pid : null;
  } catch {
    return null;
  }
}

export function acquire(name: string): boolean {
  const file = lockPath(name);
  if (lockOwner(name)) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, String(process.pid));
  return true;
}

export function release(name: string) {
  try {
    if (fs.readFileSync(lockPath(name), "utf8").trim() === String(process.pid)) fs.unlinkSync(lockPath(name));
  } catch {
    /* already gone */
  }
}
