"use client";

import clsx from "clsx";
import { ArrowDownRight, ArrowUpRight, ExternalLink, FileText } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useMemo, useState } from "react";
import { TimeChart, type Bar } from "@/components/charts/TimeChart";
import { DataTable } from "@/components/DataTable";
import { CountUp, HeroStat, MarketIllustration, PageHero } from "@/components/Illustrations";
import { Heatmap } from "@/components/market/Heatmap";
import { LivePulse } from "@/components/market/LivePulse";
import { PageLoader } from "@/components/PageLoader";
import { MarketOverview } from "@/components/market/MarketOverview";
import { Card, CardBody, CardHeader, ErrorNote, Pct, Segmented, Skeleton } from "@/components/ui";
import { useApi } from "@/lib/api";
import { compact, dateOnly, dateTime, inrCrore, num, pct, signed, tone } from "@/lib/format";

interface Tile {
  index_name: string; display_name: string; trade_date: string; open: number; high: number; low: number;
  close: number; pts_change: number; pct_change: number; pe: number | null; pb: number | null; div_yield: number | null;
}
interface Mover { symbol: string; company: string; close: number; change: number; pct_1d: number; volume: number; turnover: number; market_cap_cr: number | null }
interface Home {
  asOf: string; priceDate: string; tiles: Tile[]; ticker: Mover[];
  snapshot: { gainers: Mover[]; losers: Mover[]; activeValue: Mover[]; activeVolume: Mover[] };
  breadth: { advances: number; declines: number; unchanged: number; new_highs: number; new_lows: number };
  marketCapLakhCr: number;
  announcements: { symbol: string; company: string; subject: string; details: string; ann_dt: string; pdf_url: string | null }[];
  counts: { companies: number; indices: number; filings: number };
}
interface IndexDetail { history: { trade_date: string; open: number; high: number; low: number; close: number; pe: number | null }[] }

const RANGES = [
  { value: "30", label: "1M" }, { value: "91", label: "3M" }, { value: "182", label: "6M" },
  { value: "365", label: "1Y" }, { value: "1095", label: "3Y" }, { value: "1826", label: "5Y" },
] as const;

type Tab = "gainers" | "losers" | "activeValue" | "activeVolume";

function IndexTiles({ tiles }: { tiles: Tile[] }) {
  return (
    <div className="no-scrollbar -mx-4 flex snap-x gap-3 overflow-x-auto px-4 pb-1 sm:mx-0 sm:px-0">
      {tiles.map((t) => (
        <Link key={t.index_name} href={`/indices/${encodeURIComponent(t.index_name)}`}
          className={clsx(
            "min-w-[180px] snap-start rounded-2xl border p-4 transition hover:-translate-y-0.5 hover:shadow-md",
            t.pct_change >= 0
              ? "border-emerald-100 bg-emerald-50/60 dark:border-emerald-500/20 dark:bg-emerald-500/5"
              : "border-rose-100 bg-rose-50/60 dark:border-rose-500/20 dark:bg-rose-500/5",
          )}>
          <p className="truncate text-xs font-semibold uppercase tracking-wide text-slate-500">{t.display_name}</p>
          <p className="tabular mt-2 text-lg font-semibold">{num(t.close)}</p>
          <p className={clsx("tabular mt-0.5 text-sm font-medium", tone(t.pct_change))}>
            {signed(t.pts_change)} ({pct(t.pct_change)})
          </p>
        </Link>
      ))}
    </div>
  );
}

function Ticker({ items }: { items: Mover[] }) {
  if (!items.length) return null;
  const loop = [...items, ...items];
  return (
    <div className="relative overflow-hidden rounded-2xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
      <div className="animate-ticker flex w-max gap-2 py-2.5">
        {loop.map((m, i) => (
          <Link key={`${m.symbol}-${i}`} href={`/company/${m.symbol}`}
            className="flex items-center gap-2 rounded-lg px-3 py-1 text-sm hover:bg-slate-50 dark:hover:bg-slate-800">
            <span className="font-semibold">{m.symbol}</span>
            <span className="tabular">{num(m.close)}</span>
            <span className={clsx("tabular text-xs font-medium", tone(m.pct_1d))}>{signed(m.change)} ({pct(m.pct_1d)})</span>
          </Link>
        ))}
      </div>
    </div>
  );
}

