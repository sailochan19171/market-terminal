"use client";

import clsx from "clsx";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useMemo, useState } from "react";
import { TimeChart, type Bar } from "@/components/charts/TimeChart";
import { DataTable } from "@/components/DataTable";
import { Card, CardBody, CardHeader, ErrorNote, Loading, Pct, Segmented, Stat, Unavailable } from "@/components/ui";
import { useApi } from "@/lib/api";
import { dateTime, num, signed, tone } from "@/lib/format";

interface Detail {
  name: string; display: string;
  latest: { close: number; pts_change: number; pct_change: number; open: number; high: number; low: number; pe: number | null; pb: number | null; div_yield: number | null; volume: number | null; turnover_cr: number | null; trade_date: string };
  returns: Record<string, number | null>;
  history: { trade_date: string; open: number; high: number; low: number; close: number; pe: number | null; pb: number | null; div_yield: number | null }[];
  constituents: { symbol: string; company: string; industry: string | null; close: number | null; change: number | null; pct_1d: number | null; market_cap_cr: number | null; pe: number | null; ret_1y: number | null; turnover: number | null }[];
  hasConstituents: boolean;
}

const RANGES = [{ value: "91", label: "3M" }, { value: "365", label: "1Y" }, { value: "1095", label: "3Y" }, { value: "1826", label: "5Y" }];

export default function IndexPage() {
  const params = useParams<{ name: string }>();
  const name = decodeURIComponent(params.name ?? "");
  const [range, setRange] = useState("365");
  const [view, setView] = useState<"price" | "pe" | "pb" | "dy">("price");
  const { data, error, loading, reload } = useApi<Detail>(`/api/v2/indices/${encodeURIComponent(name)}?days=${range}`);

  const bars: Bar[] = useMemo(() => (data?.history ?? []).map((h) => ({ t: h.trade_date, o: h.open, h: h.high, l: h.low, c: h.close })), [data]);
  const valuation = useMemo(() => {
    const key = view === "pe" ? "pe" : view === "pb" ? "pb" : "div_yield";
    return (data?.history ?? []).map((h) => ({ t: h.trade_date, value: h[key] }));
  }, [data, view]);

  if (error) return <Card><ErrorNote message={error} onRetry={reload} /></Card>;
  if (!data) return <Card><Loading rows={12} /></Card>;
  const l = data.latest;

  return (
    <div className="space-y-6">
      <Card>
        <CardBody className="flex flex-wrap items-end justify-between gap-6">
          <div>
            <Link href="/indices" className="text-sm font-medium text-indigo-700 hover:underline dark:text-indigo-300">← Indices</Link>
            <h1 className="mt-1 text-2xl font-semibold tracking-tight sm:text-3xl">{data.display}</h1>
            <div className="mt-2 flex items-baseline gap-3">
              <span className="tabular text-3xl font-semibold">{num(l.close)}</span>
              <span className={clsx("tabular text-sm font-semibold", tone(l.pct_change))}>{signed(l.pts_change)} (<Pct value={l.pct_change} />)</span>
            </div>
            <p className="mt-1 text-xs text-slate-500">Close on {dateTime(l.trade_date)}</p>
          </div>
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
            {["1M", "3M", "6M", "1Y", "3Y", "5Y"].map((k) => [k, data.returns[k] ?? null] as const).map(([k, v]) => (
              <div key={k} className="rounded-xl border border-slate-100 px-3 py-2 text-center dark:border-slate-800">
                <p className="text-xs text-slate-500">{k}</p>
                <Pct value={v} digits={1} className="text-sm font-semibold" />
              </div>
            ))}
          </div>
        </CardBody>
      </Card>

      <div className="grid gap-6 xl:grid-cols-4">
        <Card className="xl:col-span-3">
          <CardHeader title="Performance" actions={<>
            <Segmented size="sm" value={view} onChange={setView} options={[
              { value: "price", label: "Price" }, { value: "pe", label: "P/E" }, { value: "pb", label: "P/B" }, { value: "dy", label: "Div yield" },
            ]} />
            <Segmented size="sm" value={range} onChange={setRange} options={RANGES} />
          </>} />
          <CardBody>
            {loading ? <Loading rows={8} /> : view === "price"
              ? <TimeChart mode="candles" bars={bars} showVolume={false} height={380} title={data.display} />
              : <TimeChart mode="line" line={valuation} showVolume={false} height={380} valueFormat={(v) => num(v, 2)} title={data.display} valueLabel={view === "pe" ? "P/E" : view === "pb" ? "P/B" : "Div yield %"} />}
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Session" />
          <CardBody>
            <dl>
              <Stat label="Open" value={num(l.open)} />
              <Stat label="High" value={num(l.high)} />
              <Stat label="Low" value={num(l.low)} />
              <Stat label="P/E" value={num(l.pe)} />
              <Stat label="P/B" value={num(l.pb)} />
              <Stat label="Dividend yield" value={`${num(l.div_yield)}%`} />
              <Stat label="Turnover" value={l.turnover_cr != null ? `₹${num(l.turnover_cr, 0)} Cr` : "—"} />
            </dl>
          </CardBody>
        </Card>
      </div>

      <Card>
        <CardHeader title="Constituents" subtitle={data.hasConstituents ? `${data.constituents.length} companies, by market cap` : undefined} />
        <div className="pt-3">
          {!data.hasConstituents ? (
            <CardBody><Unavailable title="Constituent list not published" reason="NSE publishes downloadable constituent lists for its headline and major sector indices; this index is not one of them." /></CardBody>
          ) : (
            <DataTable dense sortable numbered searchable searchPlaceholder="Search constituents" rows={data.constituents} rowKey={(r) => r.symbol} initialSort={{ key: "market_cap_cr", dir: "desc" }}
              columns={[
                { key: "company", label: "Company", render: (r) => <Link href={`/company/${r.symbol}`} className="font-medium text-indigo-700 hover:underline dark:text-indigo-300">{r.company ?? r.symbol}</Link> },
                { key: "industry", label: "Sector", render: (r) => <span className="text-slate-500">{r.industry ?? "—"}</span> },
                { key: "close", label: "Price", align: "right", render: (r) => num(r.close) },
                { key: "pct_1d", label: "% Chg", align: "right", render: (r) => <Pct value={r.pct_1d} /> },
                { key: "market_cap_cr", label: "Mkt cap ₹ Cr", align: "right", render: (r) => num(r.market_cap_cr, 0) },
                { key: "pe", label: "P/E", align: "right", render: (r) => num(r.pe, 1) },
                { key: "ret_1y", label: "1Y", align: "right", render: (r) => <Pct value={r.ret_1y} digits={1} /> },
              ]} />
          )}
        </div>
      </Card>
    </div>
  );
}
