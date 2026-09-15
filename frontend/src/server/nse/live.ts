// Live NSE market-data modules.
//
// NSE's site is organised into ~56 market-data pages. These are live snapshots rather than history, so they
// are fetched on demand and cached briefly instead of being stored: what the exchange shows now is the whole
// point of them. Each module declares how to pull its rows out of the response and which columns to show,
// so the web UI can render any of them generically. Serves /api/live and /api/live/<key>.
import { logger } from "../log";
import type { NSEClient } from "./client";
import { pyOr, pyTruthy } from "./py";

const log = logger("nse.live");

export const CACHE_TTL = 60; // seconds; these are live feeds, but do not hammer them

type Obj = Record<string, unknown>;
type Extract = (payload: unknown) => unknown;
export type LiveClient = Pick<NSEClient, "api">;

const isDict = (v: unknown): v is Obj => v !== null && typeof v === "object" && !Array.isArray(v);

/** Python `v.get(key)`: AttributeError unless v is a dict. */
function dget(v: unknown, key: string): unknown {
  if (!isDict(v)) throw new TypeError(`'${Array.isArray(v) ? "list" : typeof v}' object has no attribute 'get'`);
  const got = v[key];
  return got === undefined ? null : got;
}

/** `v or {}` */
const orDict = (v: unknown): unknown => (pyTruthy(v) ? v : {});

export function rowsOf(payload: unknown, key = "data"): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (isDict(payload)) {
    const got = payload[key];
    if (Array.isArray(got)) return got;
  }
  return [];
}

/** Pre-open rows nest the useful fields under `metadata`. */
export function preopen(payload: unknown): Obj[] {
  const out: Obj[] = [];
  for (const r of rowsOf(payload)) {
    const meta = orDict(dget(r, "metadata"));
    out.push({
      symbol: pyOr(dget(meta, "symbol"), dget(r, "symbol")),
      lastPrice: dget(meta, "lastPrice"),
      change: dget(meta, "change"),
      pChange: dget(meta, "pChange"),
      previousClose: dget(meta, "previousClose"),
      finalQuantity: dget(meta, "finalQuantity"),
      totalTurnover: dget(meta, "totalTurnover"),
    });
  }
  return out;
}

/** Upper/lower circuit hitters sit under band -> AllSec -> data. */
export function bandHitters(which: string): Extract {
  return (payload) => {
    const band = orDict(dget(orDict(payload), which));
    const allsec = orDict(dget(band, "AllSec"));
    return pyOr(dget(allsec, "data"), []);
  };
}

/** Gainers / losers: payload["NIFTY"]["data"], else the plain row list. */
const variations: Extract = (p) => pyOr(dget(orDict(dget(p, "NIFTY")), "data"), rowsOf(p));

export interface Module { key: string; title: string; path: string; extract: Extract; columns: string[]; note: string }

const mod = (key: string, title: string, path: string, extract: Extract | null, columns: string[] | null, note = ""): Module =>
  ({ key, title, path, extract: extract ?? ((p) => rowsOf(p)), columns: columns ?? [], note });

