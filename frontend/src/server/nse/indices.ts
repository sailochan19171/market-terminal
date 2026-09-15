// NSE indices - live values for all indices, plus constituents.
//
// Sources:
//     /api/allIndices                              -> every index with OHLC, PE/PB
//     /content/indices/ind_<name>list.csv          -> constituents per index
import { now, type Db, type Row } from "../db";
import { NotFound } from "../http";
import { logger } from "../log";
import type { NSEClient } from "./client";
import { decodeUtf8Sig, dictReader, normKeys, pyFloatLoose, pyOr, pyStrip, pyTruthy, textOf, textOrNull } from "./py";

const log = logger("nse.indices");

export const ALL_INDICES = "allIndices";
export const CONSTITUENTS = "/content/indices/ind_{slug}list.csv";

// Index constituent files exist only for the headline indices; these are the ones NSE actually publishes.
export const CONSTITUENT_SLUGS = [
  "nifty50", "niftynext50", "nifty100", "nifty200", "nifty500",
  "niftymidcap50", "niftymidcap100", "niftymidcap150",
  "niftysmallcap50", "niftysmallcap100", "niftysmallcap250",
  "niftybank", "niftyit", "niftyauto", "niftyfmcg", "niftypharma",
  "niftymetal", "niftyrealty", "niftyenergy", "niftyinfra",
  "niftymedia", "niftypsubank", "niftyprivatebank",
  "niftyfinancialservices", "niftyhealthcare", "niftyconsumerdurables",
  "niftyoilgas", "niftycommodities", "niftyconsumption", "niftycpse",
  "niftymnc", "niftypse", "niftyservicessector", "niftygrowsect15",
  // Broad-market lists: these carry the industry tag for ~1,000 companies,
  // which is what sector browsing and peer comparison key on.
  "niftytotalmarket", "niftymicrocap250",
];

// NSE is inconsistent: headline lists are ind_nifty50list.csv, broad-market ones are
// ind_niftytotalmarket_list.csv. Try both spellings.
export const CONSTITUENT_PATTERNS = [CONSTITUENTS, "/content/indices/ind_{slug}_list.csv"];

type Client = Pick<NSEClient, "api" | "archive">;
type Obj = Record<string, unknown>;

/** float(str(v).replace(",", "").strip()) or None */
const f = pyFloatLoose;

export const slug = (indexSymbol: string) => (indexSymbol || "").toLowerCase().replace(/[^a-z0-9]/g, "");

const get = (r: unknown, k: string): unknown => (r && typeof r === "object" && !Array.isArray(r) ? (r as Obj)[k] : undefined);

export interface IndexRows { masters: Row[]; values: Row[] }

/** The nse_index / nse_index_value rows for one allIndices payload. */
export function parseValues(payload: unknown, ts: string): IndexRows {
  const data = pyTruthy(payload) ? get(payload, "data") : undefined;
  const rows = (pyTruthy(data) ? data : []) as Obj[];
  const masters: Row[] = [];
  const values: Row[] = [];
  for (const r of rows) {
    const symbol = textOf(pyOr(r.indexSymbol, r.index, ""));
    if (!symbol) continue;
    masters.push({
      index_symbol: symbol,
      index_name: textOrNull(r.index),
      grp: textOrNull(r.key),
      updated_at: ts,
    });
    values.push({
      index_symbol: symbol,
      as_of: ts,
      last: f(r.last),
      variation: f(r.variation),
      pct_change: f(r.percentChange),
      open: f(r.open),
      high: f(r.high),
      low: f(r.low),
      prev_close: f(r.previousClose),
      year_high: f(r.yearHigh),
      year_low: f(r.yearLow),
      pe: f(r.pe),
      pb: f(r.pb),
      div_yield: f(r.dy),
    });
  }
  return { masters, values };
}

export async function syncValues(client: Pick<NSEClient, "api">, db: Db): Promise<number> {
  const payload = await client.api(ALL_INDICES);
  const { masters, values } = parseValues(payload, now());
  const n = db.transaction(() => db.upsert("nse_index", masters) + db.upsert("nse_index_value", values));
  log.info(`nse indices -> ${masters.length} master, ${values.length} values`);
  return n;
}

/** Constituent rows from one ind_*list.csv. */
export function parseConstituents(csvText: string, slugName: string, ts: string): Row[] {
  const out: Row[] = [];
  for (const raw of dictReader(csvText)) {
    const r = normKeys(raw, (k) => pyStrip(k).toLowerCase());
    const symbol = textOf(r.get("symbol"));
    if (!symbol) continue;
    out.push({
      index_symbol: slugName,
      symbol,
      company: textOrNull(r.get("company name")),
      industry: textOrNull(r.get("industry")),
      isin: textOrNull(r.get("isin code")),
      updated_at: ts,
    });
  }
  return out;
}

export async function fetchConstituents(client: Pick<NSEClient, "archive">, slugName: string): Promise<Row[]> {
  let text = "";
  for (const pattern of CONSTITUENT_PATTERNS) {
    let blob: Uint8Array;
    try {
      blob = await client.archive(pattern.replace("{slug}", slugName));
    } catch (e) {
      if (e instanceof NotFound) continue;
      throw e;
    }
    text = decodeUtf8Sig(blob);
    if (!text.slice(0, 200).toLowerCase().includes("<html")) break;
    text = "";
  }
  if (!text) return [];
  return parseConstituents(text, slugName, now());
}

export async function syncConstituents(client: Pick<NSEClient, "archive">, db: Db, slugs?: string[] | null): Promise<number> {
  let total = 0;
  for (const s of slugs && slugs.length ? slugs : CONSTITUENT_SLUGS) {
    let rows: Row[];
    try {
      rows = await fetchConstituents(client, s);
    } catch (e) {
      if (e instanceof NotFound) log.debug(`no constituent file for ${s}`);
      else log.warn(`constituents ${s}: ${e instanceof Error ? e.message : e}`);
      continue;
    }
    if (rows.length) {
      total += db.upsert("nse_index_constituent", rows);
      log.info(`constituents ${s} -> ${rows.length}`);
    }
  }
  return total;
}

export async function sync(client: Client, db: Db, constituents = true): Promise<number> {
  let total = await syncValues(client, db);
  if (constituents) total += await syncConstituents(client, db);
  return total;
}

export { sync as syncIndices, f as toFloat };