function HeadlineIndex({ tile }: { tile: Tile }) {
  const [range, setRange] = useState<string>("365");
  const { data, loading } = useApi<IndexDetail>(`/api/v2/indices/${encodeURIComponent(tile.index_name)}?days=${range}`);
  const bars: Bar[] = useMemo(() => (data?.history ?? []).map((h) => ({ t: h.trade_date, o: h.open, h: h.high, l: h.low, c: h.close })), [data]);

  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-4 px-5 pt-5 sm:px-6">
        <div>
          <Link href={`/indices/${encodeURIComponent(tile.index_name)}`} className="text-sm font-semibold text-indigo-700 hover:underline dark:text-indigo-300">
            {tile.display_name} →
          </Link>
          <div className="mt-1 flex items-baseline gap-3">
            <span className="tabular text-3xl font-semibold tracking-tight">{num(tile.close)}</span>
            <span className={clsx("tabular flex items-center gap-1 text-sm font-semibold", tone(tile.pct_change))}>
              {tile.pct_change >= 0 ? <ArrowUpRight size={16} /> : <ArrowDownRight size={16} />}
              {signed(tile.pts_change)} ({pct(tile.pct_change)})
            </span>
          </div>
          <p className="mt-1 text-xs text-slate-500">Close on {dateTime(tile.trade_date)}</p>
        </div>
        <dl className="grid grid-cols-3 gap-x-8 gap-y-1 text-sm sm:grid-cols-6">
          {[["Open", tile.open], ["High", tile.high], ["Low", tile.low], ["P/E", tile.pe], ["P/B", tile.pb], ["Div yield", tile.div_yield]].map(([k, v]) => (
            <div key={String(k)}>
              <dt className="text-xs text-slate-500">{k}</dt>
              <dd className="tabular font-semibold">{num(v as number)}</dd>
            </div>
          ))}
        </dl>
      </div>
      <div className="flex justify-end px-5 pt-4 sm:px-6">
        <Segmented size="sm" options={RANGES.map((r) => ({ value: r.value, label: r.label }))} value={range} onChange={setRange} />
      </div>
      <CardBody className="pt-2">
        {loading && !data ? <Skeleton className="h-[300px] w-full" /> : <TimeChart mode="area" bars={bars} showVolume={false} height={300} />}
      </CardBody>
    </Card>
  );
}

function Snapshot({ snapshot, priceDate }: { snapshot: Home["snapshot"]; priceDate: string }) {
  const [tab, setTab] = useState<Tab>("gainers");
  const rows = snapshot[tab];
  return (
    <Card>
      <CardHeader title="Market snapshot" subtitle={`NIFTY 50 constituents · ${dateTime(priceDate)}`}
        actions={<Link href="/market-data" className="text-sm font-medium text-indigo-700 hover:underline dark:text-indigo-300">All market data →</Link>} />
      <div className="px-5 pt-4 sm:px-6">
        <Segmented size="sm" value={tab} onChange={setTab} options={[
          { value: "gainers", label: "Gainers" }, { value: "losers", label: "Losers" },
          { value: "activeValue", label: "Most active (value)" }, { value: "activeVolume", label: "Most active (volume)" },
        ]} />
      </div>
      <div className="pt-3">
        <DataTable<Mover>
          pageSize={0}
          dense
          rows={rows}
          rowKey={(r) => r.symbol}
          columns={[
            { key: "symbol", label: "Symbol", render: (r) => <Link href={`/company/${r.symbol}`} className="font-semibold text-indigo-700 hover:underline dark:text-indigo-300">{r.symbol}</Link> },
            { key: "close", label: "LTP", align: "right", render: (r) => num(r.close) },
            { key: "change", label: "Change", align: "right", render: (r) => <span className={tone(r.change)}>{signed(r.change)}</span> },
            { key: "pct_1d", label: "% Change", align: "right", render: (r) => <Pct value={r.pct_1d} /> },
            { key: "volume", label: "Volume (lakh)", align: "right", render: (r) => num(r.volume / 1e5) },
            { key: "turnover", label: "Value (Cr)", align: "right", render: (r) => num(r.turnover / 1e7) },
          ]}
        />
      </div>
    </Card>
  );
}

