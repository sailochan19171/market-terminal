// Shared helpers: dates, numbers and small collection utilities.

/** YYYY-MM-DD of a Date in UTC. */
export const isoDate = (d: Date) => d.toISOString().slice(0, 10);

/** Parse "YYYY-MM-DD" (or longer ISO) to a UTC Date, or null. */
export function parseIso(s: unknown): Date | null {
  const m = String(s ?? "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return Number.isNaN(d.getTime()) || d.getUTCDate() !== +m[3] ? null : d;
}

export function addDays(iso: string, days: number): string {
  const d = parseIso(iso)!;
  d.setUTCDate(d.getUTCDate() + days);
  return isoDate(d);
}

export const daysBetween = (a: string, b: string) => Math.round((parseIso(b)!.getTime() - parseIso(a)!.getTime()) / 86_400_000);

export const todayIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/** Local wall-clock ISO timestamp without zone ("2026-09-14T10:15:02"), like Python's datetime.now().isoformat(). */
export const localIsoNow = () => {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};

const MON = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/**
 * Exchange timestamps to ISO: "13-Sep-2026 22:55:21", "13-SEP-2026", "13-09-2026", "2026-09-13T..".
 * Returns "YYYY-MM-DDTHH:MM:SS" (seconds precision) or null.
 */
export function normDateTime(v: unknown): string | null {
  const s = String(v ?? "").trim();
  if (!s || s === "-") return null;
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}T${m[4] ?? "00"}:${m[5] ?? "00"}:${m[6] ?? "00"}`;
  m = s.match(/^(\d{1,2})[- ]([A-Za-z]{3,9})[- ](\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (m) {
    const mon = MON.indexOf(m[2].slice(0, 3).toLowerCase());
    if (mon < 0) return null;
    return `${m[3]}-${String(mon + 1).padStart(2, "0")}-${m[1].padStart(2, "0")}T${(m[4] ?? "00").padStart(2, "0")}:${m[5] ?? "00"}:${m[6] ?? "00"}`;
  }
  m = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}T00:00:00`;
  return null;
}

/** Python-style _norm_dt: ISO when parseable, else the original text (as the Python pipeline stored it). */
export const normDt = (v: unknown): string | null => {
  const s = String(v ?? "").trim();
  if (!s || s === "-") return null;
  return normDateTime(s) ?? s;
};

export const normDate = (v: unknown): string => (normDateTime(v) ?? "").slice(0, 10);

/** Number from exchange text ("1,234.50", "-", ""), or null. */
export function toNum(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const s = String(v ?? "").replace(/,/g, "").trim();
  if (!s || s === "-" || s.toUpperCase() === "NA") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

export const toInt = (v: unknown): number | null => {
  const n = toNum(v);
  return n === null ? null : Math.trunc(n);
};

/** (new - old) / |old| * 100 */
export const pctChange = (n: number | null | undefined, o: number | null | undefined): number | null =>
  n == null || o == null || o === 0 ? null : ((n - o) / Math.abs(o)) * 100;

export const cagr = (n: number | null | undefined, o: number | null | undefined, years: number): number | null =>
  !n || !o || n <= 0 || o <= 0 ? null : ((n / o) ** (1 / years) - 1) * 100;

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function median(values: unknown[]): number | null {
  const v = values.filter((x): x is number => typeof x === "number" && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

export const placeholders = (n: number) => (n ? Array(n).fill("?").join(",") : "NULL");

/** Python %-format for "%.Nf" (round half to even is not reproduced; values are display text). */
export const fixed = (v: number, digits: number) => v.toFixed(digits);

/** Group thousands the way Python's format(n, ",d") / ",.2f" does. */
export const grouped = (v: number, digits = 0) =>
  v.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });

export function chunk<T>(list: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/** Run async `fn` over items with at most `limit` in flight, preserving order of results. */
export async function mapPool<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}
