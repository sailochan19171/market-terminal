"use client";

import clsx from "clsx";
import { Activity, RefreshCw } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Card, CardHeader, ErrorNote, Pct, Segmented, Skeleton } from "@/components/ui";
import { useApi } from "@/lib/api";
import { compact, dateTime, num, signed, tone } from "@/lib/format";

interface LiveIndex {
  name: string; last: number | null; change: number | null; pct: number | null; open: number | null; high: number | null; low: number | null;
  prevClose: number | null; yearHigh: number | null; yearLow: number | null; advances: number | null; declines: number | null; unchanged: number | null;
}
interface LiveMover { symbol: string; name: string | null; ltp: number | null; pct: number | null; change: number | null; volume: number | null; turnoverCr: number | null; extra: number | null }
interface Pulse {
  status: { open: boolean; label: string; message: string; tradeDate: string | null };
  asOf: string | null; fetchedAt: string; indices: LiveIndex[];
  movers: { gainers: LiveMover[]; losers: LiveMover[]; volume: LiveMover[]; highs: LiveMover[]; lows: LiveMover[] };
  counts: { highs: number | null; lows: number | null };
  errors: string[];
}

type Tab = keyof Pulse["movers"];

// While the session runs the snapshot is refreshed every 30 s; outside it, the last close barely changes.
const OPEN_REFRESH_S = 30;
const CLOSED_REFRESH_S = 300;

const SHORT: Record<string, string> = {
  "NIFTY 50": "Nifty 50", "NIFTY BANK": "Nifty Bank", "NIFTY NEXT 50": "Nifty Next 50", "NIFTY MIDCAP 100": "Midcap 100", "NIFTY IT": "Nifty IT", "INDIA VIX": "India VIX",
};

/** Where the last value sits in the day's range, with the open marked. */
function RangeBar({ low, high, last, open }: { low: number | null; high: number | null; last: number | null; open: number | null }) {
  if (low === null || high === null || last === null || high <= low) return <div className="h-1.5 rounded-full bg-slate-100 dark:bg-slate-800" />;
  const at = (v: number) => `${Math.min(100, Math.max(0, ((v - low) / (high - low)) * 100))}%`;
  return (
    <div className="relative h-1.5 rounded-full bg-gradient-to-r from-rose-200 via-slate-200 to-emerald-200 dark:from-rose-500/30 dark:via-slate-700 dark:to-emerald-500/30"
      title={`Day range ${num(low)} – ${num(high)}`}>
      {open !== null && <span className="absolute top-1/2 h-2.5 w-px -translate-y-1/2 bg-slate-400" style={{ left: at(open) }} />}
      <span className="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-indigo-600 shadow transition-[left] duration-700 dark:border-slate-900"
        style={{ left: at(last) }} />
    </div>
  );
}

/** Briefly tints a value green or red when a refresh moves it. */
function Flash({ value, children }: { value: number | null; children: React.ReactNode }) {
  const prev = useRef(value);
  const [cls, setCls] = useState("");
  useEffect(() => {
    if (prev.current !== null && value !== null && value !== prev.current) {
      setCls(value > prev.current ? "flash-up" : "flash-down");
      const t = setTimeout(() => setCls(""), 1200);
      prev.current = value;
      return () => clearTimeout(t);
    }
    prev.current = value;
  }, [value]);
  return <span className={clsx("rounded px-0.5", cls)}>{children}</span>;
}

function IndexCard({ ix }: { ix: LiveIndex }) {
  const vix = ix.name === "INDIA VIX";
  return (
    <Link href={vix ? "/indices" : `/indices/${encodeURIComponent(ix.name)}`}
      className="hover-lift block rounded-xl border border-slate-200 bg-white p-3 dark:border-slate-800 dark:bg-slate-900">
      <div className="flex items-baseline justify-between gap-2">
        <span className="truncate text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">{SHORT[ix.name] ?? ix.name}</span>
        <Pct value={ix.pct} className="text-xs" />
      </div>
      <div className="mt-1 flex items-baseline justify-between gap-2">
        <span className="text-lg font-semibold tabular-nums text-slate-900 dark:text-white"><Flash value={ix.last}>{num(ix.last)}</Flash></span>
        <span className={clsx("text-xs tabular-nums", tone(ix.change))}>{signed(ix.change)}</span>
      </div>
      <div className="mt-2.5"><RangeBar low={ix.low} high={ix.high} last={ix.last} open={ix.open} /></div>
      <div className="mt-1 flex justify-between text-[11px] tabular-nums text-slate-400">
        <span>L {num(ix.low)}</span><span>H {num(ix.high)}</span>
      </div>
    </Link>
  );
}