export const MODULES: Module[] = [
  mod("pre-open", "Pre-open market", "market-data-pre-open?key=ALL", preopen,
    ["symbol", "lastPrice", "change", "pChange", "previousClose", "finalQuantity", "totalTurnover"],
    "Order matching before the session opens."),
  mod("gainers", "Top gainers", "live-analysis-variations?index=gainers", variations,
    ["symbol", "ltp", "net_price", "trade_quantity", "perChange", "prev_price"]),
  mod("losers", "Top losers", "live-analysis-variations?index=loosers", variations,
    ["symbol", "ltp", "net_price", "trade_quantity", "perChange", "prev_price"]),
  mod("volume-gainers", "Volume gainers / spurts", "live-analysis-volume-gainers", (p) => rowsOf(p),
    ["symbol", "companyName", "volume", "week1AvgVolume", "week1Change", "ltp", "pChange"]),
  mod("52w-high", "52-week highs", "live-analysis-data-52weekhighstock", (p) => rowsOf(p),
    ["symbol", "comapnyName", "new52WHL", "prev52WHL", "ltp", "change", "pChange"]),
  mod("52w-low", "52-week lows", "live-analysis-data-52weeklowstock", (p) => rowsOf(p),
    ["symbol", "comapnyName", "new52WHL", "prev52WHL", "ltp", "change", "pChange"]),
  mod("upper-band", "Upper circuit hitters", "live-analysis-price-band-hitter", bandHitters("upper"),
    ["symbol", "series", "ltp", "change", "pChange", "bandLimit"]),
  mod("lower-band", "Lower circuit hitters", "live-analysis-price-band-hitter", bandHitters("lower"),
    ["symbol", "series", "ltp", "change", "pChange", "bandLimit"]),
  mod("block-deals", "Block deals", "block-deal", (p) => rowsOf(p),
    ["symbol", "session", "clientName", "buySell", "qty", "price"]),
  mod("etf", "Exchange traded funds", "etf", (p) => rowsOf(p),
    ["symbol", "assets", "ltP", "chn", "per", "qty", "trdVal", "nav"]),
  mod("sme", "SME / Emerge market", "live-analysis-emerge", (p) => rowsOf(p),
    ["symbol", "series", "open", "dayHigh", "dayLow", "lastPrice", "pChange", "totalTradedVolume"]),
  mod("sgb", "Sovereign gold bonds", "sovereign-gold-bonds", (p) => rowsOf(p),
    ["symbol", "open", "dayHigh", "dayLow", "lastPrice", "pChange", "totalTradedVolume"]),
  mod("oi-spurts", "Open interest spurts", "live-analysis-oi-spurts-underlyings", (p) => rowsOf(p),
    ["symbol", "latestOI", "prevOI", "changeInOI", "avgInOI", "volume", "valueInCrores"]),
];

export const BY_KEY: Record<string, Module> = Object.fromEntries(MODULES.map((m) => [m.key, m]));

/** Unknown module key (the route answers 404, as Flask did for KeyError). */
export class UnknownModule extends Error {
  constructor(key: string) {
    super(`unknown module '${key}'`);
  }
}

export interface LiveValue {
  key: string; title: string; note: string; columns: string[]; rows: unknown; count: number; timestamp: unknown;
}

const cache = new Map<string, { at: number; value: LiveValue }>();

/** Python len() of whatever the extractor returned. */
function pyLen(v: unknown): number {
  if (Array.isArray(v) || typeof v === "string") return v.length;
  if (isDict(v)) return Object.keys(v).length;
  return 0;
}

/** Return {key, title, note, columns, rows, count, timestamp} for one module. */
export async function fetch(client: LiveClient, key: string, force = false): Promise<LiveValue> {
  const m = Object.prototype.hasOwnProperty.call(BY_KEY, key) ? BY_KEY[key] : undefined;
  if (!m) throw new UnknownModule(key);

  const at = performance.now() / 1000;
  const hit = cache.get(key);
  if (hit && !force && at - hit.at < CACHE_TTL) return hit.value;

  const payload = await client.api(m.path);
  let rows: unknown;
  try {
    const got = m.extract(payload);
    rows = pyTruthy(got) ? got : [];
  } catch (e) {
    log.warn(`live module ${key}: extract failed: ${e instanceof Error ? e.message : e}`);
    rows = [];
  }

  let stamp: unknown = "";
  if (isDict(payload)) stamp = pyOr(payload.timestamp ?? null, payload.time ?? null, "");

  const first = Array.isArray(rows) && rows.length ? rows[0] : null;
  const value: LiveValue = {
    key,
    title: m.title,
    note: m.note,
    columns: m.columns.length ? m.columns : isDict(first) ? Object.keys(first).sort() : [],
    rows,
    count: pyLen(rows),
    timestamp: stamp,
  };
  cache.set(key, { at, value });
  return value;
}

export function catalogue(): Array<{ key: string; title: string; note: string }> {
  return MODULES.map((m) => ({ key: m.key, title: m.title, note: m.note }));
}

/** Drop cached snapshots (tests). */
export const clearCache = () => cache.clear();
