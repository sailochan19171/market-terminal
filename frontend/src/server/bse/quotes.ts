// Live quote snapshots.
//
// Endpoint: getScripHeaderData/w. A point-in-time snapshot, not a history feed - use it for watchlist
// price-move alerts. EOD history comes from bhavcopy.
import { now, type Db } from "../db";
import { BadRequest } from "../http";
import { logger } from "../log";
import type { BSEClient } from "./client";
import { asDict, isDict, pyFloat, pyJsonDumps, pyStr, pyTruthy } from "./pyCompat";

const log = logger("bse.quotes");

export const ENDPOINT = "getScripHeaderData/w";

export interface QuoteSnapshot { scrip_cd: string; as_of: string; ltp: number | null; change: number | null; pct_change: number | null; raw: string }

/** A getScripHeaderData payload to a quote_snapshot row (null when the payload is not an object). */
export function parseQuote(scripCd: string | number, raw: unknown, asOf: string = now()): QuoteSnapshot | null {
  if (!isDict(raw)) return null;
  const cur = asDict(pyTruthy(raw.CurrRate) ? raw.CurrRate : {});
  return {
    scrip_cd: pyStr(scripCd),
    as_of: asOf,
    ltp: pyFloat(cur.LTP),
    change: pyFloat(cur.Chg),
    pct_change: pyFloat(cur.PcChg),
    raw: pyJsonDumps(raw),
  };
}

export async function fetch(client: BSEClient, scripCd: string | number): Promise<QuoteSnapshot | null> {
  const raw = await client.api(ENDPOINT, { Debtflag: "", scripcode: pyStr(scripCd), seriesid: "" });
  return parseQuote(scripCd, raw);
}

/** Snapshot the given scrips; rejected or failing codes are skipped. Returns rows written. */
export async function snapshot(client: BSEClient, db: Db, scrips: Iterable<string | number>): Promise<number> {
  const rows: QuoteSnapshot[] = [];
  for (const code of scrips) {
    let q: QuoteSnapshot | null;
    try {
      q = await fetch(client, code);
    } catch (e) {
      if (e instanceof BadRequest) log.debug(`quote ${code}: rejected`);
      else log.warn(`quote ${code}: ${(e as Error).message}`);
      continue;
    }
    if (q) rows.push(q);
  }
  return db.upsert("quote_snapshot", rows as unknown as Record<string, unknown>[]);
}

/** Alias so every source exposes `sync`; Python named this `snapshot`. */
export const sync = snapshot;
