// NSE daily bhavcopy (UDiFF format) - EOD OHLCV for every security.
//
// Source:  /content/cm/BhavCopy_NSE_CM_0_0_0_YYYYMMDD_F_0000.csv.zip
// Same UDiFF layout BSE uses, keyed on TckrSymb rather than a numeric code.
//
// Before July 2024 NSE published the older "cm bhavcopy" instead:
//     /content/historical/EQUITIES/YYYY/MON/cmDDMONYYYYbhav.csv.zip
// It is used automatically when no UDiFF file exists for a date, so history can be backfilled with the
// same command. Weekends and exchange holidays have no file and are recorded as 'nodata' so re-runs skip them.
import fs from "node:fs";
import path from "node:path";
import { unzipSync } from "fflate";
import { config } from "../config";
import { now, type Db, type Row } from "../db";
import { NotFound } from "../http";
import { logger } from "../log";
import { addDays } from "../util";
import type { NSEClient } from "./client";
import { decodeUtf8Sig, dictReader, normKeys, pyFloat, pyInt, pyStr, pyStrip, pyTruthy, weekday } from "./py";

const log = logger("nse.bhavcopy");

export const UDIFF_URL = "/content/cm/BhavCopy_NSE_CM_0_0_0_{ymd}_F_0000.csv.zip";
export const LEGACY_URL = "/content/historical/EQUITIES/{yyyy}/{mon}/cm{dd}{mon}{yyyy}bhav.csv.zip";
export const LEGACY_UNTIL = "2024-07-31"; // UDiFF files exist from July 2024

type ArchiveClient = Pick<NSEClient, "archive">;

/** s = str(v or "").strip().replace(",", ""); None for "", "-", "NA"; else float(s) or None */
function f(v: unknown): number | null {
  const s = pyStrip(pyTruthy(v) ? pyStr(v) : "").replace(/,/g, "");
  if (!s || s === "-" || s === "NA") return null;
  return pyFloat(s);
}

const i = (v: unknown) => pyInt(f(v));
const text = (v: unknown) => pyStrip(pyTruthy(v) ? String(v) : "");

/** Monday-Friday dates in [start, end]. */
export function tradingDays(start: string, end: string): string[] {
  const out: string[] = [];
  for (let d = start; d <= end; d = addDays(d, 1)) if (weekday(d) < 5) out.push(d);
  return out;
}

export interface BhavRow {
  trade_date: string; symbol: string; series: string; instrument: string; isin: string | null;
  open: number | null; high: number | null; low: number | null; close: number | null; last: number | null;
  prev_close: number | null; settle: number | null; volume: number | null; turnover: number | null;
  num_trades: number | null; open_int: number | null; expiry: string; strike: number; option_type: string;
}

/** Rows from a UDiFF bhavcopy CSV. `day` is ISO "YYYY-MM-DD". */
export function parse(csvText: string, day: string): BhavRow[] {
  const rows: BhavRow[] = [];
  for (const r of dictReader(csvText)) {
    const symbol = text(r.get("TckrSymb"));
    if (!symbol) continue;
    const strike = f(r.get("StrkPric"));
    rows.push({
      trade_date: day,
      symbol,
      series: text(r.get("SctySrs")),
      instrument: text(r.get("FinInstrmTp")),
      isin: text(r.get("ISIN")) || null,
      open: f(r.get("OpnPric")),
      high: f(r.get("HghPric")),
      low: f(r.get("LwPric")),
      close: f(r.get("ClsPric")),
      last: f(r.get("LastPric")),
      prev_close: f(r.get("PrvsClsgPric")),
      settle: f(r.get("SttlmPric")),
      volume: i(r.get("TtlTradgVol")),
      turnover: f(r.get("TtlTrfVal")),
      num_trades: i(r.get("TtlNbOfTxsExctd")),
      open_int: f(r.get("OpnIntrst")),
      // Part of the primary key, so never NULL.
      expiry: text(r.get("XpryDt")),
      strike: strike === null || strike === 0 ? 0 : strike,
      option_type: text(r.get("OptnTp")),
    });
  }
  return rows;
}

