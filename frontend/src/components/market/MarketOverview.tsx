"use client";

import clsx from "clsx";
import Link from "next/link";
import { useMemo, useState } from "react";
import { TimeChart } from "@/components/charts/TimeChart";
import { Card, CardHeader, Segmented, Skeleton } from "@/components/ui";
import { useApi } from "@/lib/api";
import { num, pct, signed, tone } from "@/lib/format";

interface Leader { symbol: string; company: string | null; close: number | null; change: number | null; pct_1d: number | null; market_cap_cr: number | null }
interface Tab { label: string; industry: string; index: string; latest: { close: number; pts_change: number; pct_change: number; trade_date: string } | null; leaders: Leader[] }
interface IndexHistory { history: { trade_date: string; close: number }[] }

const RANGES = [
  { value: "30", label: "1M" }, { value: "91", label: "3M" }, { value: "365", label: "1Y" },
  { value: "1826", label: "5Y" },
];

function initials(name: string | null, symbol: string) {
  const words = (name ?? symbol).replace(/limited|ltd\.?/gi, "").trim().split(/\s+/);
  return (words.length > 1 ? words[0][0] + words[1][0] : symbol.slice(0, 2)).toUpperCase();
}

export function MarketOverview({ height = 560 }: { height?: number }) {
  const { data, loading } = useApi<{ tabs: Tab[] }>("/api/v2/sector-overview");
  const [active, setActive] = useState(0);
  const [range, setRange] = useState("365");
  const tab = data?.tabs[active];
  const hist = useApi<IndexHistory>(tab ? `/api/v2/indices/${encodeURIComponent(tab.index)}?days=${range}` : null);

  const line = useMemo(() => (hist.data?.history ?? []).map((h) => ({ t: h.trade_date, value: h.close })), [hist.data]);

  return (
    <Card className="flex flex-col" >
      <CardHeader title="Market overview" subtitle="Sector index and its largest companies" />
      {/* Fixed height, not flex-1: a flex-basis of 0 would override it and the list would never scroll. */}
      <div className="flex min-h-0 flex-col px-5 pb-5 pt-4 sm:px-6" style={{ height }}>
        <div className="no-scrollbar -mx-1 flex gap-1 overflow-x-auto pb-2">
          {(data?.tabs ?? []).map((t, i) => (
            <button key={t.label} onClick={() => setActive(i)}
              className={clsx("whitespace-nowrap rounded-lg px-3 py-1.5 text-sm font-medium transition",
                i === active ? "bg-slate-900 text-white dark:bg-white dark:text-slate-900" : "text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800")}>
              {t.label}
            </button>
          ))}
        </div>

        {loading && !data ? <Skeleton className="mt-2 h-full w-full" /> : tab && (
          <>
            <div className="mt-2 flex items-end justify-between gap-3">
              <Link href={`/indices/${encodeURIComponent(tab.index)}`} className="min-w-0 hover:opacity-80">
                <p className="truncate text-xs font-semibold uppercase tracking-wide text-slate-500">{tab.index}</p>
                {tab.latest && (
                  <p className="mt-0.5 flex items-baseline gap-2">
                    <span className="tabular text-xl font-semibold">{num(tab.latest.close)}</span>
                    <span className={clsx("tabular text-xs font-semibold", tone(tab.latest.pct_change))}>{signed(tab.latest.pts_change)} ({pct(tab.latest.pct_change)})</span>
                  </p>
                )}
              </Link>
              <Segmented size="sm" value={range} onChange={setRange} options={RANGES} />
            </div>
            <div className="mt-2 shrink-0">
              {hist.loading && !hist.data ? <Skeleton className="h-[170px] w-full" /> : <TimeChart mode="area" line={line} showVolume={false} height={170} />}
            </div>

            <ul className="mt-3 min-h-0 flex-1 divide-y divide-slate-100 overflow-y-auto dark:divide-slate-800">
              {tab.leaders.map((l) => (
                <li key={l.symbol}>
                  <Link href={`/company/${l.symbol}`} className="flex items-center gap-3 rounded-lg px-1 py-2.5 hover:bg-slate-50 dark:hover:bg-slate-800/50">
                    <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-slate-100 text-xs font-bold text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                      {initials(l.company, l.symbol)}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-semibold">{l.symbol}</span>
                      <span className="block truncate text-xs text-slate-500">{l.company}</span>
                    </span>
                    <span className="tabular shrink-0 text-right">
                      <span className="block text-sm font-semibold">{num(l.close)}</span>
                      <span className={clsx("block text-xs", tone(l.pct_1d))}>{signed(l.change)} {pct(l.pct_1d)}</span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </Card>
  );
}
