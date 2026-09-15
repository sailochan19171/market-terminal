"use client";

import clsx from "clsx";
import { ArrowDownRight, ArrowUpRight, Gauge, ListFilter, Search, X } from "lucide-react";
import Link from "next/link";
import { Suspense, useEffect, useMemo, useState } from "react";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { ChartTooltipCard } from "@/components/charts/Categorical";
import { Pagination } from "@/components/DataTable";
import { CountUp, HeroStat, MarketIllustration, PageHero } from "@/components/Illustrations";
import { Badge, Card, CardBody, CardHeader, ErrorNote, Loading, Pct, Segmented, Skeleton } from "@/components/ui";
import { useApi, useDebounced } from "@/lib/api";
import { compact, countIN, dateOnly, inr, inrCrore, num, pct, tone } from "@/lib/format";
import { useQueryParams } from "@/lib/query";

type Exchange = "NSE" | "BSE";
interface Mover { key: string; company: string; series: string; close: number; prev_close: number; pct: number | null; volume: number; turnover_cr: number }
interface Summary {
  exchange: Exchange; session: string; previousSession: string | null; source: string;
  totals: { securities: number; advances: number; declines: number; unchanged: number; volume: number; turnover_cr: number; trades: number };
  bySeries: { series: string; label: string; securities: number; advances: number; declines: number; unchanged: number; volume: number; turnover_cr: number; trades: number }[];
  topTurnover: Mover[]; gainers: Mover[]; losers: Mover[];
  breadthHistory: { trade_date: string; advances: number; declines: number; turnover_cr: number }[];
}
interface WatchRow {
  key: string; symbol: string | null; bseCode: string | null; company: string; series: string; open: number; high: number; low: number;
  close: number; prev_close: number; change: number; pct: number | null; volume: number; turnover_cr: number; trades: number | null;
  high_52w: number | null; low_52w: number | null; market_cap_cr: number | null;
}
interface Watch { exchange: Exchange; session: string; total: number; page: number; pageSize: number; items: WatchRow[]; series: { value: string; label: string; count: number }[]; indices: { value: string; label: string; members: number }[] }

const DEFAULTS = { tab: "summary", exchange: "NSE", sort: "turnover", order: "desc", pageSize: "50", page: "1" };

function Breadth({ t }: { t: Summary["totals"] }) {
  const total = t.advances + t.declines + t.unchanged || 1;
  return (
    <div>
      <div className="flex h-3 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800" role="img"
        aria-label={`${t.advances} advances, ${t.unchanged} unchanged, ${t.declines} declines`}>
        <div className="bg-emerald-500 transition-all duration-700" style={{ width: `${(t.advances / total) * 100}%` }} />
        <div className="bg-slate-300 transition-all duration-700 dark:bg-slate-600" style={{ width: `${(t.unchanged / total) * 100}%` }} />
        <div className="bg-rose-500 transition-all duration-700" style={{ width: `${(t.declines / total) * 100}%` }} />
      </div>
      <div className="mt-2 flex justify-between text-xs">
        <span className="font-semibold text-up">{num(t.advances, 0)} advances</span>
        <span className="text-slate-500">{num(t.unchanged, 0)} unchanged</span>
        <span className="font-semibold text-down">{num(t.declines, 0)} declines</span>
      </div>
    </div>
  );
}

