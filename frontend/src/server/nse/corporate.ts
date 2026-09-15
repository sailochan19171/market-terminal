// NSE corporate data: announcements, actions, board meetings, results, shareholding, insider trades.
//
// Endpoints:
//     /api/corporate-announcements?index=equities
//     /api/corporates-corporateActions?index=equities
//     /api/corporate-board-meetings?index=equities
//     /api/corporates-financial-results?index=equities&period=Quarterly
//     /api/integrated-filing-results?index=equities&type=Integrated Filing- Financials
//     /api/corporate-share-holdings-master?index=equities
//     /api/corporates-pit?index=equities        (insider trading)
//
// These return the exchange's current window rather than deep history; run them on a schedule to
// accumulate. Where an endpoint accepts from/to dates they are passed through so a backfill is possible.
import { createHash } from "node:crypto";
import { now, type Db, type Row } from "../db";
import { logger } from "../log";
import { addDays, daysBetween, todayIso } from "../util";
import { dmy, isoDateTimeOf, pyFloatLoose, pyJsonDumps, pyOr, pyStr, pyStrip, pyTruthy, strptime, textOf, textOrNull } from "./py";

const log = logger("nse.corporate");

export const ANNOUNCEMENTS = "corporate-announcements";
export const CORP_ACTIONS = "corporates-corporateActions";
export const BOARD_MEETINGS = "corporate-board-meetings";
export const RESULTS = "corporates-financial-results";
export const SHAREHOLDING = "corporate-share-holdings-master";
export const INSIDER = "corporates-pit";

type Params = Record<string, string | number>;
/** Anything with NSEClient.api - the real client, or a fake in tests. */
export type ApiClient = { api(path: string, params?: Params): Promise<unknown> };
type Obj = Record<string, unknown>;

// "%d-%^b-%Y" is not a valid strptime directive; Python raises ValueError for it and moves on, as strptime() here does.
const DATE_FORMATS = ["%d-%b-%Y %H:%M:%S", "%d-%b-%Y", "%d-%B-%Y", "%d-%m-%Y", "%Y-%m-%d", "%d-%b-%Y %H:%M", "%d-%^b-%Y"];

/**
 * Python corporate._norm_dt: "YYYY-MM-DDTHH:MM:SS" when the text matches one of the exchange formats, else the
 * original (stripped) text; None for blank / "-". (The title-case retry in Python can never succeed where the
 * case-insensitive formats failed, so it is not repeated.)
 */
export function normDt(v: unknown): string | null {
  const s = pyStrip(pyTruthy(v) ? pyStr(v) : "");
  if (!s || s === "-") return null;
  for (const fmt of DATE_FORMATS) {
    const d = strptime(s, fmt);
    if (d) return isoDateTimeOf(d);
  }
  return s;
}

export const normDate = (v: unknown): string => {
  const iso = normDt(v);
  return iso ? iso.slice(0, 10) : "";
};

const f = pyFloatLoose;
export { f as toFloat };

/** NSE returns either a bare list or {'data': [...]}. */
export function rows(payload: unknown): Obj[] {
  if (Array.isArray(payload)) return payload as Obj[];
  if (payload && typeof payload === "object") {
    for (const key of ["data", "rows", "records"]) {
      const v = (payload as Obj)[key];
      if (Array.isArray(v)) return v as Obj[];
    }
  }
  return [];
}

// NSE serves these endpoints a window at a time. Without dates it returns only the latest ~20 records, so a
// window is nearly always what you want; long ranges are split into chunks this size.
export const WINDOW_DAYS = 30;

type MaybeDate = string | null | undefined;

export function windowParams(params: Params, start: MaybeDate, end: MaybeDate): Params {
  if (start && end) return { ...params, from_date: dmy(start), to_date: dmy(end) };
  return params;
}

