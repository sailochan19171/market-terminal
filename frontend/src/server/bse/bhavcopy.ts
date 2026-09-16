// Daily Bhavcopy - official end-of-day OHLCV for every traded security.
//
// Primary (current) format:
//   https://www.bseindia.com/download/BhavCopy/Equity/BhavCopy_BSE_CM_0_0_0_YYYYMMDD_F_0000.CSV
// Legacy fallback for older dates (zipped CSV):
//   https://www.bseindia.com/download/BhavCopy/Equity/EQ_ISINCODE_DDMMYY.zip
//
// Weekends and exchange holidays simply have no file; those days are recorded as 'nodata' so re-runs
// skip them instead of hammering the server.
import fs from "node:fs";
import path from "node:path";
import { unzipSync } from "fflate";
import { config } from "../config";
import { now, type Db } from "../db";
import { HttpError, NotFound, BadRequest } from "../http";
import { logger } from "../log";
import { parseIso, addDays, eodSettled } from "../util";
import { WWW, type BSEClient } from "./client";
import { pyDictReader, pyFloat, pyInt, pyStrip } from "./pyCompat";

const log = logger("bse.bhavcopy");

export const NEW_URL = (ymd: string) => `${WWW}/download/BhavCopy/Equity/BhavCopy_BSE_CM_0_0_0_${ymd}_F_0000.CSV`;
export const LEGACY_URL = (dmy: string) => `${WWW}/download/BhavCopy/Equity/EQ_ISINCODE_${dmy}.zip`;
/** Before the ISIN variant: same columns without ISIN_CODE; served back to at least 2007. */
export const OLD_URL = (dmy: string) => `${WWW}/download/BhavCopy/Equity/EQ${dmy}_CSV.ZIP`;

export interface BhavRow {
  trade_date: string; scrip_cd: string; ticker: string | null; isin: string | null; series: string; instrument: string;
  open: number | null; high: number | null; low: number | null; close: number | null; last: number | null;
  prev_close: number | null; volume: number | null; turnover: number | null; num_trades: number | null;
}

/** BSE serves its single-page app with HTTP 200 for files that do not exist, so a missing bhavcopy
 *  looks like a successful download. Detect that soft 404 rather than parsing a web page as CSV. */
export function isHtml(blob: Uint8Array): boolean {
  let i = 0;
  const end = Math.min(blob.length, 400);
  while (i < end && [0x20, 0x09, 0x0a, 0x0d, 0x0b, 0x0c].includes(blob[i])) i++;
  const head = Buffer.from(blob.subarray(i, end)).toString("latin1").toLowerCase();
  return head.startsWith("<!doctype") || head.startsWith("<html");
}

/** bytes.decode("utf-8-sig", errors="replace") */
export const decodeUtf8Sig = (blob: Uint8Array) => new TextDecoder("utf-8").decode(blob);

/** bhavcopy._f: None, "", "-" and "NA" are missing; otherwise Python float() or None. */
export const num = (v: string | null | string[] | undefined): number | null => {
  if (v === null || v === undefined) return null;
  const s = pyStrip(String(v)).replace(/,/g, "");
  if (!s || s === "-" || s === "NA") return null;
  return pyFloat(s);
};
const int = (v: string | null | string[] | undefined): number | null => {
  const f = num(v);
  return f === null ? null : pyInt(f);
};
const text = (v: string | null | string[] | undefined): string => (v ? pyStrip(v as string) : "");

/** Every Mon-Fri in [start, end]. Holidays fall out as 'nodata'. */
export function tradingDays(start: string, end: string): string[] {
  const out: string[] = [];
  for (let d = start; d <= end; d = addDays(d, 1)) {
    const wd = parseIso(d)!.getUTCDay();
    if (wd >= 1 && wd <= 5) out.push(d);
  }
  return out;
}

