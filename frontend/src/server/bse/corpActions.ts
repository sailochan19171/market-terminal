// Corporate actions - dividends, splits, bonuses, rights.
//
// Two endpoints:
//   * Corpaction/w        -> market-wide list of forthcoming actions
//   * CorporateAction/w   -> full history for one scrip
import { now, type Db } from "../db";
import { BadRequest } from "../http";
import { logger } from "../log";
import type { BSEClient } from "./client";
import { asciiDigits, asDict, isDict, pyParseFloat, pyStr, pyStrip, pyTruthy, strOf, strOrEmpty } from "./pyCompat";

const log = logger("bse.corp_actions");

export const MARKET_WIDE = "Corpaction/w";
export const PER_SCRIP = "CorporateAction/w";

export interface CorpAction {
  scrip_cd: string; purpose: string; ex_date: string; record_date: string; bc_from: string; bc_to: string | null;
  amount: number | null; security: string | null; fetched_at: string;
}

const AMT = /(?:Rs\.?)\s*-?\s*([0-9]+(?:\.[0-9]+)?)/iu;

/** Rupee amount mentioned in a purpose such as "Final Dividend - Rs. - 2.5000". */
export function amountFromPurpose(text: string | null | undefined): number | null {
  const m = AMT.exec(text || "");
  return m ? pyParseFloat(m[1]) : null;
}

// datetime.strptime for "%d/%m/%Y", "%d %b %Y", "%d-%m-%Y", "%Y-%m-%d", tried in that order.
// Python's \d is Unicode-aware there, hence \p{Nd}.
const D = "(3[01]|[12]\\p{Nd}|0[1-9]|[1-9]| [1-9])";
const M = "(1[0-2]|0[1-9]|[1-9])";
const Y = "(\\p{Nd}\\p{Nd}\\p{Nd}\\p{Nd})";
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const B = `(${MONTHS.join("|")})`;
const FORMATS: { re: RegExp; ymd: (m: RegExpExecArray) => [string, string, string] }[] = [
  { re: new RegExp(`^${D}/${M}/${Y}$`, "u"), ymd: (m) => [m[3], m[2], m[1]] },
  { re: new RegExp(`^${D}\\s+${B}\\s+${Y}$`, "iu"), ymd: (m) => [m[3], String(MONTHS.indexOf(m[2].toLowerCase()) + 1), m[1]] },
  { re: new RegExp(`^${D}-${M}-${Y}$`, "u"), ymd: (m) => [m[3], m[2], m[1]] },
  { re: new RegExp(`^${Y}-${M}-${D}$`, "u"), ymd: (m) => [m[1], m[2], m[3]] },
];