/** Rows from the pre-2024 cm bhavcopy, in the same shape as UDiFF rows. */
export function parseLegacy(csvText: string, day: string): BhavRow[] {
  const rows: BhavRow[] = [];
  for (const raw of dictReader(csvText)) {
    const r = normKeys(raw, pyStrip);
    const symbol = text(r.get("SYMBOL"));
    if (!symbol) continue;
    rows.push({
      trade_date: day, symbol, series: text(r.get("SERIES")),
      instrument: "STK", isin: text(r.get("ISIN")) || null,
      open: f(r.get("OPEN")), high: f(r.get("HIGH")), low: f(r.get("LOW")),
      close: f(r.get("CLOSE")), last: f(r.get("LAST")), prev_close: f(r.get("PREVCLOSE")),
      settle: null, volume: i(r.get("TOTTRDQTY")), turnover: f(r.get("TOTTRDVAL")),
      num_trades: i(r.get("TOTALTRADES")), open_int: null,
      expiry: "", strike: 0, option_type: "",
    });
  }
  return rows;
}

const MON = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

export const udiffPath = (day: string) => UDIFF_URL.replace("{ymd}", day.replace(/-/g, ""));

export function legacyPath(day: string): string {
  const [yyyy, mm, dd] = day.split("-");
  const mon = MON[Number(mm) - 1];
  return LEGACY_URL.replace(/\{yyyy\}/g, yyyy).replace(/\{mon\}/g, mon).replace("{dd}", dd);
}

async function legacyBlob(client: ArchiveClient, day: string): Promise<Uint8Array | null> {
  try {
    return await client.archive(legacyPath(day));
  } catch (e) {
    if (e instanceof NotFound) return null;
    throw e;
  }
}

/** Text of the first .csv member of a zip; null when there is none or the zip is unreadable. */
export function csvFromZip(blob: Uint8Array): string | null {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(blob);
  } catch {
    return null;
  }
  const name = Object.keys(files).find((n) => n.toLowerCase().endsWith(".csv"));
  return name === undefined ? null : decodeUtf8Sig(files[name]);
}

/** Parsed rows, or null when NSE has no file for that date. */
export async function fetchDay(client: ArchiveClient, day: string, saveRaw = true): Promise<BhavRow[] | null> {
  const ymd = day.replace(/-/g, "");
  let legacy = false;
  let blob: Uint8Array | null;
  try {
    blob = await client.archive(udiffPath(day));
  } catch (e) {
    if (!(e instanceof NotFound)) throw e;
    blob = day <= LEGACY_UNTIL ? await legacyBlob(client, day) : null;
    legacy = true;
    if (blob === null) return null;
  }

  const csvText = csvFromZip(blob);
  if (csvText === null) return null;

  if (saveRaw) fs.writeFileSync(path.join(config.RAW_DIR, `nse_bhavcopy_${ymd}.zip`), blob);
  return legacy ? parseLegacy(csvText, day) : parse(csvText, day);
}

export async function sync(client: ArchiveClient, db: Db, start: string, end: string, refetch = false, saveRaw = true): Promise<number> {
  const done = new Set<string>();
  if (!refetch) {
    for (const r of db.all<{ trade_date: string }>("SELECT trade_date FROM nse_bhavcopy_day WHERE status IN ('ok','nodata')")) done.add(r.trade_date);
  }

  let total = 0;
  for (const key of tradingDays(start, end)) {
    if (done.has(key)) continue;

    let rows: BhavRow[] | null;
    try {
      rows = await fetchDay(client, key, saveRaw);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log.warn(`nse bhavcopy ${key} error: ${msg}`);
      db.upsert("nse_bhavcopy_day", [{ trade_date: key, status: "error", rows: 0, fetched_at: now(), note: msg.slice(0, 500) }]);
      continue;
    }

    if (rows === null) {
      db.upsert("nse_bhavcopy_day", [{ trade_date: key, status: "nodata", rows: 0, fetched_at: now(), note: "holiday or no file" }]);
    } else {
      const list = rows;
      const n = db.transaction(() => {
        const count = db.upsert("nse_bhavcopy", list as unknown as Row[]);
        db.upsert("nse_bhavcopy_day", [{ trade_date: key, status: "ok", rows: count, fetched_at: now(), note: null }]);
        return count;
      });
      total += n;
      log.info(`nse bhavcopy ${key} -> ${n} rows`);
    }
  }
  return total;
}

export { sync as syncBhavcopy, f as toFloat, i as toInt };