function Breadth({ b, mcap }: { b: Home["breadth"]; mcap: number }) {
  const total = (b.advances || 0) + (b.declines || 0) + (b.unchanged || 0);
  const adv = total ? (b.advances / total) * 100 : 0;
  const dec = total ? (b.declines / total) * 100 : 0;
  return (
    <Card>
      <CardHeader title="Market breadth" subtitle={`${num(total, 0)} NSE equities`} />
      <CardBody>
        <div className="flex h-3 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
          <div className="bg-emerald-500" style={{ width: `${adv}%` }} />
          <div className="bg-slate-300 dark:bg-slate-600" style={{ width: `${100 - adv - dec}%` }} />
          <div className="bg-rose-500" style={{ width: `${dec}%` }} />
        </div>
        <div className="mt-3 grid grid-cols-3 text-center">
          <div><p className="tabular text-xl font-semibold text-up">{num(b.advances, 0)}</p><p className="text-xs text-slate-500">Advances</p></div>
          <div><p className="tabular text-xl font-semibold">{num(b.unchanged, 0)}</p><p className="text-xs text-slate-500">Unchanged</p></div>
          <div><p className="tabular text-xl font-semibold text-down">{num(b.declines, 0)}</p><p className="text-xs text-slate-500">Declines</p></div>
        </div>
        <div className="mt-5 grid grid-cols-3 gap-3 border-t border-slate-100 pt-4 dark:border-slate-800">
          <div><p className="tabular font-semibold">{num(b.new_highs, 0)}</p><p className="text-xs text-slate-500">At 52-week high</p></div>
          <div><p className="tabular font-semibold">{num(b.new_lows, 0)}</p><p className="text-xs text-slate-500">At 52-week low</p></div>
          <div><p className="tabular font-semibold">₹{num(mcap, 2)} L Cr</p><p className="text-xs text-slate-500">Market cap (listed)</p></div>
        </div>
      </CardBody>
    </Card>
  );
}