function MoverList({ title, rows, icon }: { title: string; rows: Mover[]; icon: React.ReactNode }) {
  return (
    <Card className="motion-rise">
      <CardHeader title={<span className="flex items-center gap-2">{icon}{title}</span>} subtitle="Equities with at least ₹1 Cr traded" />
      <ul className="motion-stagger mt-3 divide-y divide-slate-100 dark:divide-slate-800">
        {rows.map((r) => (
          <li key={r.key}>
            <Link href={`/company/${encodeURIComponent(r.key)}`} className="flex items-center justify-between gap-3 px-5 py-2.5 transition hover:bg-slate-50 sm:px-6 dark:hover:bg-slate-800/40">
              <span className="min-w-0"><span className="block truncate text-sm font-semibold">{r.company}</span><span className="text-xs text-slate-500">{r.key} · {r.series}</span></span>
              <span className="tabular shrink-0 text-right text-sm"><span className="block font-semibold">{inr(r.close)}</span><Pct value={r.pct} className="text-xs" /></span>
            </Link>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function SummaryTab({ exchange }: { exchange: Exchange }) {
  const { data, error, loading, reload } = useApi<Summary>(`/api/v2/market/summary?exchange=${exchange}`);
  if (error && !data) return <Card><ErrorNote message={`Market summary could not load: ${error}`} onRetry={reload} /></Card>;
  if (!data) return <div className="space-y-4" role="status" aria-label="Loading market summary"><Skeleton className="h-32 w-full" /><Skeleton className="h-80 w-full" /></div>;
  const t = data.totals;
  return (
    <div className={clsx("space-y-5", loading && "is-refreshing")}>
      <div className="motion-stagger grid grid-cols-2 gap-3 lg:grid-cols-5">
        {[
          ["Turnover", <CountUp key="t" value={t.turnover_cr} format={(v) => inrCrore(v)} />],
          ["Volume (shares)", <CountUp key="v" value={t.volume} format={(v) => countIN(v)} />],
          ["Trades", <CountUp key="n" value={t.trades} format={(v) => countIN(v)} />],
          ["Securities traded", <CountUp key="s" value={t.securities} format={(v) => num(v, 0)} />],
          ["Advance / decline", `${num(t.advances / Math.max(1, t.declines), 2)}`],
        ].map(([label, value]) => (
          <div key={String(label)} className="hover-lift rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
            <p className="text-xs font-medium text-slate-500">{label}</p>
            <p className="tabular mt-1 text-xl font-semibold">{value}</p>
          </div>
        ))}
      </div>

      <div className="grid gap-5 xl:grid-cols-5">
        <Card className="motion-rise xl:col-span-3">
          <CardHeader title="Market summary" subtitle={`${exchange} equity and debt segments · session ${dateOnly(data.session)}`} />
          <CardBody className="pb-2"><Breadth t={t} /></CardBody>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <caption className="sr-only">Turnover by {exchange === "NSE" ? "series" : "group"}</caption>
              <thead><tr className="border-y border-slate-200 bg-slate-50/70 text-xs font-semibold text-slate-500 dark:border-slate-800 dark:bg-slate-800/40">
                <th scope="col" className="px-4 py-2.5 text-left">{exchange === "NSE" ? "Series" : "Group"}</th>
                <th scope="col" className="px-3 py-2.5 text-right">Securities</th><th scope="col" className="px-3 py-2.5 text-right">Adv / Dec</th>
                <th scope="col" className="px-3 py-2.5 text-right">Volume</th><th scope="col" className="px-3 py-2.5 text-right">Trades</th>
                <th scope="col" className="px-4 py-2.5 text-right">Turnover</th>
              </tr></thead>
              <tbody className="motion-stagger">
                {data.bySeries.map((s) => (
                  <tr key={s.series} className="border-b border-slate-100 transition hover:bg-slate-50 dark:border-slate-800/70 dark:hover:bg-slate-800/40">
                    <th scope="row" className="px-4 py-2.5 text-left font-normal">
                      <Link href={`/markets?tab=watch&exchange=${exchange}&series=${s.series}`} className="font-medium hover:text-indigo-700 dark:hover:text-indigo-300">{s.label}</Link>
                    </th>
                    <td className="tabular px-3 py-2.5 text-right">{num(s.securities, 0)}</td>
                    <td className="tabular px-3 py-2.5 text-right"><span className="text-up">{s.advances}</span> / <span className="text-down">{s.declines}</span></td>
                    <td className="tabular px-3 py-2.5 text-right">{countIN(s.volume)}</td>
                    <td className="tabular px-3 py-2.5 text-right">{s.trades ? countIN(s.trades) : "—"}</td>
                    <td className="tabular px-4 py-2.5 text-right font-semibold">{inrCrore(s.turnover_cr)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="px-5 py-3 text-xs text-slate-500 sm:px-6">Source: {data.source}.</p>
        </Card>

        <div className="space-y-5 xl:col-span-2">
          <Card className="motion-rise">
            <CardHeader title="Breadth, last 20 sessions" subtitle="Equities advancing vs declining" />
            <div className="px-3 pb-3 pt-2">
              <ResponsiveContainer width="100%" height={200}>
                <BarChart data={data.breadthHistory} margin={{ top: 6, right: 6, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="rgba(100,116,139,0.18)" />
                  <XAxis dataKey="trade_date" tickFormatter={(d: string) => d.slice(8) + "/" + d.slice(5, 7)} tick={{ fontSize: 10, fill: "#64748b" }} tickLine={false} axisLine={false} minTickGap={10} />
                  <YAxis width={36} tick={{ fontSize: 10, fill: "#64748b" }} tickLine={false} axisLine={false} />
                  <Tooltip cursor={{ fill: "rgba(99,102,241,0.06)" }} content={({ active, payload }) => {
                    if (!active || !payload?.length) return null;
                    const r = payload[0].payload as Summary["breadthHistory"][number];
                    return <ChartTooltipCard title={`${exchange} breadth`} heading={dateOnly(r.trade_date)} lines={[
                      { label: "Advances", value: num(r.advances, 0), color: "#10b981" }, { label: "Declines", value: num(r.declines, 0), color: "#f43f5e" },
                      { label: "Turnover", value: inrCrore(r.turnover_cr) },
                    ]} />;
                  }} />
                  <Bar dataKey="advances" stackId="a" fill="#10b981" isAnimationActive={false} />
                  <Bar dataKey="declines" stackId="a" fill="#f43f5e" radius={[3, 3, 0, 0]} isAnimationActive={false} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </Card>
          <Card className="motion-rise">
            <CardHeader title="Turnover trend" subtitle="Equity turnover per session · ₹ Crore" />
            <div className="px-3 pb-3 pt-2">
              <ResponsiveContainer width="100%" height={160}>
                <AreaChart data={data.breadthHistory} margin={{ top: 6, right: 6, left: 0, bottom: 0 }}>
                  <defs><linearGradient id="to" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stopColor="#6366f1" stopOpacity={0.35} /><stop offset="100%" stopColor="#6366f1" stopOpacity={0} /></linearGradient></defs>
                  <XAxis dataKey="trade_date" hide />
                  <YAxis width={44} tick={{ fontSize: 10, fill: "#64748b" }} tickLine={false} axisLine={false} tickFormatter={(v: number) => `${Math.round(v / 1000)}K`} />
                  <Tooltip content={({ active, payload }) => {
                    if (!active || !payload?.length) return null;
                    const r = payload[0].payload as Summary["breadthHistory"][number];
                    return <ChartTooltipCard heading={dateOnly(r.trade_date)} lines={[{ label: "Turnover", value: inrCrore(r.turnover_cr) }]} />;
                  }} />
                  <Area dataKey="turnover_cr" stroke="#6366f1" strokeWidth={2} fill="url(#to)" isAnimationActive={false} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </Card>
        </div>
      </div>

      <div className="grid gap-5 lg:grid-cols-3">
        <MoverList title="Top gainers" rows={data.gainers} icon={<ArrowUpRight size={18} className="text-up" />} />
        <MoverList title="Top losers" rows={data.losers} icon={<ArrowDownRight size={18} className="text-down" />} />
        <MoverList title="Most traded by value" rows={data.topTurnover.slice(0, 8)} icon={<Gauge size={18} className="text-indigo-600" />} />
      </div>
    </div>
  );
}

const SORTS: { key: string; label: string; align?: "right" }[] = [
  { key: "company", label: "Security" }, { key: "close", label: "LTP", align: "right" }, { key: "change", label: "Change", align: "right" },
  { key: "pct", label: "% Chg", align: "right" }, { key: "volume", label: "Volume", align: "right" }, { key: "turnover", label: "Turnover", align: "right" },
  { key: "trades", label: "Trades", align: "right" }, { key: "high52", label: "52W H / L", align: "right" }, { key: "mcap", label: "Mkt cap", align: "right" },
];

function WatchTab({ exchange }: { exchange: Exchange }) {
  const qp = useQueryParams(DEFAULTS);
  const [text, setText] = useState(qp.get("q"));
  const q = useDebounced(text.trim(), 300);
  useEffect(() => { if (q !== qp.get("q")) qp.set({ q }); }, [q]); // eslint-disable-line react-hooks/exhaustive-deps
  const path = `/api/v2/market/watch?${qp.toApi(["q", "index", "series", "move", "sort", "order", "page", "pageSize"], { exchange })}`;
  const { data, error, loading, reload } = useApi<Watch>(path);
  const page = Number(qp.get("page")) || 1;
  const pageSize = Number(qp.get("pageSize")) || 50;
  const pages = data ? Math.max(1, Math.ceil(data.total / pageSize)) : 1;
  const sort = qp.get("sort"), order = qp.get("order");
  const filtered = ["q", "index", "series", "move"].some((k) => qp.get(k));

  const clickSort = (key: string) => qp.set({ sort: key, order: sort === key && order === "desc" ? "asc" : "desc" });

  return (
    <Card className="motion-rise">
      <div className="flex flex-wrap items-end gap-3 px-5 pt-5 sm:px-6">
        <label className="flex min-w-56 flex-1 flex-col gap-1 text-xs font-medium text-slate-500">Search
          <span className="relative"><Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input value={text} onChange={(e) => setText(e.target.value)} placeholder={exchange === "NSE" ? "Company or NSE symbol" : "Company, BSE code or ticker"}
              className="w-full rounded-xl border border-slate-200 bg-white py-2 pl-9 pr-3 text-sm outline-none focus:border-indigo-400 dark:border-slate-700 dark:bg-slate-900" /></span>
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium text-slate-500">Index
          <select value={qp.get("index")} onChange={(e) => qp.set({ index: e.target.value })} className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-900">
            <option value="">All securities</option>
            {(data?.indices ?? []).map((i) => <option key={i.value} value={i.value}>{String(i.label)} ({i.members})</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium text-slate-500">{exchange === "NSE" ? "Series" : "Group"}
          <select value={qp.get("series")} onChange={(e) => qp.set({ series: e.target.value })} className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-900">
            <option value="">All</option><option value="EQUITY">Equities only</option>
            {(data?.series ?? []).slice(0, 25).map((s) => <option key={s.value} value={s.value}>{s.label} ({s.count})</option>)}
          </select>
        </label>
        <div className="flex flex-col gap-1 text-xs font-medium text-slate-500">Show
          <Segmented size="sm" value={qp.get("move")} onChange={(v) => qp.set({ move: v })} options={[
            { value: "", label: "All" }, { value: "gainers", label: "Gainers" }, { value: "losers", label: "Losers" },
            { value: "high52", label: "Near 52W high" }, { value: "low52", label: "Near 52W low" },
          ]} />
        </div>
        {filtered && <button onClick={() => { setText(""); qp.set({ q: null, index: null, series: null, move: null }); }} className="mb-1 inline-flex items-center gap-1 rounded-lg px-2 py-1.5 text-sm text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"><X size={14} /> Clear</button>}
      </div>
      <p className="px-5 pt-3 text-sm text-slate-500 sm:px-6">
        {data ? <><strong className="text-slate-900 dark:text-white">{num(data.total, 0)}</strong> securities · {exchange} session {dateOnly(data.session)}</> : "Loading…"}
      </p>
      {error && <ErrorNote message={`Market watch could not refresh: ${error}`} onRetry={reload} />}
      {!data && loading ? <Loading rows={12} /> : data && (
        <div className={clsx("mt-3 overflow-x-auto", loading && "is-refreshing")}>
          <table className="w-full text-sm">
            <thead><tr className="border-y border-slate-200 bg-slate-50/70 dark:border-slate-800 dark:bg-slate-800/40">
              {SORTS.map((s) => (
                <th key={s.key} scope="col" aria-sort={sort === s.key ? (order === "asc" ? "ascending" : "descending") : "none"}
                  className={clsx("whitespace-nowrap px-3 py-2.5 text-xs font-semibold", s.align === "right" ? "text-right" : "text-left")}>
                  <button onClick={() => clickSort(s.key)} className={clsx("inline-flex items-center gap-1 hover:text-slate-900 dark:hover:text-white", sort === s.key ? "text-indigo-700 dark:text-indigo-300" : "text-slate-500")}>
                    {s.label}{sort === s.key && (order === "asc" ? " ↑" : " ↓")}
                  </button>
                </th>
              ))}
            </tr></thead>
            <tbody>
              {data.items.length === 0 && <tr><td colSpan={SORTS.length} className="px-4 py-10 text-center text-slate-500">No securities match these filters.</td></tr>}
              {data.items.map((r) => (
                <tr key={`${r.key}-${r.series}`} className={clsx("border-b border-slate-100 transition hover:bg-slate-50 dark:border-slate-800/70 dark:hover:bg-slate-800/40", (r.pct ?? 0) > 0 ? "flash-up" : (r.pct ?? 0) < 0 ? "flash-down" : "")}>
                  <td className="max-w-[18rem] px-3 py-2">
                    <Link href={`/company/${encodeURIComponent(r.key)}${exchange === "BSE" ? "?exchange=BSE" : ""}`} className="block truncate font-semibold hover:text-indigo-700 dark:hover:text-indigo-300">{r.company}</Link>
                    <span className="text-xs text-slate-500">{exchange === "NSE" ? r.symbol : r.bseCode} · {r.series}</span>
                  </td>
                  <td className="tabular px-3 py-2 text-right font-semibold">{num(r.close)}</td>
                  <td className={clsx("tabular px-3 py-2 text-right", tone(r.change))}>{r.change > 0 ? "+" : ""}{num(r.change)}</td>
                  <td className="tabular px-3 py-2 text-right"><Pct value={r.pct} /></td>
                  <td className="tabular px-3 py-2 text-right">{compact(r.volume)}</td>
                  <td className="tabular px-3 py-2 text-right">{inrCrore(r.turnover_cr)}</td>
                  <td className="tabular px-3 py-2 text-right">{r.trades ? countIN(r.trades) : "—"}</td>
                  <td className="tabular whitespace-nowrap px-3 py-2 text-right text-xs">{r.high_52w != null ? `${num(r.high_52w)} / ${num(r.low_52w)}` : "—"}</td>
                  <td className="tabular px-3 py-2 text-right">{r.market_cap_cr != null ? inrCrore(r.market_cap_cr) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <Pagination page={page} pages={pages} total={data.total} pageSize={pageSize}
            onPage={(p) => qp.set({ page: String(p) })} onPageSize={(n) => qp.set({ pageSize: String(n) })} />
        </div>
      )}
    </Card>
  );
}

function MarketsInner() {
  const qp = useQueryParams(DEFAULTS);
  const tab = qp.get("tab") === "watch" ? "watch" : "summary";
  const exchange = (qp.get("exchange") === "BSE" ? "BSE" : "NSE") as Exchange;
  const { data: ticker } = useApi<{ nse: { items: { label: string; value: number; pct: number }[] }; bse: { items: { label: string; value: number; pct: number }[] } }>("/api/v2/market/ticker");
  const lead = useMemo(() => (exchange === "NSE" ? ticker?.nse.items : ticker?.bse.items) ?? [], [ticker, exchange]);

  return (
    <>
      <PageHero eyebrow={`${exchange} equities`} title={tab === "summary" ? "Market summary" : "Market watch"}
        subtitle={tab === "summary" ? "How the whole market traded in the last session: turnover, breadth, segments and the biggest movers."
          : "Every security that traded in the last session. Filter by index, series and direction; sort any column."}
        art={<MarketIllustration />}>
        <div className="flex flex-wrap gap-2">
          {lead.slice(0, 3).map((i) => <HeroStat key={i.label} label={i.label} value={<>{num(i.value)} <span className={clsx("text-xs", tone(i.pct))}>{pct(i.pct)}</span></>} />)}
        </div>
      </PageHero>

      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div role="tablist" aria-label="Market views" className="inline-flex rounded-2xl border border-slate-200 bg-white p-1 shadow-sm dark:border-slate-800 dark:bg-slate-900">
          {([["summary", "Market Summary", Gauge], ["watch", "Market Watch", ListFilter]] as const).map(([value, label, Icon]) => (
            <button key={value} role="tab" aria-selected={tab === value} onClick={() => qp.set({ tab: value, q: null, index: null, series: null, move: null })}
              className={clsx("inline-flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-semibold transition",
                tab === value ? "bg-indigo-600 text-white shadow" : "text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800")}>
              <Icon size={16} /> {label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2 text-xs font-medium text-slate-500">
          Exchange
          <Segmented value={exchange} onChange={(v) => qp.set({ exchange: v, index: null, series: null })} options={[{ value: "NSE", label: "NSE" }, { value: "BSE", label: "BSE" }]} />
          <Badge tone="brand">End of day</Badge>
        </div>
      </div>

      <div key={`${tab}-${exchange}`} className="motion-fade" role="tabpanel">
        {tab === "summary" ? <SummaryTab exchange={exchange} /> : <WatchTab exchange={exchange} />}
      </div>
    </>
  );
}

export default function MarketsPage() {
  return <Suspense fallback={<Skeleton className="h-96 w-full" />}><MarketsInner /></Suspense>;
}
