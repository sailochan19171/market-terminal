// Number and date formatting, Indian conventions (lakh / crore grouping).

export type Num = number | null | undefined;

export const isNum = (v: Num): v is number => typeof v === "number" && Number.isFinite(v);

/** Shown wherever a value is genuinely unavailable. */
export const NA = "Not available";

export function num(v: Num, digits = 2): string {
  if (!isNum(v)) return "—";
  // Values that round to zero print as 0, never "-0".
  const n = Math.abs(v) < 0.5 * 10 ** -digits ? 0 : v;
  return n.toLocaleString("en-IN", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function int(v: Num): string {
  if (!isNum(v)) return "—";
  return Math.round(v).toLocaleString("en-IN");
}

export function pct(v: Num, digits = 2): string {
  if (!isNum(v)) return "—";
  return `${v > 0 ? "+" : ""}${v.toFixed(digits)}%`;
}

/** A share or ratio that is not a change: no plus sign. */
export function percent(v: Num, digits = 1): string {
  if (!isNum(v)) return "—";
  return `${v.toFixed(digits)}%`;
}

export function signed(v: Num, digits = 2): string {
  if (!isNum(v)) return "—";
  return `${v > 0 ? "+" : ""}${num(v, digits)}`;
}

/** Rupee price or per-share amount: ₹1,250.50 */
export function inr(v: Num, digits = 2): string {
  if (!isNum(v)) return "—";
  return `${v < 0 ? "−" : ""}₹${Math.abs(v).toLocaleString("en-IN", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

/**
 * Amount already in crore, scaled for reading:
 * 0.42 → ₹42 L · 1.25 → ₹1.25 Cr · 125 → ₹125 Cr · 1,250 → ₹1,250 Cr · 1,25,000 → ₹1.25 Lakh Cr
 */
export function inrCrore(v: Num): string {
  if (!isNum(v)) return "—";
  if (v === 0) return "₹0 Cr";
  const sign = v < 0 ? "−" : "";
  const a = Math.abs(v);
  if (a >= 1e5) return `${sign}₹${(a / 1e5).toLocaleString("en-IN", { maximumFractionDigits: 2 })} Lakh Cr`;
  if (a >= 100) return `${sign}₹${Math.round(a).toLocaleString("en-IN")} Cr`;
  if (a >= 1) return `${sign}₹${a.toLocaleString("en-IN", { maximumFractionDigits: 2 })} Cr`;
  return `${sign}₹${(a * 100).toLocaleString("en-IN", { maximumFractionDigits: 2 })} L`;
}

/** Plain count (shares, holders) in Indian units: 1,540.13 Cr · 45.3 L · 12,500 */
export function countIN(v: Num): string {
  if (!isNum(v)) return "—";
  const a = Math.abs(v);
  if (a >= 1e7) return `${(v / 1e7).toLocaleString("en-IN", { maximumFractionDigits: 2 })} Cr`;
  if (a >= 1e5) return `${(v / 1e5).toLocaleString("en-IN", { maximumFractionDigits: 2 })} L`;
  return Math.round(v).toLocaleString("en-IN");
}

/** Rupee amounts already expressed in crore. */
export function crore(v: Num, digits = 0): string {
  if (!isNum(v)) return "—";
  return num(v, digits);
}

/** Large raw counts (volume, turnover in rupees) in compact Indian units. */
export function compact(v: Num): string {
  if (!isNum(v) || v === 0) return "—";
  const a = Math.abs(v);
  if (a >= 1e7) return `${(v / 1e7).toFixed(2)} Cr`;
  if (a >= 1e5) return `${(v / 1e5).toFixed(2)} L`;
  if (a >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return v.toFixed(0);
}

export function tone(v: Num): string {
  if (!isNum(v) || v === 0) return "text-slate-500 dark:text-slate-400";
  return v > 0 ? "text-up" : "text-down";
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2024-12-31" -> "Dec 2024" */
export function monthYear(iso?: string | null): string {
  if (!iso) return "—";
  const [y, m] = iso.split("-");
  return `${MONTHS[Number(m) - 1] ?? m} ${y}`;
}

const IST = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false,
});

/**
 * "2026-09-11T18:17:39" -> "11 Sep 2026, 18:17". Timestamps carrying a zone
 * (UTC "Z" or "+00:00") are shown in Indian time; naive ones are already local.
 */
export function dateTime(iso?: string | null): string {
  if (!iso) return "—";
  const s = String(iso).trim().replace(" ", "T");
  if (/[zZ]$|[+-]\d{2}:\d{2}$/.test(s)) {
    const d = new Date(s);
    if (!Number.isNaN(d.getTime())) {
      const parts = Object.fromEntries(IST.formatToParts(d).map((p) => [p.type, p.value]));
      return `${parts.day} ${parts.month} ${parts.year}, ${parts.hour}:${parts.minute}`;
    }
  }
  const [d, t] = s.split("T");
  const [y, m, day] = d.split("-");
  if (!y || !m || !day) return String(iso);
  const time = t ? `, ${t.slice(0, 5)}` : "";
  return `${day.padStart(2, "0")} ${MONTHS[Number(m) - 1] ?? m} ${y}${time}`;
}

export function dateOnly(iso?: string | null): string {
  if (!iso) return "—";
  return dateTime(String(iso).slice(0, 10));
}

/** ISO date n days before/after another ISO date. */
export function shiftDate(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
