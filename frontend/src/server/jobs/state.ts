// Job bookkeeping shared by the runner, the CLI and the status API.
import { now, type Db, type Row } from "../db";

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS job_state (
    name          TEXT PRIMARY KEY,
    status        TEXT,            -- running | ok | error
    last_started  TEXT,
    last_finished TEXT,
    last_ok       TEXT,
    message       TEXT,
    heartbeat     TEXT,
    pid           INTEGER
);
`;

export function ensureSchema(db: Db) {
  db.exec(SCHEMA);
}

export function mark(db: Db, name: string, fields: Row) {
  const row: Row = { name, ...fields };
  const cols = Object.keys(row);
  db.run(`INSERT INTO job_state (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")}) `
    + `ON CONFLICT(name) DO UPDATE SET ${cols.filter((c) => c !== "name").map((c) => `${c} = excluded.${c}`).join(", ")}`, cols.map((c) => row[c]));
}

export const heartbeat = (db: Db, name: string, message?: string) =>
  mark(db, name, message === undefined ? { heartbeat: now(), pid: process.pid } : { heartbeat: now(), pid: process.pid, message });

export const get = (db: Db, name: string) => db.get("SELECT * FROM job_state WHERE name = ?", [name]);

export const all = (db: Db) => (db.hasTable("job_state") ? db.all("SELECT * FROM job_state ORDER BY name") : []);
