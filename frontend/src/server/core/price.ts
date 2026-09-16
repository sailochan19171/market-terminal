// The one place a share price comes from.
//
// Every surface - company page, research, live pulse, heatmap, screens, cards - reads a quote through this
// module so two of them can never show different prices for the same symbol at the same moment. A quote always
// says when it was taken (`asOfTimestamp`, IST) and where it came from (`source`, `isLive`): the exchange's
// end-of-day bhavcopy by default, upgraded to the session's last traded price only while the market is open
// and only on this PC, which holds a warmed NSE session. The hosted site is end-of-day by design - real-time
// display on a public website needs an NSE licence we do not hold.
import type { Db } from "../db";
import type { Exchange, Identity } from "./analysis";
import { latestSession, pickExchange, resolve } from "./analysis";
import { normDateTime, toNum } from "../util";

export type PriceSource = "eod" | "live" | "snapshot";

export interface PriceQuote {
  symbol: string;               // NSE symbol, or the BSE scrip code when the company is BSE-only
  exchange: Exchange;
  lastPrice: number | null;
  previousClose: number | null;
  changeAbs: number | null;
  changePct: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  volume: number | null;
  /** IST timestamp the price is good for ("2026-09-15T15:30:00+05:30"). */
  asOfTimestamp: string | null;
  /** Trading session the price belongs to ("2026-09-15"). */
  session: string | null;
  /** Human label for the origin: "NSE end-of-day bhavcopy" / "NSE live quote". */
  source: string;
  kind: PriceSource;
  isLive: boolean;
  /** The last close is older than the exchange's most recent session (a suspended or thinly traded scrip). */
  stale: boolean;
  currency: "INR";
}

const EQUITY_SERIES = ["EQ", "BE", "BZ", "SM", "ST"];
const r2 = (v: number | null) => (v === null || !Number.isFinite(v) ? null : Math.round(v * 100) / 100);

/** An exchange timestamp with the IST offset attached, which is what every exchange field is in. */
export const istStamp = (v: unknown): string | null => {
  const s = normDateTime(v);
  return s ? `${s}+05:30` : null;
};

/** Now, as wall-clock parts in IST, wherever the server happens to run. */
export function istNow(at = new Date()) {
  const p = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).formatToParts(at).reduce<Record<string, string>>((o, x) => ((o[x.type] = x.value), o), {});
  const date = `${p.year}-${p.month}-${p.day}`;
  const time = `${p.hour === "24" ? "00" : p.hour}:${p.minute}:${p.second}`;
  return { date, time, iso: `${date}T${time}+05:30`, minutes: Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5)), weekday: new Date(`${date}T12:00:00Z`).getUTCDay() };
}

/** Roughly within NSE equity trading hours (09:00 pre-open to 15:40 IST, Monday to Friday). Exchange holidays
 *  are not in this check: on a holiday the live feed simply repeats the previous close, which is harmless. */
export function marketHours(at = new Date()): boolean {
  const { minutes, weekday } = istNow(at);
  return weekday >= 1 && weekday <= 5 && minutes >= 9 * 60 && minutes <= 15 * 60 + 40;
}

interface Bar { t: string; o: number | null; h: number | null; l: number | null; c: number | null; v: number | null; pc: number | null }

function lastBars(db: Db, identity: Identity, exchange: Exchange, asOf?: string | null): Bar[] {
  const cutoff = asOf ? " AND trade_date <= ?" : "";
  if (exchange === "NSE") {
    if (!identity.symbol) return [];
    const series = identity.series;
    const filter = !series || EQUITY_SERIES.includes(series) ? "series IN ('EQ','BE','BZ','SM','ST')" : "series = ?";
    const args: (string | number)[] = [identity.symbol];
    if (filter.startsWith("series =")) args.push(series!);
    if (asOf) args.push(asOf);
    return db.all<Bar>(
      `SELECT trade_date t, open o, high h, low l, close c, volume v, prev_close pc FROM nse_bhavcopy
       WHERE symbol = ? AND ${filter} AND close IS NOT NULL${cutoff} ORDER BY trade_date DESC LIMIT 2`, args);
  }
  if (!identity.bseCode) return [];
  return db.all<Bar>(
    `SELECT trade_date t, open o, high h, low l, close c, volume v, prev_close pc FROM bhavcopy
     WHERE scrip_cd = ? AND close IS NOT NULL${cutoff} ORDER BY trade_date DESC LIMIT 2`,
    asOf ? [identity.bseCode, asOf] : [identity.bseCode]);
}

