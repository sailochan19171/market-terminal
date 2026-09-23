// The technical agent (spec §3.6): price trends from adjusted daily closes. Plain code; the trend label comes
// from fixed rules, never from a model.
import type { RawData, TechnicalReport, Unavailable } from "./state";

const mean = (xs: number[]) => xs.reduce((s, v) => s + v, 0) / xs.length;

/** Simple moving average of the last `n` closes, or null when there are fewer than `n`. */
export function sma(closes: number[], n: number): number | null {
  return closes.length >= n ? mean(closes.slice(-n)) : null;
}

/** Wilder's RSI over `n` periods. */
export function rsi(closes: number[], n = 14): number | null {
  if (closes.length < n + 1) return null;
  let gain = 0, loss = 0;
  for (let i = 1; i <= n; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d; else loss -= d;
  }
  let avgGain = gain / n, avgLoss = loss / n;
  for (let i = n + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (n - 1) + Math.max(d, 0)) / n;
    avgLoss = (avgLoss * (n - 1) + Math.max(-d, 0)) / n;
  }
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

/** Annualised volatility of daily log returns over the last year. */
export function volatility(closes: number[], days = 252): number | null {
  const window = closes.slice(-(days + 1));
  if (window.length < 60) return null;
  const r: number[] = [];
  for (let i = 1; i < window.length; i++) if (window[i - 1] > 0 && window[i] > 0) r.push(Math.log(window[i] / window[i - 1]));
  const m = mean(r);
  return Math.sqrt(r.reduce((s, v) => s + (v - m) ** 2, 0) / (r.length - 1)) * Math.sqrt(252);
}

/**
 * The trend label, from fixed rules:
 *   uptrend   - price above both averages and the 50-day above the 200-day
 *   downtrend - price below both averages and the 50-day below the 200-day
 *   sideways  - anything in between
 */
/**
 * The trend in one word. The two averages decide the direction and the price confirms it; "sideways" is only
 * for averages within 2% of each other. Requiring all three of price > 50-day > 200-day called a company whose
 * 50-day sat 16% below its 200-day "sideways" merely because the price had bounced above the 50-day, while
 * another at 11% below was called a downtrend - the same picture with two different labels.
 */
export function trendLabel(price: number | null, ma50: number | null, ma200: number | null): TechnicalReport["trendLabel"] {
  if (price === null || ma50 === null || ma200 === null || ma200 === 0) return null;
  const gap = (ma50 - ma200) / Math.abs(ma200);
  if (Math.abs(gap) < 0.02) return "sideways";          // the averages are together: no direction to call
  if (gap > 0) return price > ma200 ? "uptrend" : "sideways";
  return price < ma200 ? "downtrend" : "sideways";
}

export function technicalReport(raw: RawData): TechnicalReport {
  const unavailable: Unavailable[] = [];
  const bars = raw.prices;
  const closes = bars.map((b) => b.c).filter((c) => c > 0);
  const last = bars.at(-1);
  const price = closes.at(-1) ?? null;
  const asOf = last?.t ?? null;

  /** The close on or before a date `years` back, so a holiday does not break the lookup. */
  const returnOver = (years: number): number | null => {
    if (!last || price === null) return null;
    const target = new Date(`${last.t}T00:00:00Z`);
    target.setUTCFullYear(target.getUTCFullYear() - years);
    const iso = target.toISOString().slice(0, 10);
    if (bars[0].t > iso) {
      unavailable.push({ key: `return_${years}y`, reason: `price history starts ${bars[0].t}, less than ${years} year${years > 1 ? "s" : ""}` });
      return null;
    }
    let then: number | null = null;
    for (const b of bars) {
      if (b.t > iso) break;
      then = b.c;
    }
    return then && then > 0 ? price / then - 1 : null;
  };

  const ma50 = sma(closes, 50);
  const ma200 = sma(closes, 200);
  if (ma200 === null) unavailable.push({ key: "ma_200", reason: `${closes.length} trading days on record, fewer than 200` });
  const yearAgo = last ? new Date(new Date(`${last.t}T00:00:00Z`).getTime() - 365 * 86_400_000).toISOString().slice(0, 10) : "";
  const lastYear = bars.filter((b) => b.t > yearAgo).map((b) => b.c);
  if (!closes.length) unavailable.push({ key: "prices", reason: "no daily closes on record" });

  return {
    symbol: raw.symbol,
    ma50, ma200,
    priceVsMa50: price !== null && ma50 ? price / ma50 - 1 : null,
    priceVsMa200: price !== null && ma200 ? price / ma200 - 1 : null,
    high52w: lastYear.length ? Math.max(...lastYear) : null,
    low52w: lastYear.length ? Math.min(...lastYear) : null,
    returns: { "1y": returnOver(1), "3y": returnOver(3), "5y": returnOver(5) },
    volatility: volatility(closes),
    rsi14: rsi(closes.slice(-300)),
    trendLabel: trendLabel(price, ma50, ma200),
    asOf,
    unavailable,
  };
}
