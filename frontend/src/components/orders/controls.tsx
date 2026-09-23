"use client";

// The controls of the orders dashboard. Every list they offer comes from the orders actually on screen - no
// hard-coded companies, customers or periods - so a filter can never select something that is not there.
import clsx from "clsx";
import { CalendarDays, Check, ChevronDown, Search, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

export interface Option { value: string; label: string; count?: number }

/** One height for every control on the filter row, so they line up however the row wraps. */
const FIELD = "h-[3.4rem] w-full rounded-xl border border-slate-200 bg-white px-3 text-left dark:border-slate-700 dark:bg-slate-900";

/** A dropdown that filters as you type, for lists that run to hundreds of names. */
export function Picker({ label, value, options, onChange, placeholder, className }: {
  label: string; value: string; options: Option[]; onChange: (v: string) => void; placeholder?: string; className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const box = useRef<HTMLDivElement>(null);
  const selected = options.find((o) => o.value === value);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", away); document.removeEventListener("keydown", esc); };
  }, [open]);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const list = needle ? options.filter((o) => o.label.toLowerCase().includes(needle) || o.value.toLowerCase().includes(needle)) : options;
    return list.slice(0, 300);
  }, [options, q]);

  return (
    <div ref={box} className={clsx("relative min-w-0", className)}>
      <button type="button" onClick={() => { setOpen((o) => !o); setQ(""); }} aria-haspopup="listbox" aria-expanded={open}
        className={clsx(FIELD, "flex items-center gap-2 text-sm outline-none transition hover:border-indigo-300 focus:border-indigo-400")}>
        <span className="min-w-0 flex-1 truncate">
          <span className="block text-[10.5px] font-semibold uppercase tracking-wide text-slate-400">{label}</span>
          <span className={clsx("block truncate", selected ? "text-slate-900 dark:text-white" : "text-slate-400")}>{selected?.label ?? placeholder ?? "All"}</span>
        </span>
        {value
          ? <span role="button" tabIndex={0} aria-label={`Clear ${label}`} onClick={(e) => { e.stopPropagation(); onChange(""); }}
            onKeyDown={(e) => { if (e.key === "Enter") { e.stopPropagation(); onChange(""); } }}
            className="rounded p-0.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800"><X size={14} /></span>
          : <ChevronDown size={15} className="shrink-0 text-slate-400" />}
      </button>
      {open && (
        <div className="absolute z-30 mt-1 max-h-80 w-full min-w-[15rem] overflow-hidden rounded-xl border border-slate-200 bg-white shadow-xl dark:border-slate-700 dark:bg-slate-900">
          <div className="relative border-b border-slate-100 dark:border-slate-800">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Search ${label.toLowerCase()}`} aria-label={`Search ${label}`}
              className="w-full bg-transparent py-2 pl-8 pr-3 text-sm outline-none" />
          </div>
          <ul role="listbox" className="max-h-64 overflow-y-auto py-1 text-sm">
            <li>
              <button type="button" onClick={() => { onChange(""); setOpen(false); }}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-slate-50 dark:hover:bg-slate-800">
                {!value && <Check size={14} className="text-indigo-600" />}<span className={clsx(!value && "font-semibold")}>All</span>
              </button>
            </li>
            {shown.map((o) => (
              <li key={o.value}>
                <button type="button" role="option" aria-selected={o.value === value} onClick={() => { onChange(o.value); setOpen(false); }}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-slate-50 dark:hover:bg-slate-800">
                  {o.value === value && <Check size={14} className="shrink-0 text-indigo-600" />}
                  <span className={clsx("min-w-0 flex-1 truncate", o.value === value && "font-semibold")}>{o.label}</span>
                  {o.count != null && <span className="shrink-0 text-xs text-slate-400">{o.count}</span>}
                </button>
              </li>
            ))}
            {!shown.length && <li className="px-3 py-3 text-sm text-slate-500">Nothing matches “{q}”.</li>}
          </ul>
        </div>
      )}
    </div>
  );
}

/** A labelled number box, for the "at least this big" filters. */
export function NumberBox({ label, value, onChange, suffix, placeholder, className }: {
  label: string; value: string; onChange: (v: string) => void; suffix?: string; placeholder?: string; className?: string;
}) {
  return (
    <label className={clsx(FIELD, "flex flex-col justify-center focus-within:border-indigo-400", className)}>
      <span className="block truncate text-[10.5px] font-semibold uppercase tracking-wide text-slate-400">{label}</span>
      <span className="flex items-baseline gap-1">
        <input inputMode="decimal" value={value} onChange={(e) => onChange(e.target.value.replace(/[^\d.]/g, ""))} placeholder={placeholder ?? "0"}
          className="w-full min-w-0 bg-transparent text-sm outline-none" />
        {suffix && <span className="shrink-0 whitespace-nowrap text-[11px] text-slate-400">{suffix}</span>}
      </span>
    </label>
  );
}

/** Market cap band, on the scale the screens use: 0, 100, 500, 2k, 10k, 1L crore and above. */
export const CAP_STOPS = [0, 100, 500, 2_000, 10_000, 100_000, Number.POSITIVE_INFINITY];
export const CAP_LABELS = ["0", "100", "500", "2k", "10k", "1L", "Max"];

export function CapSlider({ min, max, onChange }: { min: number; max: number; onChange: (min: number, max: number) => void }) {
  const lo = Math.max(0, CAP_STOPS.indexOf(min));
  const hi = CAP_STOPS.findIndex((v) => v === max) === -1 ? CAP_STOPS.length - 1 : CAP_STOPS.findIndex((v) => v === max);
  const set = (which: "lo" | "hi", i: number) => {
    const nextLo = which === "lo" ? Math.min(i, hi) : lo;
    const nextHi = which === "hi" ? Math.max(i, lo) : hi;
    onChange(CAP_STOPS[nextLo], CAP_STOPS[nextHi]);
  };
  const label = (i: number) => (i === CAP_STOPS.length - 1 ? "Max" : `₹${CAP_LABELS[i]} Cr`);
  return (
    <div className={clsx(FIELD, "flex flex-col justify-center")}>
      <p className="truncate text-[10.5px] font-semibold uppercase tracking-wide text-slate-400">
        Market cap: {lo === 0 && hi === CAP_STOPS.length - 1 ? "any size" : `${label(lo)} to ${label(hi)}`}
      </p>
      <div className="flex items-center gap-2">
        <input type="range" min={0} max={CAP_STOPS.length - 1} step={1} value={lo} onChange={(e) => set("lo", Number(e.target.value))}
          aria-label="Smallest market cap" className="h-1 w-full accent-emerald-500" />
        <input type="range" min={0} max={CAP_STOPS.length - 1} step={1} value={hi} onChange={(e) => set("hi", Number(e.target.value))}
          aria-label="Largest market cap" className="h-1 w-full accent-emerald-500" />
      </div>
      <div className="flex justify-between text-[10px] text-slate-400">{CAP_LABELS.map((l) => <span key={l}>{l}</span>)}</div>
    </div>
  );
}

/** The green share-of-revenue chip from the orders screens; deeper green as the share grows. */
export function ShareChip({ pct }: { pct: number | null }) {
  if (pct === null) return <span className="text-xs text-slate-400">no revenue on file</span>;
  const tone = pct >= 100 ? "bg-emerald-600 text-white" : pct >= 25 ? "bg-emerald-500/90 text-white" : pct >= 5 ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-500/20 dark:text-emerald-200" : "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200";
  return <span className={clsx("inline-block rounded-full px-2 py-0.5 text-xs font-semibold tabular-nums", tone)}>{pct >= 1000 ? Math.round(pct).toLocaleString("en-IN") : pct.toFixed(2)}%</span>;
}

/**
 * A day chosen from the browser's own calendar. Used for the period: it opens on today, and picking a day
 * filters the table to that day (or, with two of these, to the range between them).
 */
export function DateBox({ label, value, onChange, max, min, className }: {
  label: string; value: string; onChange: (v: string) => void; max?: string; min?: string; className?: string;
}) {
  return (
    <label className={clsx(FIELD, "flex flex-col justify-center focus-within:border-indigo-400", className)}>
      <span className="block text-[10.5px] font-semibold uppercase tracking-wide text-slate-400">{label}</span>
      <span className="flex items-center gap-1.5">
        <CalendarDays size={14} className="shrink-0 text-slate-400" />
        <input type="date" value={value} max={max} min={min} onChange={(e) => onChange(e.target.value)} aria-label={label}
          className="w-full min-w-0 bg-transparent text-sm outline-none [color-scheme:light] dark:[color-scheme:dark]" />
      </span>
    </label>
  );
}

/** Today, and any day, as the browser's calendar writes them: YYYY-MM-DD in the reader's own time zone. */
export function isoDay(d: Date = new Date()): string {
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
}
