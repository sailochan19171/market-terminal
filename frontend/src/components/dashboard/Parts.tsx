"use client";

import clsx from "clsx";
import { AlertTriangle, ArrowDownRight, ArrowUpRight, Clock, Database, Info, RefreshCw, RotateCcw } from "lucide-react";
import { useId, type ReactNode } from "react";
import { Badge, Card, CardHeader, Skeleton } from "@/components/ui";
import { formatMetric, METRICS, type Dashboard, type SyncStatus } from "@/lib/dashboard";
import { dateOnly, dateTime, isNum, NA, type Num } from "@/lib/format";

/** "Not available" with the actual reason, readable by mouse, keyboard and screen readers. */
export function NotAvailable({ reason, compact }: { reason?: string | null; compact?: boolean }) {
  const id = useId();
  return (
    <span className="inline-flex items-center gap-1 text-slate-400 dark:text-slate-500">
      <span className={compact ? "text-xs" : "text-sm font-medium"}>{NA}</span>
      {reason && (
        <span className="group relative inline-flex">
          <button type="button" aria-describedby={id} className="rounded text-slate-400 hover:text-slate-600" aria-label="Why is this not available?">
            <Info size={13} />
          </button>
          <span id={id} role="tooltip"
            className="pointer-events-none absolute bottom-full left-1/2 z-30 mb-2 w-60 -translate-x-1/2 rounded-lg bg-slate-900 px-2.5 py-2 text-left text-xs font-normal leading-snug text-white opacity-0 shadow-lg transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 dark:bg-slate-700">
            {reason}
          </span>
        </span>
      )}
    </span>
  );
}

export function KpiCard({ data, metric, sub, emphasis }: { data: Dashboard; metric: string; sub?: ReactNode; emphasis?: boolean }) {
  const value = data.metrics[metric] as Num;
  const meta = METRICS[metric];
  const available = isNum(value);
  return (
    <div className={clsx("hover-lift rounded-2xl border bg-white p-4 dark:bg-slate-900",
      emphasis ? "border-indigo-200 dark:border-indigo-500/30" : "border-slate-200 dark:border-slate-800")}>
      <p className="flex items-center gap-1 text-xs font-medium text-slate-500 dark:text-slate-400" title={meta?.hint}>
        {meta?.label ?? metric}
      </p>
      <p className="tabular mt-1.5 text-xl font-semibold tracking-tight text-slate-900 dark:text-white">
        {available ? formatMetric(metric, value) : <NotAvailable reason={data.reasons[metric]} />}
      </p>
      {available && sub && <div className="mt-1 text-xs">{sub}</div>}
      {available && data.sources[metric] && <p className="mt-1 truncate text-[11px] text-slate-400" title={data.sources[metric]}>{data.sources[metric]}</p>}
    </div>
  );
}

export function Delta({ value, label }: { value: Num; label?: string }) {
  if (!isNum(value)) return null;
  const up = value >= 0;
  return (
    <span className={clsx("inline-flex items-center gap-0.5 font-semibold", up ? "text-up" : "text-down")}>
      {up ? <ArrowUpRight size={13} /> : <ArrowDownRight size={13} />}
      {`${up ? "+" : ""}${value.toFixed(1)}%`}
      {label && <span className="ml-1 font-normal text-slate-400">{label}</span>}
    </span>
  );
}

export function KpiSkeleton({ count = 8 }: { count?: number }) {
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4" role="status" aria-label="Loading figures">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="rounded-2xl border border-slate-200 p-4 dark:border-slate-800">
          <Skeleton className="h-3 w-20" />
          <Skeleton className="mt-3 h-6 w-28" />
        </div>
      ))}
    </div>
  );
}

/** Frame for every chart: title, unit, and a real empty state instead of a blank box. */
export function ChartCard({ id, title, subtitle, unit, points, minPoints = 2, empty, actions, children, loading, className }: {
  id?: string; title: string; subtitle?: ReactNode; unit?: string; points: number; minPoints?: number;
  empty?: string; actions?: ReactNode; children: ReactNode; loading?: boolean; className?: string;
}) {
  return (
    <Card id={id} className={clsx("motion-rise", className)}>
      <CardHeader title={title} subtitle={<>{subtitle}{unit && <span className="ml-1 text-slate-400">· {unit}</span>}</>} actions={actions} />
      <div className="px-3 pb-4 pt-3 sm:px-5">
        {loading ? <Skeleton className="h-[260px] w-full" />
          : points < minPoints ? <InsufficientData message={empty} points={points} minPoints={minPoints} />
          : <div className="motion-fade" role="figure" aria-label={title}>{children}</div>}
      </div>
    </Card>
  );
}

export function InsufficientData({ message, points, minPoints }: { message?: string; points?: number; minPoints?: number }) {
  return (
    <div className="flex h-[220px] flex-col items-center justify-center rounded-xl border border-dashed border-slate-300 bg-slate-50/60 px-6 text-center dark:border-slate-700 dark:bg-slate-800/30">
      <p className="text-sm font-semibold text-slate-700 dark:text-slate-200">Insufficient data</p>
      <p className="mt-1 max-w-md text-sm text-slate-500">
        {message ?? "No historical data available for this period."}
        {points != null && minPoints != null && points > 0 && ` ${points} of the ${minPoints} data points needed are on file.`}
      </p>
    </div>
  );
}

