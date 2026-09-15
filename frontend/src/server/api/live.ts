// Live market pulse for the home page: NSE market status, key indices during the session and live movers.
//
// Every visitor shares one NSE session and one 30-second snapshot, so the exchange sees at most a handful of
// requests a minute however many pages are open. A feed that fails leaves its part empty, never the whole pulse.
import { NSEClient } from "../nse/client";
import { fetch as liveFetch } from "../nse/live";
import { logger } from "../log";
import { toNum } from "../util";

const log = logger("live");

const TTL_MS = 30_000;
const ROWS = 8;
export const KEY_INDICES = ["NIFTY 50", "NIFTY BANK", "NIFTY NEXT 50", "NIFTY MIDCAP 100", "NIFTY IT", "INDIA VIX"];

type Obj = Record<string, unknown>;

export interface LiveIndex {
  name: string; last: number | null; change: number | null; pct: number | null; open: number | null; high: number | null; low: number | null;
  prevClose: number | null; yearHigh: number | null; yearLow: number | null; advances: number | null; declines: number | null; unchanged: number | null;
}
export interface LiveMover {
  symbol: string; name: string | null; ltp: number | null; pct: number | null; change: number | null; volume: number | null;
  turnoverCr: number | null; extra: number | null;
}
export interface LivePulse {
  status: { open: boolean; label: string; message: string; tradeDate: string | null };
  asOf: string | null;
  fetchedAt: string;
  indices: LiveIndex[];
  movers: { gainers: LiveMover[]; losers: LiveMover[]; volume: LiveMover[]; highs: LiveMover[]; lows: LiveMover[] };
  counts: { highs: number | null; lows: number | null };
  errors: string[];
}

const MONTHS: Record<string, string> = { JAN: "01", FEB: "02", MAR: "03", APR: "04", MAY: "05", JUN: "06", JUL: "07", AUG: "08", SEP: "09", OCT: "10", NOV: "11", DEC: "12" };

/** "11-Sep-2026 15:30" / "11-Sep-2026 15:30:00" / "11-Sep-2026" (IST) -> ISO with the +05:30 offset. */
export function nseTime(v: unknown): string | null {
  const m = String(v ?? "").trim().match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (!m || !MONTHS[m[2].toUpperCase()]) return null;
  const time = m[4] ? `${m[4].padStart(2, "0")}:${m[5]}:${m[6] ?? "00"}` : "00:00:00";
  return `${m[3]}-${MONTHS[m[2].toUpperCase()]}-${m[1].padStart(2, "0")}T${time}+05:30`;
}

const str = (v: unknown) => (v === null || v === undefined || v === "" ? null : String(v));
const rows = (v: unknown): Obj[] => (Array.isArray(v) ? (v.filter((r) => r && typeof r === "object") as Obj[]) : []);

function uniqueBySymbol(list: Obj[]): Obj[] {
  const seen = new Set<string>();
  return list.filter((r) => {
    const s = String(r.symbol ?? "");
    if (!s || seen.has(s)) return false;
    seen.add(s);
    return true;
  });
}

const variation = (r: Obj): LiveMover => {
  const ltp = toNum(r.ltp), prev = toNum(r.prev_price);
  return {
    symbol: String(r.symbol), name: null, ltp, pct: toNum(r.perChange ?? r.net_price),
    change: ltp !== null && prev !== null ? Math.round((ltp - prev) * 100) / 100 : null,
    volume: toNum(r.trade_quantity), turnoverCr: toNum(r.turnover) === null ? null : toNum(r.turnover)! / 100, extra: null,
  };
};

let client: NSEClient | null = null;
let snapshot: { at: number; value: LivePulse } | null = null;
let inflight: Promise<LivePulse> | null = null;

async function build(): Promise<LivePulse> {
  client ??= new NSEClient({ rps: 2, maxRetries: 1, timeoutS: 20 });
  const errors: string[] = [];
  const part = async <T>(name: string, fn: () => Promise<T>): Promise<T | null> => {
    try {
      return await fn();
    } catch (e) {
      log.warn(`live ${name}: ${(e as Error).message}`);
      errors.push(`${name}: ${(e as Error).message}`);
      return null;
    }
  };

  const status = await part("market status", () => client!.api<Obj>("marketStatus"));
  const all = await part("indices", () => client!.api<Obj>("allIndices"));
  const [gainers, losers, volume, highs, lows] = [
    await part("gainers", () => liveFetch(client!, "gainers")),
    await part("losers", () => liveFetch(client!, "losers")),
    await part("volume spurts", () => liveFetch(client!, "volume-gainers")),
    await part("52-week highs", () => liveFetch(client!, "52w-high")),
    await part("52-week lows", () => liveFetch(client!, "52w-low")),
  ];

  const cm = rows(status?.marketState).find((m) => m.market === "Capital Market");
  const open = /^open$/i.test(String(cm?.marketStatus ?? ""));
  const byName = new Map(rows(all?.data).map((r) => [String(r.index), r]));
  const indices = KEY_INDICES.flatMap((name): LiveIndex[] => {
    const r = byName.get(name);
    if (!r) return [];
    return [{
      name, last: toNum(r.last), change: toNum(r.variation), pct: toNum(r.percentChange), open: toNum(r.open), high: toNum(r.high), low: toNum(r.low),
      prevClose: toNum(r.previousClose), yearHigh: toNum(r.yearHigh), yearLow: toNum(r.yearLow),
      advances: toNum(r.advances), declines: toNum(r.declines), unchanged: toNum(r.unchanged),
    }];
  });
  const extremes = (v: typeof highs) => uniqueBySymbol(rows(v?.rows));
  const extreme = (r: Obj): LiveMover => ({
    symbol: String(r.symbol), name: str(r.comapnyName ?? r.companyName), ltp: toNum(r.ltp), pct: toNum(r.pChange), change: toNum(r.change),
    volume: null, turnoverCr: null, extra: toNum(r.new52WHL),
  });

  return {
    status: {
      open,
      label: open ? "Market open" : "Market closed",
      message: str(cm?.marketStatusMessage) ?? (status ? "" : "Market status unavailable"),
      tradeDate: nseTime(cm?.tradeDate),
    },
    asOf: nseTime(all?.timestamp) ?? nseTime(cm?.tradeDate),
    fetchedAt: new Date().toISOString(),
    indices,
    movers: {
      gainers: rows(gainers?.rows).slice(0, ROWS).map(variation),
      losers: rows(losers?.rows).slice(0, ROWS).map(variation),
      volume: rows(volume?.rows).slice(0, ROWS).map((r) => ({
        symbol: String(r.symbol), name: str(r.companyName), ltp: toNum(r.ltp), pct: toNum(r.pChange), change: null,
        volume: toNum(r.volume), turnoverCr: toNum(r.turnover) === null ? null : toNum(r.turnover)! / 100, extra: toNum(r.week1volChange),
      })),
      highs: extremes(highs).slice(0, ROWS).map(extreme),
      lows: extremes(lows).slice(0, ROWS).map(extreme),
    },
    counts: { highs: highs ? extremes(highs).length : null, lows: lows ? extremes(lows).length : null },
    errors,
  };
}

/** The shared snapshot. Only the very first call waits for NSE: after that an expired snapshot is returned at once
 *  while a single background fetch replaces it, so page refreshes stay instant. */
export async function pulse(): Promise<LivePulse> {
  const fresh = snapshot && Date.now() - snapshot.at < TTL_MS;
  if (!fresh && !inflight) {
    inflight = build()
      .then((value) => {
        snapshot = { at: Date.now(), value };
        return value;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return snapshot ? snapshot.value : inflight!;
}
