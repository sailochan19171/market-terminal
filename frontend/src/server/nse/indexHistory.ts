// Daily history for every NSE index.
//
// Source: nsearchives /content/indices/ind_close_all_DDMMYYYY.csv
// One file per session with open/high/low/close, points and percent change, volume, turnover and the
// index P/E, P/B and dividend yield. The archive host needs no cookies, and files exist back to at least 2020.
//
// Index names in these files use mixed case ("Nifty 50") while the live allIndices feed uses upper case
// ("NIFTY 50"), so rows are keyed on the upper-cased name to make the two joinable.
import { now, type Db, type Row } from "../db";
import { NotFound } from "../http";
import { logger } from "../log";
import { addDays, eodSettled } from "../util";
import type { NSEClient } from "./client";
import { decodeUtf8Sig, dictReader, dmy, isoDateOf, normKeys, pyFloat, pyStr, pyStrip, pyTruthy, strptime, textOf, weekday } from "./py";

const log = logger("nse.index_history");

export const CLOSE_ALL_URL = "/content/indices/ind_close_all_{dmy}.csv";

function f(v: unknown): number | null {
  const s = pyStrip(pyTruthy(v) ? pyStr(v) : "").replace(/,/g, "");
  if (!s || s === "-" || s === "NA") return null;
  return pyFloat(s);
}

export interface IndexHistoryRow {
  index_name: string; display_name: string; trade_date: string; open: number | null; high: number | null;
  low: number | null; close: number | null; pts_change: number | null; pct_change: number | null;
  volume: number | null; turnover_cr: number | null; pe: number | null; pb: number | null; div_yield: number | null;
}

export function parse(text: string): IndexHistoryRow[] {
  const out: IndexHistoryRow[] = [];
  for (const raw of dictReader(text)) {
    const r = normKeys(raw, pyStrip);
    const name = textOf(r.get("Index Name"));
    const rawDay = textOf(r.get("Index Date"));
    if (!name || !rawDay) continue;
    const d = strptime(rawDay, "%d-%m-%Y");
    if (!d) continue;
    out.push({
      index_name: name.toUpperCase(),
      display_name: name,
      trade_date: isoDateOf(d),
      open: f(r.get("Open Index Value")),
      high: f(r.get("High Index Value")),
      low: f(r.get("Low Index Value")),
      close: f(r.get("Closing Index Value")),
      pts_change: f(r.get("Points Change")),
      pct_change: f(r.get("Change(%)")),
      volume: f(r.get("Volume")),
      turnover_cr: f(r.get("Turnover (Rs. Cr.)")),
      pe: f(r.get("P/E")),
      pb: f(r.get("P/B")),
      div_yield: f(r.get("Div Yield")),
    });
  }
  return out;
}

export const dayPath = (day: string) => CLOSE_ALL_URL.replace("{dmy}", dmy(day, ""));

export async function sync(client: Pick<NSEClient, "archive">, db: Db, start: string, end: string, refetch = false): Promise<number> {
  const done = new Set<string>();
  if (!refetch) {
    // "No file yet" during the session is not a holiday; only a check made after the close settles the day.
    for (const r of db.all<{ trade_date: string; status: string; fetched_at: string }>("SELECT trade_date, status, fetched_at FROM nse_index_history_day WHERE status IN ('ok','nodata')")) {
      if (r.status === "ok" || eodSettled(r.trade_date, r.fetched_at)) done.add(r.trade_date);
    }
  }

  let total = 0;
  for (let key = start; key <= end; key = addDays(key, 1)) {
    if (weekday(key) >= 5 || done.has(key)) continue;
    let rows: IndexHistoryRow[];
    let status: string;
    try {
      const text = decodeUtf8Sig(await client.archive(dayPath(key)));
      rows = text.slice(0, 200).includes("Index Name") ? parse(text) : [];
      status = rows.length ? "ok" : "nodata";
    } catch (e) {
      if (e instanceof NotFound) {
        rows = [];
        status = "nodata";
      } else {
        log.warn(`index history ${key}: ${e instanceof Error ? e.message : e}`);
        continue;
      }
    }

    const day = key;
    const n = db.transaction(() => {
      const count = rows.length ? db.upsert("nse_index_history", rows as unknown as Row[]) : 0;
      db.upsert("nse_index_history_day", [{ trade_date: day, status, rows: count, fetched_at: now() }]);
      return count;
    });
    total += n;
    if (n) log.info(`index history ${key} -> ${n}`);
  }
  return total;
}

export { sync as syncIndexHistory, f as toFloat };