/** (from, to) pairs of at most WINDOW_DAYS, or one [null, null]. */
export function chunks(start: MaybeDate, end: MaybeDate): Array<[string | null, string | null]> {
  if (!(start && end)) return [[null, null]];
  const out: Array<[string, string]> = [];
  for (let cur = start; cur <= end;) {
    const cand = addDays(cur, WINDOW_DAYS - 1);
    const stop = cand < end ? cand : end;
    out.push([cur, stop]);
    cur = addDays(stop, 1);
  }
  return out;
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Call an endpoint across as many windows as the range needs. */
export async function fetchWindowed(client: ApiClient, endpoint: string, params: Params, start: MaybeDate, end: MaybeDate): Promise<Obj[]> {
  const collected: Obj[] = [];
  for (const [frm, to] of chunks(start, end)) {
    let payload: unknown;
    try {
      payload = await client.api(endpoint, windowParams(params, frm, to));
    } catch (e) {
      log.warn(`${endpoint} [${frm}..${to}]: ${errText(e)}`);
      continue;
    }
    const got = rows(payload);
    collected.push(...got);
    if (frm) log.debug(`${endpoint} ${frm}..${to} -> ${got.length}`);
  }
  return collected;
}

/** sha1 hex[:20] over "|".join(str(p or "") for p in parts). */
export function digest(...parts: unknown[]): string {
  const joined = parts.map((p) => (pyTruthy(p) ? pyStr(p) : "")).join("|");
  return createHash("sha1").update(joined, "utf8").digest("hex").slice(0, 20);
}

// --- announcements ------------------------------------------------------------------
export function announcementRows(raw: Obj[], ts: string): Row[] {
  const out: Row[] = [];
  for (const r of raw) {
    const symbol = textOf(r.symbol);
    const subject = textOf(pyOr(r.desc, r.attchmntText, ""));
    const annDt = normDt(pyOr(r.an_dt, r.sort_date));
    if (!(symbol || subject)) continue;
    out.push({
      ann_id: digest(symbol, annDt, subject, r.attchmntFile),
      symbol: symbol || null,
      company: textOrNull(r.sm_name),
      subject: subject || null,
      details: textOrNull(r.attchmntText),
      ann_dt: annDt,
      pdf_url: textOrNull(r.attchmntFile),
      fetched_at: ts,
    });
  }
  return out;
}

export async function syncAnnouncements(client: ApiClient, db: Db, start?: MaybeDate, end?: MaybeDate): Promise<number> {
  const raw = await fetchWindowed(client, ANNOUNCEMENTS, { index: "equities" }, start, end);
  const n = db.upsert("nse_announcement", announcementRows(raw, now()));
  log.info(`nse announcements -> ${n}`);
  return n;
}

// --- corporate actions --------------------------------------------------------------
export function corpActionRows(raw: Obj[], ts: string): Row[] {
  const out: Row[] = [];
  for (const r of raw) {
    const symbol = textOf(r.symbol);
    const purpose = textOf(pyOr(r.subject, r.purpose, ""));
    if (!symbol || !purpose) continue;
    out.push({
      symbol,
      purpose,
      ex_date: normDate(r.exDate),
      record_date: normDate(r.recDate),
      series: textOrNull(r.series),
      company: textOrNull(r.comp),
      isin: textOrNull(r.isin),
      face_value: f(r.faceVal),
      bc_start: normDate(r.bcStartDate) || null,
      bc_end: normDate(r.bcEndDate) || null,
      fetched_at: ts,
    });
  }
  return out;
}

export async function syncCorpActions(client: ApiClient, db: Db, start?: MaybeDate, end?: MaybeDate): Promise<number> {
  const raw = await fetchWindowed(client, CORP_ACTIONS, { index: "equities" }, start, end);
  const n = db.upsert("nse_corp_action", corpActionRows(raw, now()));
  log.info(`nse corp actions -> ${n}`);
  return n;
}

// --- board meetings -----------------------------------------------------------------
export function boardMeetingRows(raw: Obj[], ts: string): Row[] {
  const out: Row[] = [];
  for (const r of raw) {
    const symbol = textOf(pyOr(r.bm_symbol, r.symbol, ""));
    if (!symbol) continue;
    out.push({
      symbol,
      meeting_dt: normDate(r.bm_date),
      purpose: textOrNull(r.bm_purpose),
      description: textOrNull(r.bm_desc),
      company: textOrNull(pyOr(r.sm_name, r.comp, "")),
      fetched_at: ts,
    });
  }
  return out;
}

export async function syncBoardMeetings(client: ApiClient, db: Db, start?: MaybeDate, end?: MaybeDate): Promise<number> {
  const raw = await fetchWindowed(client, BOARD_MEETINGS, { index: "equities" }, start, end);
  const n = db.upsert("nse_board_meeting", boardMeetingRows(raw, now()));
  log.info(`nse board meetings -> ${n}`);
  return n;
}

// --- financial results --------------------------------------------------------------
export function resultRows(payload: unknown, ts: string): Row[] {
  const out: Row[] = [];
  for (const r of rows(payload)) {
    const symbol = textOf(r.symbol);
    if (!symbol) continue;
    out.push({
      symbol,
      period_end: normDate(pyOr(r.toDate, r.period)),
      consolidated: textOf(r.consolidated),
      audited: textOrNull(r.audited),
      company: textOrNull(r.companyName),
      broadcast_dt: normDt(r.broadCastDate),
      xbrl_url: textOrNull(pyOr(r.xbrl, r.naVal, "")),
      raw: pyJsonDumps(r),
      fetched_at: ts,
    });
  }
  return out;
}

/** One calendar-year window per year touched by [start, end], or one undated request. */
export function resultWindows(start: MaybeDate, end: MaybeDate): Array<[string | null, string | null]> {
  if (!(start && end)) return [[null, null]];
  const out: Array<[string, string]> = [];
  for (let year = Number(start.slice(0, 4)); year <= Number(end.slice(0, 4)); year++) {
    const y = String(year).padStart(4, "0");
    out.push([`${y}-01-01`, `${y}-12-31`]);
  }
  return out;
}

/**
 * Result filings. Windowed by year to reach back a decade.
 *
 * Without dates the endpoint returns only the newest batch (~3,800 rows, one quarter). Given a date window it
 * serves history - a 2016 window returns filings back to mid-2014 - so a multi-year backfill walks one year at
 * a time. This stores filing METADATA only; the figures live in each filing's XBRL.
 */
export async function syncResults(client: ApiClient, db: Db, period = "Quarterly", start?: MaybeDate, end?: MaybeDate): Promise<number> {
  const ts = now();
  let total = 0;
  for (const [frm, to] of resultWindows(start, end)) {
    const params: Params = { index: "equities", period };
    if (frm && to) {
      params.from_date = dmy(frm);
      params.to_date = dmy(to);
    }
    const label = frm ? frm.slice(0, 4).replace(/^0+/, "") : "latest";
    let payload: unknown;
    try {
      payload = await client.api(RESULTS, params);
    } catch (e) {
      log.warn(`results ${label}: ${errText(e)}`);
      continue;
    }
    const n = db.upsert("nse_financial_result", resultRows(payload, ts));
    total += n;
    log.info(`results ${label} -> ${n} rows`);
  }
  log.info(`nse financial results (${period}) -> ${total} rows`);
  return total;
}

// --- integrated filings (results from 2025) -------------------------------------------
export const INTEGRATED = "integrated-filing-results";
export const INTEGRATED_FINANCIALS = "Integrated Filing- Financials";
export const INTEGRATED_PAGE = 1000; // the largest page the endpoint serves
export const INTEGRATED_SINCE = "2025-01-01";

/** Python's `total > len(rows)`; comparing a non-number with an int raises TypeError there. */
function exceeds(total: unknown, count: number): boolean {
  if (typeof total === "number") return total > count;
  if (typeof total === "boolean") return Number(total) > count;
  throw new TypeError(`'>' not supported between instances of '${typeof total}' and 'int'`);
}

/**
 * Every financials filing broadcast in [start, end].
 *
 * The endpoint pages, but its sort order is not stable between calls, so paging can skip or repeat rows.
 * Instead a window that does not fit in one response is split in half until each piece does.
 */
export async function integratedWindow(client: ApiClient, start: string, end: string): Promise<Obj[]> {
  const params: Params = {
    index: "equities", type: INTEGRATED_FINANCIALS, size: INTEGRATED_PAGE,
    from_date: dmy(start), to_date: dmy(end),
  };
  const payload = await client.api(INTEGRATED, params);
  const got = rows(payload);
  const total = payload && typeof payload === "object" && !Array.isArray(payload) ? (payload as Obj).totalCount : undefined;
  const has = total !== undefined && total !== null;
  if (has && exceeds(total, got.length) && start < end) {
    const mid = addDays(start, Math.floor(daysBetween(start, end) / 2));
    return [...await integratedWindow(client, start, mid), ...await integratedWindow(client, addDays(mid, 1), end)];
  }
  if (has && exceeds(total, got.length)) {
    log.warn(`integrated filings ${start}: ${got.length} of ${total} rows (single day over page size)`);
  }
  return got;
}

/** Dedupe integrated filings to one row per (symbol, period, basis); a revised filing supersedes the original. */
export function integratedRows(raw: Obj[], ts: string): Row[] {
  const best = new Map<string, Row>();
  for (const r of raw) {
    const sym = textOf(r.symbol);
    const period = normDate(r.qe_Date);
    const basis = textOf(r.consolidated);
    const url = textOf(r.xbrl);
    if (!sym || !period || !basis || !url.toLowerCase().endsWith(".xml")) continue;
    const row: Row = {
      symbol: sym, period_end: period, consolidated: basis,
      audited: textOrNull(r.audited),
      company: textOrNull(pyOr(r.smName, r.cmName, "")),
      broadcast_dt: normDt(pyOr(r.broadcast_Date, r.creation_Date)),
      xbrl_url: url,
      raw: pyJsonDumps(r),
      fetched_at: ts,
    };
    const key = JSON.stringify([sym, period, basis]);
    const prev = best.get(key);
    if (prev === undefined || String(row.broadcast_dt || "") >= String(prev.broadcast_dt || "")) best.set(key, row);
  }
  return [...best.values()];
}

/**
 * Quarterly results filed under SEBI's Integrated Filing format.
 *
 * From early 2025 NSE publishes results through the integrated-filing feed; the older corporates-financial-results
 * endpoint stops at the December 2024 quarter. Rows land in nse_financial_result with the same meaning.
 */
export async function syncIntegratedResults(client: ApiClient, db: Db, start?: MaybeDate, end?: MaybeDate, symbol?: string | null): Promise<number> {
  const stopAt = end || todayIso();
  const from = start || INTEGRATED_SINCE;
  const raw: Obj[] = [];
  if (symbol) {
    raw.push(...rows(await client.api(INTEGRATED, { index: "equities", type: INTEGRATED_FINANCIALS, symbol, size: INTEGRATED_PAGE })));
  } else {
    for (let cur = from; cur <= stopAt;) { // monthly chunks keep each split shallow
      const cand = addDays(cur, 30);
      const stop = cand < stopAt ? cand : stopAt;
      try {
        raw.push(...await integratedWindow(client, cur, stop));
      } catch (e) {
        log.warn(`integrated filings ${cur}..${stop}: ${errText(e)}`);
      }
      cur = addDays(stop, 1);
    }
  }

  const out = integratedRows(raw, now());
  const n = db.transaction(() => {
    // A superseded XBRL link must be re-parsed, so drop stale parsed figures.
    for (const r of out) {
      db.run("DELETE FROM nse_fundamental WHERE symbol = ? AND period_end = ? AND consolidated = ? AND xbrl_url IS NOT NULL AND xbrl_url != ?",
        [r.symbol, r.period_end, r.consolidated, r.xbrl_url]);
    }
    return db.upsert("nse_financial_result", out);
  });
  log.info(`nse integrated financial results -> ${n} rows (${raw.length} fetched)`);
  return n;
}

// --- shareholding -------------------------------------------------------------------
export function shareholdingRows(payload: unknown, ts: string): Row[] {
  const out: Row[] = [];
  for (const r of rows(payload)) {
    const symbol = textOf(r.symbol);
    if (!symbol) continue;
    out.push({
      symbol,
      as_of_date: normDate(r.date),
      company: textOrNull(r.name),
      isin: textOrNull(r.isin),
      promoter: f(pyOr(r.promoter, r.pr_and_prgrp)),
      public: f(pyOr(r.public_val, r.public, r.publicVal)),
      emp_trusts: f(r.employeeTrusts),
      broadcast_dt: normDt(r.broadcastDate),
      raw: pyJsonDumps(r),
      fetched_at: ts,
    });
  }
  return out;
}

export async function syncShareholding(client: ApiClient, db: Db): Promise<number> {
  const payload = await client.api(SHAREHOLDING, { index: "equities" });
  const n = db.upsert("nse_shareholding", shareholdingRows(payload, now()));
  log.info(`nse shareholding -> ${n}`);
  return n;
}

// --- insider trading ----------------------------------------------------------------
export function insiderRows(raw: Obj[], ts: string): Row[] {
  const out: Row[] = [];
  for (const r of raw) {
    const symbol = textOf(r.symbol);
    if (!symbol) continue;
    out.push({
      symbol,
      acquirer: textOf(r.acqName),
      broadcast: normDt(pyOr(r.date, r.timestamp)) || "",
      company: textOrNull(r.company),
      security: textOrNull(r.secType),
      quantity: f(r.secAcq),
      value: f(r.secVal),
      txn_type: textOrNull(r.tdpTransactionType),
      raw: pyJsonDumps(r),
      fetched_at: ts,
    });
  }
  return out;
}

export async function syncInsider(client: ApiClient, db: Db, start?: MaybeDate, end?: MaybeDate): Promise<number> {
  const raw = await fetchWindowed(client, INSIDER, { index: "equities" }, start, end);
  const n = db.upsert("nse_insider_trade", insiderRows(raw, now()));
  log.info(`nse insider trades -> ${n}`);
  return n;
}

// --- run.py wiring ------------------------------------------------------------------
type Step = (client: ApiClient, db: Db, start: MaybeDate, end: MaybeDate) => Promise<number>;

/** run.py NSE_CORPORATE_STEPS, in the same order. */
export const CORPORATE_STEPS: Record<string, Step> = {
  announcements: (c, db, s, e) => syncAnnouncements(c, db, s, e),
  actions: (c, db, s, e) => syncCorpActions(c, db, s, e),
  "board-meetings": (c, db, s, e) => syncBoardMeetings(c, db, s, e),
  results: (c, db, s, e) => syncResults(c, db, "Quarterly", s, e),
  // Results filed from 2025 onward come through the integrated-filing feed.
  "integrated-results": (c, db, s, e) => syncIntegratedResults(c, db, s, e),
  shareholding: (c, db) => syncShareholding(c, db),
  insider: (c, db, s, e) => syncInsider(c, db, s, e),
};

/** run.py corporate_window: NSE corporate endpoints return only ~20 rows without a date window. */
export function corporateWindow(args: { start?: string | null; end?: string | null; years?: number | null }, defaultDays = 30): [string, string] {
  const end = args.end || todayIso();
  if (args.start) return [args.start, end];
  if (args.years) return [addDays(end, -pyRound(args.years * 365.25)), end];
  return [addDays(end, -defaultDays), end];
}

/** Python round(): half to even. */
function pyRound(x: number): number {
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
}