function BreadthBar({ ix }: { ix: LiveIndex }) {
  const a = ix.advances ?? 0, d = ix.declines ?? 0, u = ix.unchanged ?? 0;
  const total = a + d + u;
  if (!total) return null;
  return (
    <div>
      <div className="mb-1.5 flex justify-between text-xs font-medium">
        <span className="text-up">{a} advancing</span>
        <span className="text-slate-500">{SHORT[ix.name] ?? ix.name} breadth{u ? ` · ${u} unchanged` : ""}</span>
        <span className="text-down">{d} declining</span>
      </div>
      <div className="flex h-2.5 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800" role="img" aria-label={`${a} advancing, ${d} declining, ${u} unchanged`}>
        <div className="bg-emerald-500 transition-[width] duration-700" style={{ width: `${(a / total) * 100}%` }} />
        <div className="bg-slate-300 transition-[width] duration-700 dark:bg-slate-600" style={{ width: `${(u / total) * 100}%` }} />
        <div className="bg-rose-500 transition-[width] duration-700" style={{ width: `${(d / total) * 100}%` }} />
      </div>
    </div>
  );
}

function MoversTable({ tab, rows }: { tab: Tab; rows: LiveMover[] }) {
  if (!rows.length) return <p className="px-5 py-8 text-center text-sm text-slate-500 sm:px-6">No live rows from the exchange for this list right now.</p>;
  const extraLabel = tab === "volume" ? "× 1W avg vol" : tab === "highs" ? "52W high" : tab === "lows" ? "52W low" : "Value (Cr)";
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-slate-100 text-left text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800">
            <th className="px-5 py-2 font-medium sm:px-6">Symbol</th>
            <th className="px-3 py-2 text-right font-medium">LTP</th>
            <th className="px-3 py-2 text-right font-medium">% Chg</th>
            <th className="px-5 py-2 text-right font-medium sm:px-6">{extraLabel}</th>
          </tr>
        </thead>
        <tbody className="motion-stagger">
          {rows.map((r) => (
            <tr key={r.symbol} className="border-b border-slate-50 last:border-0 hover:bg-slate-50 dark:border-slate-800/60 dark:hover:bg-slate-800/40">
              <td className="px-5 py-2 sm:px-6">
                <Link href={`/company/${encodeURIComponent(r.symbol)}`} className="font-semibold text-indigo-700 hover:underline dark:text-indigo-300">{r.symbol}</Link>
                {r.name && <div className="max-w-[16rem] truncate text-xs text-slate-500">{r.name}</div>}
              </td>
              <td className="px-3 py-2 text-right tabular-nums"><Flash value={r.ltp}>{num(r.ltp)}</Flash></td>
              <td className="px-3 py-2 text-right"><Pct value={r.pct} /></td>
              <td className="px-5 py-2 text-right tabular-nums text-slate-600 sm:px-6 dark:text-slate-300">
                {tab === "volume" ? `${num(r.extra, 1)}×` : tab === "highs" || tab === "lows" ? num(r.extra) : num(r.turnoverCr)}
                {tab === "volume" && r.volume !== null && <div className="text-xs text-slate-400">{compact(r.volume)} shares</div>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function LivePulse() {
  const { data, error, loading, reload } = useApi<Pulse>("/api/v2/market/live");
  const [tab, setTab] = useState<Tab>("gainers");
  const every = data?.status.open ? OPEN_REFRESH_S : CLOSED_REFRESH_S;
  const [clock, setClock] = useState(() => ({ now: Date.now(), due: Date.now() + every * 1000 }));
  const left = Math.max(0, Math.round((clock.due - clock.now) / 1000));

  // Count down to the next refresh; pause while the tab is hidden so background tabs do not poll the exchange.
  useEffect(() => {
    const id = setInterval(() => {
      if (document.hidden) return;
      const now = Date.now();
      setClock((c) => {
        // Due, or the market changed state and the wait is now longer than the new interval.
        if (now >= c.due || c.due - now > every * 1000) return { now, due: now + every * 1000 };
        return { now, due: c.due };
      });
    }, 1000);
    return () => clearInterval(id);
  }, [every]);

  const due = clock.due;
  const lastDue = useRef(due);
  useEffect(() => {
    if (due !== lastDue.current) {
      lastDue.current = due;
      reload();
    }
  }, [due, reload]);

  if (!data) {
    if (error) return <Card><CardHeader title="Live market pulse" /><ErrorNote message={`Live NSE feeds could not load: ${error}`} onRetry={reload} /></Card>;
    return (
      <Card>
        <CardHeader title="Live market pulse" subtitle="Connecting to NSE live feeds…" />
        <div className="grid grid-cols-2 gap-3 p-5 sm:grid-cols-3 sm:px-6" aria-busy="true" aria-label="Loading live market pulse">
          {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-[92px]" />)}
        </div>
      </Card>
    );
  }

  const nifty = data.indices.find((i) => i.name === "NIFTY 50");
  const tabs: { value: Tab; label: string }[] = [
    { value: "gainers", label: "Gainers" }, { value: "losers", label: "Losers" }, { value: "volume", label: "Volume spurts" },
    { value: "highs", label: `52W highs${data.counts.highs !== null ? ` (${data.counts.highs})` : ""}` },
    { value: "lows", label: `52W lows${data.counts.lows !== null ? ` (${data.counts.lows})` : ""}` },
  ];

  return (
    <Card className="overflow-hidden">
      <CardHeader
        title={
          <span className="inline-flex items-center gap-2">
            <Activity className="h-5 w-5 text-indigo-600" aria-hidden /> Live market pulse
            <span className={clsx("inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-semibold",
              data.status.open ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300" : "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300")}>
              <span className={clsx("h-1.5 w-1.5 rounded-full", data.status.open ? "anim-pulse bg-emerald-500" : "bg-slate-400")} />
              {data.status.label}
            </span>
          </span>
        }
        subtitle={data.status.open
          ? `NSE live · as of ${dateTime(data.asOf)}`
          : `${data.status.message || "Market closed"} · showing the last session, ${dateTime(data.asOf)}`}
        actions={
          <button type="button" onClick={reload} disabled={loading}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-medium text-slate-600 transition hover:border-indigo-300 disabled:opacity-60 dark:border-slate-700 dark:text-slate-300"
            aria-label="Refresh live data">
            <RefreshCw className={clsx("h-3.5 w-3.5", loading && "animate-spin")} aria-hidden />
            {loading ? "Updating" : `${left}s`}
          </button>
        }
      />
      <div className={clsx("space-y-5 px-5 pt-4 sm:px-6", loading && "opacity-90")}>
        <div className="motion-stagger grid grid-cols-2 gap-3 sm:grid-cols-3">
          {data.indices.map((ix) => <IndexCard key={ix.name} ix={ix} />)}
        </div>
        {nifty && <BreadthBar ix={nifty} />}
        {data.errors.length > 0 && (
          <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-500/10 dark:text-amber-300" role="status">
            Some live feeds did not respond ({data.errors.map((e) => e.split(":")[0]).join(", ")}); the rest are current.
          </p>
        )}
        <div className="-mx-1 overflow-x-auto px-1">
          <Segmented size="sm" value={tab} onChange={setTab} options={tabs} />
        </div>
      </div>
      <div key={tab} className="motion-fade pt-2">
        <MoversTable tab={tab} rows={data.movers[tab]} />
      </div>
      <p className="border-t border-slate-100 px-5 py-2.5 text-[11px] text-slate-400 sm:px-6 dark:border-slate-800">
        {tab === "gainers" || tab === "losers" ? "NIFTY 50 constituents. " : ""}Source: NSE live market data, refreshed every {every >= 60 ? `${every / 60} min` : `${every} s`}.
      </p>
    </Card>
  );
}