/** UDiFF CSV (BhavCopy_BSE_CM_...). */
export function parseNew(csvText: string, day: string): BhavRow[] {
  const rows: BhavRow[] = [];
  for (const r of pyDictReader(csvText)) {
    const code = text(r.get("FinInstrmId"));
    if (!code) continue;
    rows.push({
      trade_date: day,
      scrip_cd: code,
      ticker: text(r.get("TckrSymb")) || null,
      isin: text(r.get("ISIN")) || null,
      series: text(r.get("SctySrs")) || "",
      instrument: text(r.get("FinInstrmTp")) || "",
      open: num(r.get("OpnPric")),
      high: num(r.get("HghPric")),
      low: num(r.get("LwPric")),
      close: num(r.get("ClsPric")),
      last: num(r.get("LastPric")),
      prev_close: num(r.get("PrvsClsgPric")),
      volume: int(r.get("TtlTradgVol")),
      turnover: num(r.get("TtlTrfVal")),
      num_trades: int(r.get("TtlNbOfTxsExctd")),
    });
  }
  return rows;
}

/** Legacy EQ_ISINCODE CSV; headers are matched case/space-insensitively. */
export function parseLegacy(csvText: string, day: string): BhavRow[] {
  const rows: BhavRow[] = [];
  for (const raw of pyDictReader(csvText)) {
    const r = new Map<string, string | null | string[]>();
    for (const [k, v] of raw) r.set(pyStrip(k ?? "").toUpperCase(), v);
    const code = text(r.get("SC_CODE"));
    if (!code) continue;
    rows.push({
      trade_date: day,
      scrip_cd: code,
      ticker: text(r.get("SC_NAME")) || null,
      isin: text(r.get("ISIN_CODE")) || null,
      series: text(r.get("SC_TYPE")) || "",
      instrument: "STK",
      open: num(r.get("OPEN")),
      high: num(r.get("HIGH")),
      low: num(r.get("LOW")),
      close: num(r.get("CLOSE")),
      last: num(r.get("LAST")),
      prev_close: num(r.get("PREVCLOSE")),
      volume: int(r.get("NO_OF_SHRS")),
      turnover: num(r.get("NET_TURNOV")),
      num_trades: int(r.get("NO_TRADES")),
    });
  }
  return rows;
}

// --- zip ---------------------------------------------------------------------------------------
/** Not a readable zip (zipfile.BadZipFile): the day is treated as having no file. */
export class BadZip extends Error {}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** CRC-32 per entry name from the central directory (zipfile checks it on read). */
function centralCrcs(blob: Uint8Array): Map<string, number> {
  const out = new Map<string, number>();
  const dv = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  let eocd = -1;
  for (let i = blob.length - 22; i >= Math.max(0, blob.length - 22 - 65535); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return out;
  let count = dv.getUint16(eocd + 10, true);
  let at = dv.getUint32(eocd + 16, true);
  while (count-- > 0 && at + 46 <= blob.length && dv.getUint32(at, true) === 0x02014b50) {
    const nameLen = dv.getUint16(at + 28, true);
    const name = Buffer.from(blob.subarray(at + 46, at + 46 + nameLen)).toString("latin1");
    out.set(name, dv.getUint32(at + 16, true));
    at += 46 + nameLen + dv.getUint16(at + 30, true) + dv.getUint16(at + 32, true);
  }
  return out;
}

/** Text of the first *.csv member, or null when the archive has none. Throws BadZip for a broken archive. */
export function readLegacyZip(blob: Uint8Array): string | null {
  let name: string | null = null;
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(blob, {
      filter: (f) => {
        if (name !== null || !f.name.toLowerCase().endsWith(".csv")) return false;
        name = f.name;
        return true;
      },
    });
  } catch (e) {
    if ((e as { code?: number }).code === 13) throw new BadZip((e as Error).message); // "invalid zip data"
    throw e;
  }
  if (name === null) return null;
  const data = files[name];
  const crc = centralCrcs(blob).get(name);
  if (crc !== undefined && crc32(data) !== crc) throw new BadZip(`Bad CRC-32 for file '${name}'`);
  return decodeUtf8Sig(data);
}

// --- fetch -------------------------------------------------------------------------------------
/** An HTTP status error (Python's requests.HTTPError), as opposed to retries exhausted or a 302 rejection. */
const statusError = (e: unknown): e is HttpError =>
  e instanceof HttpError && !(e instanceof BadRequest) && typeof e.status === "number";

