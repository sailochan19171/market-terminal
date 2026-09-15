// Full list of securities listed on BSE.
//
// Endpoint: ListofScripData/w
import { now, type Db } from "../db";
import { logger } from "../log";
import type { BSEClient } from "./client";
import { asDict, pyFloat, strOf, strOrEmpty } from "./pyCompat";

const log = logger("bse.scrip_master");

export const ENDPOINT = "ListofScripData/w";
export const SEGMENTS = ["Equity", "Derivative", "Debt", "MutualFund"];

export interface ScripRow {
  scrip_cd: string; scrip_id: string | null; scrip_name: string | null; issuer_name: string | null; isin: string | null;
  grp: string | null; face_value: number | null; industry: string | null; segment: string; status: string;
  market_cap: number | null; url: string | null; updated_at: string;
}

/** Rows of one ListofScripData payload; `segment`/`status` fill in when the row omits them. */
export function parseScrips(raw: unknown, segment: string, status: string, ts: string = now()): ScripRow[] {
  const out: ScripRow[] = [];
  for (const item of raw as unknown[]) {
    const r = asDict(item);
    const code = strOf(r.SCRIP_CD);
    if (!code) continue;
    out.push({
      scrip_cd: code,
      scrip_id: strOrEmpty(r.scrip_id) || null,
      scrip_name: strOrEmpty(r.Scrip_Name) || null,
      issuer_name: strOrEmpty(r.Issuer_Name) || null,
      isin: strOrEmpty(r.ISIN_NUMBER) || null,
      grp: strOrEmpty(r.GROUP) || null,
      face_value: pyFloat(r.FACE_VALUE),
      industry: strOrEmpty(r.INDUSTRY) || null,
      segment: strOrEmpty(r.Segment, segment),
      status: strOrEmpty(r.Status, status),
      market_cap: pyFloat(r.Mktcap),
      url: strOrEmpty(r.NSURL) || null,
      updated_at: ts,
    });
  }
  return out;
}

export async function fetch(client: BSEClient, segment = "Equity", status = "Active"): Promise<ScripRow[]> {
  const raw = await client.api(ENDPOINT, { Group: "", Scripcode: "", industry: "", segment, status });
  if (!Array.isArray(raw)) {
    log.warn(`scrip master: unexpected payload for segment=${segment}`);
    return [];
  }
  return parseScrips(raw, segment, status);
}

export interface ScripSyncOptions { segments?: string[] | null; includeInactive?: boolean }

/** Refresh the scrip table. Returns rows written. */
export async function sync(client: BSEClient, db: Db, opts: ScripSyncOptions = {}): Promise<number> {
  let total = 0;
  const statuses = (opts.includeInactive ?? true) ? ["Active", "Inactive"] : ["Active"];

  for (const segment of opts.segments?.length ? opts.segments : SEGMENTS) {
    for (const status of statuses) {
      let rows: ScripRow[];
      try {
        rows = await fetch(client, segment, status);
      } catch (e) { // one bad segment shouldn't kill the run
        log.warn(`scrip master ${segment}/${status} failed: ${(e as Error).message}`);
        continue;
      }
      if (rows.length) {
        total += db.upsert("scrip", rows as unknown as Record<string, unknown>[]);
        log.info(`scrip master ${segment}/${status} -> ${rows.length} rows`);
      }
    }
  }
  return total;
}
