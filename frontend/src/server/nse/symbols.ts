// NSE equity masters - every listed symbol, main board and SME.
//
// Sources:
//     /content/equities/EQUITY_L.csv                   main board
//     /emerge/corporates/content/SME_EQUITY_L.csv       SME (Emerge) platform
//
// The two files spell their headers differently ("NAME OF COMPANY" vs "NAME_OF_COMPANY") and their dates
// differently ("06-OCT-2008" vs "11-Sep-26"), so both are normalised here.
import { now, type Db, type Row } from "../db";
import { NotFound } from "../http";
import { logger } from "../log";
import type { NSEClient } from "./client";
import { decodeUtf8Sig, dictReader, isoDateOf, normKeys, pyFloat, pyInt, pyStr, pyStrip, strptime, textOrNull } from "./py";

const log = logger("nse.symbols");

export const EQUITY_LIST = "/content/equities/EQUITY_L.csv";
export const SME_LIST = "/emerge/corporates/content/SME_EQUITY_L.csv";

type ArchiveClient = Pick<NSEClient, "archive">;

/** float(str(v).strip().replace(",", "")) or None */
const f = (v: unknown): number | null => pyFloat(pyStrip(pyStr(v)).replace(/,/g, ""));

function date(v: unknown): string | null {
  const s = pyStrip(v === null || v === undefined || v === "" ? "" : String(v));
  if (!s) return null;
  for (const fmt of ["%d-%b-%Y", "%d-%b-%y"]) {
    const d = strptime(s, fmt);
    if (d) return isoDateOf(d);
  }
  return s;
}

export interface SymbolRow {
  symbol: string; company: string | null; series: string | null; listing_date: string | null; paid_up: number | null;
  market_lot: number | null; isin: string | null; face_value: number | null; updated_at: string;
}

export function parse(text: string): SymbolRow[] {
  const ts = now();
  const rows: SymbolRow[] = [];
  for (const raw of dictReader(text)) {
    const r = normKeys(raw, (k) => pyStrip(k).toUpperCase().replace(/_/g, " "));
    const symbol = textOrNull(r.get("SYMBOL")) ?? "";
    if (!symbol) continue;
    rows.push({
      symbol,
      company: textOrNull(r.get("NAME OF COMPANY")),
      series: textOrNull(r.get("SERIES")),
      listing_date: date(r.get("DATE OF LISTING")),
      paid_up: f(r.get("PAID UP VALUE")),
      market_lot: pyInt(f(r.get("MARKET LOT"))),
      isin: textOrNull(r.get("ISIN NUMBER")),
      face_value: f(r.get("FACE VALUE")),
      updated_at: ts,
    });
  }
  return rows;
}

export async function fetchSymbols(client: ArchiveClient): Promise<SymbolRow[]> {
  const rows = parse(decodeUtf8Sig(await client.archive(EQUITY_LIST)));
  let sme: SymbolRow[] = [];
  try {
    sme = parse(decodeUtf8Sig(await client.archive(SME_LIST)));
  } catch (e) {
    if (!(e instanceof NotFound)) throw e;
  }
  const main = new Set(rows.map((r) => r.symbol));
  rows.push(...sme.filter((r) => !main.has(r.symbol)));
  log.info(`nse symbols: ${main.size} main board, ${sme.length} SME`);
  return rows;
}

export async function sync(client: ArchiveClient, db: Db): Promise<number> {
  const rows = await fetchSymbols(client);
  const n = db.upsert("nse_symbol", rows as unknown as Row[]);
  log.info(`nse symbols -> ${n}`);
  return n;
}

export { sync as syncSymbols, f as toFloat, date as parseDate };
