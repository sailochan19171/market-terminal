// Split and bonus adjustment for per-share history.
//
// Bhavcopy prices are raw: after a 5-for-1 split the price drops ~80% overnight. Ratios are parsed from
// corporate-action purposes ("Face Value Split (Sub-Division) - From Rs 5/- Per Share To Re 1/- Per Share",
// "Bonus 1:1") and each is validated against the actual ex-date price gap, so a misparsed ratio is dropped
// instead of corrupting history.
//
// A factor f means: per-share values dated before the ex-date are multiplied by f (prices, EPS) and
// volumes divided by f.
import type { Db } from "../db";

const SPLIT = /from\s+r[se]\.?\s*([\d.]+).*?to\s+r[se]\.?\s*([\d.]+)/i;
const BONUS = /bonus\D*?(\d+)\s*:\s*(\d+)/i;
export const TOLERANCE = 0.25;

export type Event = [exDate: string, factor: number];

export function parseFactor(purpose: string): number | null {
  const p = purpose ?? "";
  const low = p.toLowerCase();
  if (low.includes("split") || low.includes("sub-division") || low.includes("subdivision")) {
    const m = p.match(SPLIT);
    if (m) {
      const oldFv = parseFloat(m[1]), newFv = parseFloat(m[2]);
      if (oldFv > 0 && newFv > 0 && newFv < oldFv) return newFv / oldFv;
    }
  }
  if (low.includes("bonus")) {
    const m = p.match(BONUS);
    if (m) {
      const add = parseFloat(m[1]), held = parseFloat(m[2]);
      if (add > 0 && held > 0) return held / (add + held);
    }
  }
  return null;
}

function priceGap(db: Db, symbol: string, exDate: string): number | null {
  const before = db.get<{ close: number }>(
    "SELECT close FROM nse_bhavcopy WHERE symbol = ? AND series IN ('EQ','BE','BZ','SM','ST') AND trade_date < ? ORDER BY trade_date DESC LIMIT 1", [symbol, exDate]);
  const after = db.get<{ close: number }>(
    "SELECT close FROM nse_bhavcopy WHERE symbol = ? AND series IN ('EQ','BE','BZ','SM','ST') AND trade_date >= ? ORDER BY trade_date LIMIT 1", [symbol, exDate]);
  if (!before || !after || !before.close) return null;
  return after.close / before.close;
}

/** {symbol: [[ex_date, factor], ...]} sorted by date, validated against prices. */
export function loadEvents(db: Db, symbol?: string): Map<string, Event[]> {
  let sql = "SELECT symbol, purpose, ex_date FROM nse_corp_action WHERE ex_date != '' AND "
    + "(purpose LIKE '%split%' OR purpose LIKE '%sub-division%' OR purpose LIKE '%bonus%')";
  const args: string[] = [];
  if (symbol) {
    sql += " AND symbol = ?";
    args.push(symbol);
  }
  // A company can split and issue bonus shares on the same ex-date: combine a date's factors first.
  const byDate = new Map<string, Map<string, Map<string, number>>>();
  for (const r of db.all<{ symbol: string; purpose: string; ex_date: string }>(sql, args)) {
    const f = parseFactor(r.purpose);
    if (!f) continue;
    const dates = byDate.get(r.symbol) ?? new Map();
    byDate.set(r.symbol, dates);
    const parts = dates.get(r.ex_date) ?? new Map();
    dates.set(r.ex_date, parts);
    parts.set(r.purpose.trim().toLowerCase(), f); // de-duplicate repeat listings
  }
  const out = new Map<string, Event[]>();
  for (const [sym, dates] of byDate) {
    const events: Event[] = [];
    for (const [exDate, parts] of dates) {
      let f = 1;
      for (const v of parts.values()) f *= v;
      const gap = priceGap(db, sym, exDate);
      if (gap !== null && Math.abs(gap / f - 1) > TOLERANCE) continue;
      events.push([exDate, f]);
    }
    events.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    if (events.length) out.set(sym, events);
  }
  return out;
}

/** Cumulative adjustment factor for any date, for one symbol. */
export class Adjuster {
  private dates: string[];
  private suffix: number[];

  constructor(events: Event[]) {
    this.dates = events.map((e) => e[0]);
    this.suffix = new Array(events.length + 1).fill(1);
    for (let i = events.length - 1; i >= 0; i--) this.suffix[i] = this.suffix[i + 1] * events[i][1];
  }

  /** Multiplier for a value dated `day`: product of events with ex_date > day. */
  factor(day: string): number {
    if (!this.dates.length) return 1;
    const d = String(day).slice(0, 10);
    // bisect_right: first index whose date is > d
    let lo = 0, hi = this.dates.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.dates[mid] <= d) lo = mid + 1;
      else hi = mid;
    }
    return this.suffix[lo];
  }

  get active(): boolean {
    return this.dates.length > 0;
  }
}
