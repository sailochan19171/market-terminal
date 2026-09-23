"use client";

import clsx from "clsx";
import { CalendarRange, Check, ChevronDown, History, Loader2, Search } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { Badge } from "@/components/ui";
import { useApi, useDebounced } from "@/lib/api";
import { KIND_LABEL, PRESETS, type Dashboard, type Exchange, type Preset, type ViewMode } from "@/lib/dashboard";
import { dateOnly, inr, pct, tone } from "@/lib/format";

// --- company search combobox ---------------------------------------------------------
interface SearchHit {
  key: string; symbol: string | null; bseCode: string | null; company: string; industry: string | null;
  close: number | null; pct_1d: number | null; exchanges: Record<Exchange, boolean>;
}

/** Accessible, debounced company picker (WAI-ARIA combobox pattern). */
export function CompanySelect({ current, onSelect }: { current: { key: string; company: string; symbol: string | null; bseCode: string | null }; onSelect: (key: string) => void }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [cursor, setCursor] = useState(0);
  const debounced = useDebounced(q.trim(), 200);
  const { data, loading } = useApi<{ companies: SearchHit[] }>(open && debounced ? `/api/v2/search?q=${encodeURIComponent(debounced)}&limit=15` : null);
  const hits = debounced ? data?.companies ?? [] : [];
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const listId = useId();

  useEffect(() => {
    const close = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);
  useEffect(() => { setCursor(0); }, [debounced]);
  useEffect(() => { if (open) input.current?.focus(); }, [open]);

  const choose = (h: SearchHit) => { setOpen(false); setQ(""); if (h.key !== current.key) onSelect(h.key); };

  return (
    <div ref={box} className="relative w-full sm:w-80">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-haspopup="listbox" aria-expanded={open}
        className="flex w-full items-center justify-between gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2 text-left text-sm shadow-sm transition hover:border-indigo-300 dark:border-slate-700 dark:bg-slate-900">
        <span className="min-w-0">
          <span className="block truncate font-semibold">{current.company}</span>
          <span className="block truncate text-xs text-slate-500">
            {[current.symbol && `NSE: ${current.symbol}`, current.bseCode && `BSE: ${current.bseCode}`].filter(Boolean).join(" · ")}
          </span>
        </span>
        <ChevronDown size={16} className={clsx("shrink-0 text-slate-400 transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <div className="motion-pop absolute left-0 z-50 mt-2 w-[min(28rem,calc(100vw-2rem))] overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-xl dark:border-slate-700 dark:bg-slate-900">
          <div className="relative border-b border-slate-100 p-2 dark:border-slate-800">
            <Search size={15} className="pointer-events-none absolute left-5 top-1/2 -translate-y-1/2 text-slate-400" />
            <input ref={input} value={q} onChange={(e) => setQ(e.target.value)}
              role="combobox" aria-expanded={hits.length > 0} aria-controls={listId} aria-autocomplete="list"
              aria-activedescendant={hits[cursor] ? `${listId}-${cursor}` : undefined} aria-label="Search companies"
              placeholder="Company name, NSE symbol or BSE code"
              onKeyDown={(e) => {
                if (e.key === "ArrowDown") { e.preventDefault(); setCursor((c) => Math.min(c + 1, hits.length - 1)); }
                else if (e.key === "ArrowUp") { e.preventDefault(); setCursor((c) => Math.max(c - 1, 0)); }
                else if (e.key === "Enter" && hits[cursor]) { e.preventDefault(); choose(hits[cursor]); }
                else if (e.key === "Escape") setOpen(false);
              }}
              className="w-full rounded-xl bg-slate-50 py-2 pl-9 pr-8 text-sm outline-none focus:bg-white dark:bg-slate-800/60" />
            {loading && <Loader2 size={15} className="absolute right-5 top-1/2 -translate-y-1/2 animate-spin text-slate-400" />}
          </div>
          <ul id={listId} role="listbox" aria-label="Companies" className="max-h-80 overflow-y-auto py-1">
            {!debounced && <li className="px-4 py-6 text-center text-sm text-slate-500">Type to search NSE and BSE companies.</li>}
            {debounced && !loading && hits.length === 0 && <li className="px-4 py-6 text-center text-sm text-slate-500">No company matches “{debounced}”.</li>}
            {hits.map((h, i) => (
              <li key={h.key} id={`${listId}-${i}`} role="option" aria-selected={i === cursor}
                onMouseEnter={() => setCursor(i)} onMouseDown={(e) => e.preventDefault()} onClick={() => choose(h)}
                className={clsx("flex cursor-pointer items-center justify-between gap-3 px-4 py-2.5", i === cursor && "bg-indigo-50 dark:bg-indigo-500/10")}>
                <span className="min-w-0">
                  <span className="flex items-center gap-1.5 text-sm font-semibold">
                    <span className="truncate">{h.company}</span>
                    {h.key === current.key && <Check size={14} className="shrink-0 text-indigo-600" />}
                  </span>
                  <span className="mt-0.5 flex flex-wrap gap-1">
                    {h.symbol && <Badge tone="brand">NSE {h.symbol}</Badge>}
                    {h.bseCode && <Badge tone="up">BSE {h.bseCode}</Badge>}
                  </span>
                </span>
                {h.close != null && (
                  <span className="tabular shrink-0 text-right text-xs">
                    <span className="block font-semibold">{inr(h.close)}</span>
                    <span className={tone(h.pct_1d)}>{pct(h.pct_1d)}</span>
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// --- exchange ---------------------------------------------------------------------------
export function ExchangeFilter({ value, available, onChange, disabled }: {
  value: Exchange; available: Record<Exchange, boolean>; onChange: (e: Exchange) => void; disabled?: boolean;
}) {
  return (
    <div role="radiogroup" aria-label="Exchange" className="inline-flex rounded-xl border border-slate-200 bg-slate-50 p-0.5 dark:border-slate-700 dark:bg-slate-800/60">
      {(["NSE", "BSE"] as Exchange[]).map((ex) => {
        const off = disabled || !available[ex];
        return (
          <button key={ex} type="button" role="radio" aria-checked={value === ex} disabled={off}
            title={!available[ex] ? `Not listed on ${ex}` : disabled ? "Stored analyses keep the exchange they were built with" : `Use ${ex} prices`}
            onClick={() => onChange(ex)}
            className={clsx("rounded-[10px] px-3 py-1.5 text-xs font-semibold transition",
              value === ex ? "bg-white text-indigo-700 shadow-sm dark:bg-slate-900 dark:text-indigo-300" : "text-slate-600 hover:text-slate-900 dark:text-slate-400",
              off && "cursor-not-allowed opacity-40")}>
            {ex}
          </button>
        );
      })}
    </div>
  );
}

// --- date range ---------------------------------------------------------------------------
export function DateRangeFilter({ preset, from, to, min, max, onPreset, onCustom }: {
  preset: Preset; from: string | null; to: string | null; min?: string | null; max?: string | null;
  onPreset: (p: Preset) => void; onCustom: (from: string, to: string) => void;
}) {
  const [draft, setDraft] = useState({ from: from ?? "", to: to ?? "" });
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setDraft({ from: from ?? "", to: to ?? "" }); }, [from, to]);

  const apply = () => {
    if (!draft.from || !draft.to) { setError("Choose both dates."); return; }
    if (draft.from > draft.to) { setError("Start date must be on or before the end date."); return; }
    if (max && draft.from > max) { setError(`No data after ${dateOnly(max)}.`); return; }
    setError(null);
    onCustom(draft.from, draft.to);
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div role="radiogroup" aria-label="Date range" className="no-scrollbar inline-flex max-w-full overflow-x-auto rounded-xl border border-slate-200 bg-slate-50 p-0.5 dark:border-slate-700 dark:bg-slate-800/60">
        {[...PRESETS, { value: "custom" as const, label: "Custom" }].map((p) => (
          <button key={p.value} type="button" role="radio" aria-checked={preset === p.value} onClick={() => onPreset(p.value)}
            className={clsx("whitespace-nowrap rounded-[10px] px-2.5 py-1.5 text-xs font-semibold transition",
              preset === p.value ? "bg-white text-indigo-700 shadow-sm dark:bg-slate-900 dark:text-indigo-300" : "text-slate-600 hover:text-slate-900 dark:text-slate-400")}>
            {p.label}
          </button>
        ))}
      </div>
      {preset === "custom" && (
        <form noValidate className="motion-fade flex flex-wrap items-center gap-2" onSubmit={(e) => { e.preventDefault(); apply(); }}>
          <CalendarRange size={15} className="text-slate-400" aria-hidden />
          <label className="sr-only" htmlFor="range-from">Start date</label>
          <input id="range-from" type="date" value={draft.from} min={min ?? undefined} max={draft.to || max || undefined}
            onChange={(e) => setDraft((d) => ({ ...d, from: e.target.value }))}
            className="rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs dark:border-slate-700 dark:bg-slate-900" />
          <span className="text-xs text-slate-400">to</span>
          <label className="sr-only" htmlFor="range-to">End date</label>
          <input id="range-to" type="date" value={draft.to} min={draft.from || min || undefined} max={max ?? undefined}
            onChange={(e) => setDraft((d) => ({ ...d, to: e.target.value }))}
            className="rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs dark:border-slate-700 dark:bg-slate-900" />
          <button type="submit" className="rounded-lg bg-indigo-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-indigo-500">Apply</button>
          {error && <span role="alert" className="text-xs text-rose-600">{error}</span>}
        </form>
      )}
    </div>
  );
}

// --- analysis version -----------------------------------------------------------------------
export function VersionSelect({ versions, value, onChange }: {
  versions: Dashboard["versions"]; value: number | null; onChange: (id: number | null) => void;
}) {
  return (
    <label className="flex items-center gap-2 text-xs font-medium text-slate-500">
      <History size={15} aria-hidden />
      <span className="sr-only sm:not-sr-only">Analysis</span>
      <select value={value ?? ""} onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}
        className="max-w-[16rem] rounded-xl border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-700 shadow-sm dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200">
        <option value="">Latest data (live build)</option>
        {versions.map((v) => (
          <option key={v.id} value={v.id}>
            {dateOnly(v.analysis_date)} · v{v.version} · {KIND_LABEL[v.kind]} · {v.exchange}
          </option>
        ))}
      </select>
    </label>
  );
}

// --- view tabs ------------------------------------------------------------------------------------
export function ViewTabs({ value, onChange, versionCount }: { value: ViewMode; onChange: (v: ViewMode) => void; versionCount: number }) {
  const tabs: { value: ViewMode; label: string }[] = [
    { value: "summary", label: "Summary" },
    { value: "detailed", label: "Detailed analysis" },
    { value: "agents", label: "AI analysts" },
    { value: "versions", label: `Analysis history${versionCount ? ` (${versionCount})` : ""}` },
  ];
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  return (
    <div role="tablist" aria-label="Dashboard view" className="flex gap-1 border-b border-slate-200 dark:border-slate-800">
      {tabs.map((t, i) => (
        <button key={t.value} ref={(el) => { refs.current[i] = el; }} role="tab" type="button" id={`tab-${t.value}`}
          aria-selected={value === t.value} aria-controls={`panel-${t.value}`} tabIndex={value === t.value ? 0 : -1}
          onClick={() => onChange(t.value)}
          onKeyDown={(e) => {
            if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
            const next = (i + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length;
            refs.current[next]?.focus();
            onChange(tabs[next].value);
          }}
          className={clsx("relative whitespace-nowrap px-3 py-2.5 text-sm font-semibold transition",
            value === t.value ? "text-indigo-700 dark:text-indigo-300" : "text-slate-500 hover:text-slate-900 dark:hover:text-white")}>
          {t.label}
          <span className={clsx("absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-indigo-600 transition-opacity dark:bg-indigo-400",
            value === t.value ? "opacity-100" : "opacity-0")} />
        </button>
      ))}
    </div>
  );
}