/** With `fill`, the card stretches to the height of the column beside it on wide screens and scrolls inside. */
function Announcements({ items, fill = false }: { items: Home["announcements"]; fill?: boolean }) {
  return (
    <Card className={fill ? "xl:flex xl:min-h-0 xl:flex-1 xl:flex-col" : undefined}>
      <CardHeader title="Corporate announcements" subtitle="Latest filings on NSE"
        actions={<Link href="/filings" className="text-sm font-medium text-indigo-700 hover:underline dark:text-indigo-300">All filings →</Link>} />
      <ul className={clsx("mt-3 max-h-[560px] divide-y divide-slate-100 overflow-y-auto dark:divide-slate-800", fill && "xl:max-h-none xl:min-h-0 xl:flex-1 xl:basis-0")}>
        {items.map((a, i) => (
          <li key={i} className="flex items-start justify-between gap-4 px-5 py-3.5 sm:px-6">
            <div className="min-w-0">
              <Link href={`/company/${a.symbol}`} className="text-sm font-semibold hover:text-indigo-700 dark:hover:text-indigo-300">
                {a.company} <span className="font-normal text-slate-500">({a.symbol})</span>
              </Link>
              <p className="mt-0.5 text-sm text-slate-600 dark:text-slate-300">{a.subject}</p>
              <p className="mt-1 text-xs text-slate-400">{dateTime(a.ann_dt)}</p>
            </div>
            {a.pdf_url && (
              <a href={a.pdf_url} target="_blank" rel="noopener noreferrer"
                className="flex shrink-0 items-center gap-1 rounded-lg border border-slate-200 px-2 py-1 text-xs font-medium text-slate-600 hover:border-indigo-300 hover:text-indigo-700 dark:border-slate-700 dark:text-slate-300">
                <FileText size={13} /> PDF <ExternalLink size={11} />
              </a>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}

interface SummaryLite { session: string; totals: { turnover_cr: number; advances: number; declines: number; securities: number; trades: number } }
interface TickerLite { bse: { items: { name: string; label: string; value: number; change: number; pct: number }[] } }

function HomeSkeleton() {
  return <PageLoader label="Loading Indian markets" detail="Indices, movers, breadth and filings from NSE and BSE." />;
}

function ExchangeSummaryCard({ exchange, summary }: { exchange: "NSE" | "BSE"; summary: SummaryLite | null }) {
  return (
    <Link href={`/markets?exchange=${exchange}`} className="hover-lift rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{exchange} market summary</p>
      {summary ? (
        <div className="mt-2 grid grid-cols-3 gap-3">
          <div><p className="text-xs text-slate-500">Turnover</p><p className="tabular font-semibold"><CountUp value={summary.totals.turnover_cr} format={(v) => inrCrore(v)} /></p></div>
          <div><p className="text-xs text-slate-500">Adv / Dec</p><p className="tabular font-semibold"><span className="text-up">{num(summary.totals.advances, 0)}</span> / <span className="text-down">{num(summary.totals.declines, 0)}</span></p></div>
          <div><p className="text-xs text-slate-500">Securities</p><p className="tabular font-semibold">{num(summary.totals.securities, 0)}</p></div>
        </div>
      ) : <Skeleton className="mt-2 h-10 w-full" />}
    </Link>
  );
}

function HomeInner() {
  const search = useSearchParams();
  const router = useRouter();
  const view = search.get("view") === "detailed" ? "detailed" : "summary";
  const { data, error, reload } = useApi<Home>("/api/v2/home");
  const nse = useApi<SummaryLite>("/api/v2/market/summary?exchange=NSE");
  const bse = useApi<SummaryLite>("/api/v2/market/summary?exchange=BSE");
  const ticker = useApi<TickerLite>("/api/v2/market/ticker");

  if (error && !data) return <Card><ErrorNote message={`Market data could not load: ${error}`} onRetry={reload} /></Card>;
  if (!data) return <HomeSkeleton />;

  const nifty = data.tiles.find((t) => t.index_name === "NIFTY 50") ?? data.tiles[0];
  const sensex = ticker.data?.bse.items.find((i) => i.name === "BSE SENSEX");
  const setView = (v: string) => router.replace(v === "summary" ? "/" : "/?view=detailed", { scroll: false });

  return (
    <div className="space-y-6">
      <PageHero eyebrow={`Session close · ${dateOnly(data.priceDate)}`} title="Indian markets today"
        subtitle={<>End-of-day data for {num(data.counts.companies, 0)} companies and {num(data.counts.indices, 0)} indices across NSE and BSE, with {compact(data.counts.filings)} exchange filings.</>}
        art={<MarketIllustration />}>
        <div className="flex flex-wrap gap-2">
          {nifty && <HeroStat label="NIFTY 50" value={<><CountUp value={nifty.close} format={(v) => num(v)} /> <span className={clsx("text-xs", tone(nifty.pct_change))}>{pct(nifty.pct_change)}</span></>} />}
          {sensex && <HeroStat label="SENSEX" value={<><CountUp value={sensex.value} format={(v) => num(v)} /> <span className={clsx("text-xs", tone(sensex.pct))}>{pct(sensex.pct)}</span></>} />}
          <HeroStat label="Advances / declines" value={<><span className="text-up">{num(data.breadth.advances, 0)}</span> / <span className="text-down">{num(data.breadth.declines, 0)}</span></>} />
          <HeroStat label="Market cap" value={<CountUp value={data.marketCapLakhCr * 1e5} format={(v) => inrCrore(v)} />} />
        </div>
      </PageHero>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div role="tablist" aria-label="Home view" className="inline-flex rounded-2xl border border-slate-200 bg-white p-1 shadow-sm dark:border-slate-800 dark:bg-slate-900">
          {[["summary", "Summary view"], ["detailed", "Detailed view"]].map(([v, label]) => (
            <button key={v} role="tab" aria-selected={view === v} onClick={() => setView(v)}
              className={clsx("rounded-xl px-4 py-2 text-sm font-semibold transition", view === v ? "bg-indigo-600 text-white shadow" : "text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800")}>
              {label}
            </button>
          ))}
        </div>
        <div className="flex gap-2 text-sm">
          <Link href="/markets" className="rounded-xl border border-slate-200 bg-white px-3 py-2 font-medium transition hover:border-indigo-300 dark:border-slate-700 dark:bg-slate-900">Market summary →</Link>
          <Link href="/markets?tab=watch" className="rounded-xl border border-slate-200 bg-white px-3 py-2 font-medium transition hover:border-indigo-300 dark:border-slate-700 dark:bg-slate-900">Market watch →</Link>
        </div>
      </div>

      <div key={view} className="motion-fade space-y-6" role="tabpanel">
        <IndexTiles tiles={data.tiles} />
        <Ticker items={data.ticker} />

        {view === "summary" ? (
          <>
            <div className="motion-stagger grid gap-3 lg:grid-cols-2">
              <ExchangeSummaryCard exchange="NSE" summary={nse.data} />
              <ExchangeSummaryCard exchange="BSE" summary={bse.data} />
            </div>
            <div className="grid gap-6 xl:grid-cols-5">
              <div className="space-y-6 xl:col-span-3">
                <Snapshot snapshot={data.snapshot} priceDate={data.priceDate} />
                <LivePulse />
              </div>
              <div className="flex flex-col gap-6 xl:col-span-2">
                <Breadth b={data.breadth} mcap={data.marketCapLakhCr} />
                <Announcements items={data.announcements} fill />
              </div>
            </div>
          </>
        ) : (
          <>
            <div className="grid gap-6 xl:grid-cols-3">
              <div className="xl:col-span-1"><MarketOverview height={600} /></div>
              <div className="xl:col-span-2"><Heatmap height={600} compact /></div>
            </div>
            <div className="grid gap-6 xl:grid-cols-5">
              <div className="space-y-6 xl:col-span-3">
                {nifty && <HeadlineIndex tile={nifty} />}
                <Snapshot snapshot={data.snapshot} priceDate={data.priceDate} />
              </div>
              <div className="space-y-6 xl:col-span-2">
                <Breadth b={data.breadth} mcap={data.marketCapLakhCr} />
                <Announcements items={data.announcements} />
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export default function HomePage() {
  return <Suspense fallback={<HomeSkeleton />}><HomeInner /></Suspense>;
}