const STATUS = {
  end_of_day: { label: "Latest end-of-day data", tone: "up" as const },
  delayed: { label: "Delayed data", tone: "amber" as const },
  historical: { label: "Historical view", tone: "brand" as const },
  version: { label: "Stored analysis", tone: "brand" as const },
};

/** What the user is looking at, how fresh it is, and a way back to the latest data. */
export function StatusBar({ data, updatedAt, refreshing, error, onRetry, onLatest }: {
  data: Dashboard; updatedAt: Date | null; refreshing: boolean; error: string | null; onRetry: () => void; onLatest: () => void;
}) {
  const kind = data.mode === "version" ? "version" : data.freshness.status;
  const s = STATUS[kind];
  const f = data.freshness;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-2xl border border-slate-200 bg-white px-4 py-2.5 text-xs text-slate-600 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300">
        <Badge tone={s.tone}>{s.label}</Badge>
        {data.mode === "version" && data.version && (
          <span>Analysis v{data.version.version} of <strong>{dateOnly(data.version.analysis_date)}</strong>, saved {dateTime(data.version.created_at)}</span>
        )}
        {data.mode === "historical" && <span>As of <strong>{dateOnly(f.asOf)}</strong>, using only filings published by then</span>}
        {kind === "delayed" && <span>The newest stored session is {dateOnly(f.prices.latestStored)}; the daily update has not run since.</span>}
        <span className="inline-flex items-center gap-1"><Database size={13} aria-hidden /> Prices: {f.prices.source}, session {dateOnly(f.prices.session)}</span>
        {f.results.latestQuarter && <span>Results to {dateOnly(f.results.latestQuarter)}</span>}
        {f.shareholding.asOf && <span>Shareholding {dateOnly(f.shareholding.asOf)}</span>}
        <span className="inline-flex items-center gap-1 text-slate-500">
          <Clock size={13} aria-hidden /> Last updated: {dateTime(data.mode === "version" ? data.version?.updated_at : f.computedAt)}
          {updatedAt && data.mode !== "version" && <span className="sr-only"> (fetched {updatedAt.toLocaleTimeString("en-IN")})</span>}
        </span>
        {refreshing && <span className="inline-flex items-center gap-1 text-indigo-600"><RefreshCw size={13} className="animate-spin" /> Updating…</span>}
        {data.mode !== "latest" && (
          <button onClick={onLatest} className="ml-auto inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2 py-1 font-semibold text-indigo-700 hover:bg-indigo-50 dark:border-slate-700 dark:text-indigo-300 dark:hover:bg-indigo-500/10">
            <RotateCcw size={13} /> Return to latest
          </button>
        )}
      </div>
      {error && (
        <div role="alert" className="motion-fade flex flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-100">
          <span className="inline-flex items-center gap-1.5"><AlertTriangle size={14} /> Could not refresh: {error}. Showing the last data that loaded.</span>
          <button onClick={onRetry} className="font-semibold underline underline-offset-2">Retry</button>
        </div>
      )}
    </div>
  );
}

const STAGE = { results: "Parsing this company's result filings", shareholding: "Downloading shareholding patterns", metrics: "Recalculating ratios" } as Record<string, string>;

export function SyncProgress({ sync }: { sync: SyncStatus | null }) {
  if (!sync || !(sync.running || sync.status === "running")) return null;
  const total = sync.total ?? 0;
  const pctDone = total ? Math.round(((sync.done ?? 0) / total) * 100) : null;
  return (
    <div role="status" className="motion-fade rounded-2xl border border-indigo-100 bg-indigo-50/70 px-4 py-2.5 text-xs text-indigo-900 dark:border-indigo-500/20 dark:bg-indigo-500/10 dark:text-indigo-100">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="inline-flex items-center gap-2 font-semibold">
          <RefreshCw size={14} className="animate-spin" /> {STAGE[sync.stage ?? ""] ?? "Fetching the latest filings from NSE"}
          {total > 0 && <span className="tabular font-normal">{sync.done ?? 0} of {total}</span>}
        </span>
        <span className="text-indigo-700 dark:text-indigo-300">The dashboard refreshes by itself when this finishes.</span>
      </div>
      <div className="mt-2 h-1 overflow-hidden rounded-full bg-indigo-100 dark:bg-indigo-500/20">
        {pctDone != null
          ? <div className="h-full rounded-full bg-indigo-600 transition-all dark:bg-indigo-400" style={{ width: `${pctDone}%` }} />
          : <div className="progress-indeterminate h-full w-1/3 rounded-full bg-indigo-600 dark:bg-indigo-400" />}
      </div>
    </div>
  );
}

export function SectionTitle({ children, id }: { children: ReactNode; id?: string }) {
  return <h2 id={id} className="scroll-mt-64 pt-2 text-sm font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">{children}</h2>;
}
