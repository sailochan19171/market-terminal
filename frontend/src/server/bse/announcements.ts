// Corporate announcements / filings.
//
// Endpoint: AnnSubCategoryGetData/w. Two modes, both confirmed against the live API:
//   * market-wide - strScrip empty. BSE only honours this when strPrevDate == strToDate, i.e. one
//     calendar day per call, paginated.
//   * per-scrip   - strScrip set. Accepts a wide date range in one call.
// Attachments live at /xml-data/corpfiling/AttachLive/<ATTACHMENTNAME>.
import { now, type Db } from "../db";
import { logger } from "../log";
import { addDays, todayIso } from "../util";
import { WWW, type BSEClient } from "./client";
import { asDict, asList, isDict, pyStr, pyStrip, pyTruthy } from "./pyCompat";

const log = logger("bse.announcements");

export const ENDPOINT = "AnnSubCategoryGetData/w";
export const ATTACH_BASE = WWW + "/xml-data/corpfiling/AttachLive/";
const MAX_PAGES = 200; // safety valve; a single day has never come close

export interface Announcement {
  news_id: string; scrip_cd: string | null; headline: string | null; category: string | null; subcategory: string | null;
  news_dt: string | null; pdf_name: string | null; pdf_url: string | null; body: string | null; fetched_at: string;
}

/** First of `names` whose value is not None/"", as stripped text. */
function pick(row: Record<string, unknown>, ...names: string[]): string | null {
  for (const n of names) {
    const v = row[n];
    if (v !== null && v !== undefined && v !== "") return pyStrip(pyStr(v));
  }
  return null;
}

/** One API row to an `announcement` record, or null when it has no news id. */
export function normalise(raw: unknown, fetchedAt: string = now()): Announcement | null {
  const row = asDict(raw);
  const newsId = pick(row, "NEWSID", "NewsId");
  if (!newsId) return null;
  const attach = pick(row, "ATTACHMENTNAME", "AttachmentName");
  return {
    news_id: newsId,
    scrip_cd: pick(row, "SCRIP_CD", "ScripCode"),
    headline: pick(row, "NEWSSUB", "HEADLINE", "News_submission_dt"),
    category: pick(row, "CATEGORYNAME", "Category"),
    subcategory: pick(row, "SUBCATNAME", "SubCategory"),
    news_dt: pick(row, "NEWS_DT", "DT_TM", "News_submission_dt"),
    pdf_name: attach,
    pdf_url: attach ? ATTACH_BASE + attach : null,
    body: pick(row, "MORE", "HEADLINE"),
    fetched_at: fetchedAt,
  };
}

const compact = (iso: string) => iso.replace(/-/g, "");

async function call(client: BSEClient, frm: string, to: string, scrip = "", page = 1): Promise<unknown> {
  const payload = await client.api(ENDPOINT, {
    pageno: page,
    strCat: "-1",
    strPrevDate: compact(frm),
    strScrip: scrip,
    strSearch: "P",
    strToDate: compact(to),
    strType: "C",
    subcategory: "-1",
  });
  if (!isDict(payload)) return [];
  return pyTruthy(payload.Table) ? payload.Table : [];
}

/** Add the fresh records of one page; returns how many were new. */
function absorb(batch: unknown, seen: Set<string>, out: Announcement[]): number {
  let fresh = 0;
  for (const raw of asList(batch)) {
    const rec = normalise(raw);
    if (rec && !seen.has(rec.news_id)) {
      seen.add(rec.news_id);
      out.push(rec);
      fresh++;
    }
  }
  return fresh;
}

/** All announcements filed on one calendar day, across every company. */
export async function fetchDay(client: BSEClient, day: string): Promise<Announcement[]> {
  const seen = new Set<string>();
  const out: Announcement[] = [];

  for (let page = 1; page <= MAX_PAGES; page++) {
    let batch: unknown;
    try {
      batch = await call(client, day, day, "", page);
    } catch (e) {
      log.warn(`announcements ${day} page ${page}: ${(e as Error).message}`);
      break;
    }
    if (!pyTruthy(batch)) break;
    if (absorb(batch, seen, out) === 0) break; // same page repeating -> pagination exhausted
  }
  return out;
}

/** Announcement history for one company over an arbitrary range. */
export async function fetchScrip(client: BSEClient, scripCd: string | number, start: string, end: string): Promise<Announcement[]> {
  const seen = new Set<string>();
  const out: Announcement[] = [];

  for (let page = 1; page <= MAX_PAGES; page++) {
    const batch = await call(client, start, end, pyStr(scripCd), page);
    if (!pyTruthy(batch)) break;
    if (absorb(batch, seen, out) === 0) break;
  }
  return out;
}

export interface AnnouncementSyncOptions { refetch?: boolean }

/** Walk the range day by day (ISO dates, inclusive). Returns rows written. */
export async function sync(client: BSEClient, db: Db, start: string, end: string, opts: AnnouncementSyncOptions = {}): Promise<number> {
  const done = new Set<string>();
  if (!opts.refetch) {
    for (const r of db.all<{ day: string }>("SELECT day FROM announcement_day WHERE status = 'ok'")) done.add(r.day);
  }

  let total = 0;
  const today = todayIso();
  for (let key = start; key <= end; key = addDays(key, 1)) {
    // Always re-pull today: more filings land through the day.
    if (done.has(key) && key !== today) continue;

    const rows = await fetchDay(client, key);
    const n = db.transaction(() => {
      const written = rows.length ? db.upsert("announcement", rows as unknown as Record<string, unknown>[]) : 0;
      db.upsert("announcement_day", [{ day: key, status: "ok", rows: written, fetched_at: now() }]);
      return written;
    });
    total += n;
    if (n) log.info(`announcements ${key} -> ${n} rows`);
  }
  return total;
}