function validDate(y: number, mo: number, d: number): boolean {
  if (y < 1 || mo < 1 || mo > 12 || d < 1) return false;
  const dim = [31, (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1];
  return d <= dim;
}

/** ISO date for the formats BSE uses; unrecognised text is kept as-is, empty stays "". */
export function normDate(v: unknown): string {
  const s = strOf(v);
  if (!s) return "";
  for (const f of FORMATS) {
    const m = f.re.exec(s);
    if (!m) continue;
    const [ys, ms, ds] = f.ymd(m);
    const y = Number(asciiDigits(ys)), mo = Number(ms), d = Number(asciiDigits(pyStrip(ds)));
    if (!validDate(y, mo, d)) continue;
    return `${String(y).padStart(4, "0")}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  }
  return s;
}

/** str.partition(sep) */
function partition(s: string, sep: string): [string, string] {
  const i = s.indexOf(sep);
  return i < 0 ? [s, ""] : [s.slice(0, i), s.slice(i + sep.length)];
}

/** Rows of the market-wide Corpaction/w payload. */
export function parseForthcoming(raw: unknown, ts: string = now()): CorpAction[] {
  if (!Array.isArray(raw)) return [];
  const out: CorpAction[] = [];
  for (const item of raw) {
    const r = asDict(item);
    const code = strOf(r.Code);
    const purpose = strOrEmpty(r.Purpose);
    if (!code || !purpose) continue;
    const [bcFrom, bcTo] = partition(strOrEmpty(r.BCPeriod), "-");
    out.push({
      scrip_cd: code,
      purpose,
      ex_date: normDate(r.ExDate),
      record_date: normDate(r.RecordDate),
      bc_from: normDate(bcFrom),
      bc_to: normDate(bcTo) || null,
      amount: amountFromPurpose(purpose),
      security: strOrEmpty(r.Security) || null,
      fetched_at: ts,
    });
  }
  return out;
}

/** Rows of the per-scrip CorporateAction/w payload (a list, or a dict holding "Table"). */
export function parseScripHistory(scripCd: string | number, raw: unknown, ts: string = now()): CorpAction[] {
  const table = isDict(raw) ? raw.Table : raw;
  if (!Array.isArray(table)) return [];
  const code = pyStr(scripCd);
  const out: CorpAction[] = [];
  for (const item of table) {
    const r = asDict(item);
    const purpose = strOrEmpty(pyTruthy(r.purpose_name) ? r.purpose_name : r.Purpose);
    if (!purpose) continue;
    const amt = r.Amount;
    out.push({
      scrip_cd: code,
      purpose,
      ex_date: normDate(pyTruthy(r.Ex_date) ? r.Ex_date : r.ExDate),
      record_date: normDate(pyTruthy(r.RD_Date) ? r.RD_Date : r.RecordDate),
      bc_from: normDate(r.BCRD_from),
      bc_to: normDate(r.BCRD_to) || null,
      amount: typeof amt === "number" || typeof amt === "boolean" ? Number(amt) : amountFromPurpose(purpose),
      security: strOrEmpty(r.Security) || null,
      fetched_at: ts,
    });
  }
  return out;
}

const QUERY = { Fdate: "", Purposecode: "", TDate: "", ddlcategorys: "E", ddlindustrys: "", segment: "0", strSearch: "S" };

export async function fetchForthcoming(client: BSEClient): Promise<CorpAction[]> {
  const raw = await client.api(MARKET_WIDE, { scripcode: "", ...QUERY });
  return parseForthcoming(raw);
}

export async function fetchScrip(client: BSEClient, scripCd: string | number): Promise<CorpAction[]> {
  const raw = await client.api(PER_SCRIP, { scripcode: pyStr(scripCd), ...QUERY });
  return parseScripHistory(scripCd, raw);
}

export interface CorpActionSyncOptions { perScrip?: boolean; limit?: number | null }

/** Forthcoming actions always; full per-scrip history when asked. Returns rows written. */
export async function sync(client: BSEClient, db: Db, opts: CorpActionSyncOptions = {}): Promise<number> {
  let total = db.upsert("corp_action", await fetchForthcoming(client) as unknown as Record<string, unknown>[]);
  log.info(`corp actions (forthcoming) -> ${total} rows`);

  if (!opts.perScrip) return total;

  let codes = db.all<{ scrip_cd: string }>("SELECT scrip_cd FROM scrip WHERE segment='Equity' AND status='Active' ORDER BY scrip_cd").map((r) => r.scrip_cd);
  if (opts.limit) codes = codes.slice(0, opts.limit);

  for (let i = 1; i <= codes.length; i++) {
    const code = codes[i - 1];
    let rows: CorpAction[];
    try {
      rows = await fetchScrip(client, code);
    } catch (e) {
      if (!(e instanceof BadRequest)) log.warn(`corp actions ${code}: ${(e as Error).message}`);
      continue;
    }
    if (rows.length) total += db.upsert("corp_action", rows as unknown as Record<string, unknown>[]);
    if (i % 100 === 0) log.info(`corp actions: ${i}/${codes.length} scrips`);
  }
  return total;
}