/** The end-of-day quote: always available, never guessed. `asOf` pins it to a past session for historical views. */
export function eodQuote(db: Db, identity: Identity, exchange: Exchange, asOf?: string | null): PriceQuote {
  const bars = lastBars(db, identity, exchange, asOf);
  const key = (exchange === "NSE" ? identity.symbol : identity.bseCode) ?? identity.key;
  const empty: PriceQuote = {
    symbol: key, exchange, lastPrice: null, previousClose: null, changeAbs: null, changePct: null,
    open: null, high: null, low: null, volume: null, asOfTimestamp: null, session: null,
    source: `${exchange} end-of-day bhavcopy`, kind: "eod", isLive: false, stale: false, currency: "INR",
  };
  if (!bars.length) return empty;
  const last = bars[0];
  const prev = bars.length > 1 ? bars[1].c : last.pc;
  const change = last.c !== null && prev ? last.c - prev : null;
  const newest = latestSession(db, exchange);
  return {
    ...empty,
    lastPrice: r2(last.c), previousClose: r2(prev), changeAbs: r2(change),
    changePct: r2(change !== null && prev ? (change / prev) * 100 : null),
    open: r2(last.o), high: r2(last.h), low: r2(last.l), volume: last.v,
    asOfTimestamp: `${last.t}T15:30:00+05:30`, session: last.t,
    source: `${exchange} end-of-day bhavcopy for ${last.t}`,
    stale: Boolean(!asOf && newest && last.t < newest),
  };
}

/** The end-of-day quote for an NSE symbol, BSE code, ticker or ISIN. Null when the identifier is unknown.
 *  This is what every module that only knows a symbol should call, so a page, an answer and a valuation all
 *  quote the same session. */
export function quoteFor(db: Db, ident: string, prefer?: Exchange | null): PriceQuote | null {
  let identity: Identity;
  try {
    identity = resolve(db, ident);
  } catch {
    return null;
  }
  return eodQuote(db, identity, pickExchange(identity, prefer ?? ""));
}

// --- live upgrade (this PC only) --------------------------------------------------------

const LIVE_TTL_MS = 30_000;
const live = new Map<string, { at: number; quote: PriceQuote | null }>();
let client: { api<T>(path: string, params?: Record<string, string | number>): Promise<T | null> } | null = null;

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" ? (v as Obj) : {});

/** NSE's quote-equity payload for one symbol, as a quote. Null when the feed gives nothing usable. */
export function fromNseQuote(symbol: string, payload: unknown): PriceQuote | null {
  const p = obj(payload);
  const info = obj(p.priceInfo);
  const meta = obj(p.metadata);
  const lastPrice = toNum(info.lastPrice);
  if (lastPrice === null || lastPrice <= 0) return null;
  const prev = toNum(info.previousClose);
  const range = obj(info.intraDayHighLow);
  const stamp = istStamp(meta.lastUpdateTime ?? p.lastUpdateTime);
  return {
    symbol, exchange: "NSE", lastPrice: r2(lastPrice), previousClose: r2(prev),
    changeAbs: r2(toNum(info.change) ?? (prev ? lastPrice - prev : null)),
    changePct: r2(toNum(info.pChange) ?? (prev ? ((lastPrice - prev) / prev) * 100 : null)),
    open: r2(toNum(info.open)), high: r2(toNum(range.max)), low: r2(toNum(range.min)),
    volume: toNum(obj(p.securityWiseDP).quantityTraded),
    asOfTimestamp: stamp, session: (stamp ?? "").slice(0, 10) || null,
    source: "NSE live quote", kind: "live", isLive: true, stale: false, currency: "INR",
  };
}

async function fetchLive(symbol: string): Promise<PriceQuote | null> {
  const hit = live.get(symbol);
  if (hit && Date.now() - hit.at < LIVE_TTL_MS) return hit.quote;
  try {
    if (!client) {
      const { NSEClient } = await import("../nse/client");
      client = new NSEClient({ rps: 2, maxRetries: 1, timeoutS: 12 });
    }
    const quote = fromNseQuote(symbol, await client.api("quote-equity", { symbol }));
    live.set(symbol, { at: Date.now(), quote });
    return quote;
  } catch {
    live.set(symbol, { at: Date.now(), quote: null }); // a failed feed never blocks the page; end-of-day stands
    return null;
  }
}

export interface QuoteOptions {
  /** Try the live feed (default: only while the market is open, and never on the hosted site). */
  live?: boolean;
  /** Pin the quote to a past session, for historical views: the live feed is skipped. */
  asOf?: string | null;
}

/** The authoritative quote for a company. Await it: the live upgrade is a network call, the fallback is not. */
export async function quote(db: Db, identity: Identity, exchange: Exchange, opts: QuoteOptions = {}): Promise<PriceQuote> {
  const eod = eodQuote(db, identity, exchange, opts.asOf);
  const wantLive = opts.live ?? (!db.isRemote && marketHours());
  if (!wantLive || opts.asOf || exchange !== "NSE" || !identity.symbol) return eod;
  const now = await fetchLive(identity.symbol);
  if (!now || now.lastPrice === null) return eod;
  // Keep the day's opening and volume from whichever source has them.
  return { ...now, open: now.open ?? eod.open, previousClose: now.previousClose ?? eod.previousClose, volume: now.volume ?? null };
}

/** One line a page can print under any price: "as of 15:30 IST, 15 Sep 2026 · end of day". */
export function asOfLabel(q: PriceQuote): string {
  if (!q.asOfTimestamp) return "No price on record";
  const d = new Date(q.asOfTimestamp);
  const date = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "numeric" }).format(d);
  const time = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hour12: false }).format(d);
  return `as of ${time} IST, ${date} · ${q.isLive ? "live" : "end of day"}`;
}