const compact = (iso: string) => iso.replace(/-/g, "");

/** Parsed rows, or null if BSE has no file for that day. */
export async function fetchDay(client: BSEClient, day: string, saveRaw = true): Promise<BhavRow[] | null> {
  const ymd = compact(day);

  try {
    const blob = await client.getBytes(NEW_URL(ymd));
    if (isHtml(blob)) {
      log.debug(`bhavcopy ${ymd}: no UDiFF file, trying legacy`);
    } else {
      const csvText = decodeUtf8Sig(blob);
      if (saveRaw) fs.writeFileSync(path.join(config.RAW_DIR, `bhavcopy_${ymd}.csv`), blob);
      const rows = parseNew(csvText, day);
      if (rows.length) return rows;
      log.debug(`bhavcopy ${ymd}: UDiFF parsed empty, trying legacy`);
    }
  } catch (e) {
    if (statusError(e)) {
      if (e.status !== 404) throw e;
    } else {
      log.debug(`new-format bhavcopy ${ymd} failed: ${(e as Error).message}`);
    }
  }

  // Fall back to the zipped formats: the ISIN variant, then the older one used for historical sessions.
  const dmy = `${day.slice(8, 10)}${day.slice(5, 7)}${day.slice(2, 4)}`;
  for (const url of [LEGACY_URL(dmy), OLD_URL(dmy)]) {
    let blob: Uint8Array;
    try {
      blob = await client.getBytes(url);
    } catch (e) {
      if (e instanceof NotFound || (statusError(e) && e.status === 404)) continue;
      throw e;
    }
    if (isHtml(blob)) continue;
    let csvText: string | null;
    try {
      csvText = readLegacyZip(blob);
    } catch (e) {
      if (e instanceof BadZip) continue;
      throw e;
    }
    if (csvText === null) continue;
    if (saveRaw) fs.writeFileSync(path.join(config.RAW_DIR, `bhavcopy_${ymd}.zip`), blob);
    return parseLegacy(csvText, day);
  }
  return null;
}

export interface BhavcopySyncOptions { refetch?: boolean; saveRaw?: boolean }

/** Backfill/update bhavcopy over a date range (ISO dates, inclusive). Returns rows written. */
export async function sync(client: BSEClient, db: Db, start: string, end: string, opts: BhavcopySyncOptions = {}): Promise<number> {
  const { refetch = false, saveRaw = true } = opts;
  const done = new Set<string>();
  if (!refetch) {
    // A day checked before the exchange publishes its file is not settled: "no file" then means "not yet".
    for (const r of db.all<{ trade_date: string; status: string; fetched_at: string }>(`SELECT trade_date, status, fetched_at FROM bhavcopy_day WHERE status IN ('ok','nodata')`)) {
      if (r.status === "ok" || eodSettled(r.trade_date, r.fetched_at)) done.add(r.trade_date);
    }
  }

  let total = 0;
  for (const key of tradingDays(start, end)) {
    if (done.has(key)) continue;

    let rows: BhavRow[] | null;
    try {
      rows = await fetchDay(client, key, saveRaw);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log.warn(`bhavcopy ${key} error: ${msg}`);
      db.upsert("bhavcopy_day", [{ trade_date: key, status: "error", rows: 0, fetched_at: now(), note: msg.slice(0, 500) }]);
      continue;
    }

    if (rows === null) {
      db.upsert("bhavcopy_day", [{ trade_date: key, status: "nodata", rows: 0, fetched_at: now(), note: "holiday or no file" }]);
      log.debug(`bhavcopy ${key}: no file (holiday?)`);
    } else {
      const got = rows;
      const n = db.transaction(() => {
        const written = db.upsert("bhavcopy", got as unknown as Record<string, unknown>[]);
        db.upsert("bhavcopy_day", [{ trade_date: key, status: "ok", rows: written, fetched_at: now(), note: null }]);
        return written;
      });
      total += n;
      log.info(`bhavcopy ${key} -> ${n} rows`);
    }
  }
  return total;
}
