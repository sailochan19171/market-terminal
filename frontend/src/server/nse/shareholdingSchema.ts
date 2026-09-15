// Tables for per-company shareholding detail (FII / DII / promoter categories from XBRL).
import type { Db } from "../db";

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS nse_shareholding_detail (
    symbol        TEXT NOT NULL,
    as_of_date    TEXT NOT NULL,
    promoter      REAL,
    fii           REAL,
    dii           REAL,
    government    REAL,
    public        REAL,
    others        REAL,
    shareholders  INTEGER,
    total_shares  REAL,
    xbrl_url      TEXT,
    status        TEXT NOT NULL,
    fetched_at    TEXT NOT NULL,
    PRIMARY KEY (symbol, as_of_date)
);
CREATE TABLE IF NOT EXISTS shareholding_attempt (
    symbol       TEXT PRIMARY KEY,
    attempted_at TEXT NOT NULL,
    outcome      TEXT
);
`;

export function ensureSchema(db: Db) {
  db.exec(SCHEMA);
  db.addColumns("nse_shareholding_detail", { total_shares: "REAL" });
}
