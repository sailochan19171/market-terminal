"use client";

import { RefreshCw } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useMemo, useState } from "react";
import { SignedBars, StackedBreadth } from "@/components/charts/Categorical";
import { DataTable, type Column } from "@/components/DataTable";
import { Button, Card, CardBody, CardHeader, ErrorNote, Loading, PageTitle, Pct, Segmented } from "@/components/ui";
import { api, useApi } from "@/lib/api";
import { compact, dateTime, num } from "@/lib/format";

type Row = Record<string, unknown>;
interface Live { key: string; title: string; note: string; columns: string[]; rows: Row[]; count: number; timestamp: string; error?: string }

const LABELS: Record<string, string> = {
  symbol: "Symbol", series: "Series", companyName: "Company", comapnyName: "Company", clientName: "Client",
  session: "Session", lastPrice: "LTP", ltp: "LTP", ltP: "LTP", price: "Price", open: "Open", dayHigh: "High",
  dayLow: "Low", previousClose: "Prev close", prev_price: "Prev close", change: "Change", chn: "Change",
  net_price: "Change", pChange: "% Chg", per: "% Chg", perChange: "% Chg", volume: "Volume", qty: "Qty",
  trade_quantity: "Qty", totalTradedVolume: "Volume", finalQuantity: "Qty", totalTurnover: "Turnover",
  trdVal: "Turnover", valueInCrores: "Value (Cr)", week1AvgVolume: "1W avg volume", week1Change: "vs 1W avg",
  new52WHL: "New 52W", prev52WHL: "Previous 52W", bandLimit: "Band", assets: "Underlying", nav: "NAV",
  buySell: "Side", latestOI: "OI", prevOI: "Prev OI", changeInOI: "OI change", avgInOI: "OI change %",
};
const PCT_KEYS = /^(pChange|per|perChange|avgInOI)$/;
const NUMERIC = /price|ltp|qty|quantity|volume|turnover|change|per|nav|oi|value|band|open|high|low|close|trdval|chn/i;

function isNumeric(v: unknown) {
  if (typeof v === "number") return true;
  return typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v.replace(/,/g, "")));
}

function LiveModule({ moduleKey }: { moduleKey: string }) {
  const { data, error, loading, reload } = useApi<Live>(`/api/live/${moduleKey}`);
  const [refreshing, setRefreshing] = useState(false);

  const columns: Column<Row>[] = useMemo(() => (data?.columns ?? []).map((c) => {
    const numeric = NUMERIC.test(c) && (data?.rows ?? []).slice(0, 5).some((r) => isNumeric(r[c]));
    return {
      key: c,
      label: LABELS[c] ?? c,
      align: numeric ? "right" : "left",
      sortValue: (r: Row) => (numeric ? Number(String(r[c] ?? "").replace(/,/g, "")) : String(r[c] ?? "")),
      render: (r: Row) => {
        const v = r[c];
        if (c === "symbol" && v) return <Link href={`/company/${v}`} className="font-semibold text-indigo-700 hover:underline dark:text-indigo-300">{String(v)}</Link>;
        if (v == null || v === "" || v === "-") return <span className="text-slate-300">—</span>;
        if (!numeric) return String(v);
        const n = Number(String(v).replace(/,/g, ""));
        if (PCT_KEYS.test(c)) return <Pct value={n} />;
        if (/volume|qty|quantity|turnover|trdval|oi$/i.test(c)) return compact(n);
        return num(n);
      },
    } as Column<Row>;
  }), [data]);

  const refresh = async () => {
    setRefreshing(true);
    try { await api(`/api/live/${moduleKey}?force=1`); } finally { setRefreshing(false); reload(); }
  };

  return (
    <>
      <PageTitle title={data?.title ?? "Market data"} subtitle={data?.note || (data?.timestamp ? `As of ${data.timestamp}` : undefined)}
        actions={<div className="flex gap-2">
          <Button href="/market-data">All modules</Button>
          <Button onClick={refresh} disabled={refreshing}><RefreshCw size={15} className={refreshing ? "animate-spin" : ""} /> Refresh</Button>
        </div>} />
      <Card>
        {error && <ErrorNote message={`Feed unavailable: ${error}`} onRetry={reload} />}
        {loading && !data ? <Loading rows={12} /> : data && (
          <>
            <CardHeader title={`${num(data.count, 0)} rows`} subtitle={data.timestamp ? `Exchange timestamp ${data.timestamp}` : "Most feeds only populate during market hours."} />
            <div className="pt-3">
              <DataTable numbered sortable dense searchable searchPlaceholder="Search symbol or company" rows={data.rows} rowKey={(_, i) => String(i)} columns={columns}
                empty="The exchange returned no rows for this feed. Many populate only while the market is open." />
            </div>
          </>
        )}
      </Card>
    </>
  );
}

function Breadth() {
  const [days, setDays] = useState("90");
  const { data, loading } = useApi<{ breadth: { trade_date: string; advances: number; declines: number; unchanged: number }[] }>(`/api/breadth?exchange=nse&days=${days}`);
  return (
    <>
      <PageTitle title="Advances & declines" subtitle="NSE equities, per session" actions={<Button href="/market-data">All modules</Button>} />
      <Card className="mb-6">
        <CardHeader title="Breadth" actions={<Segmented size="sm" value={days} onChange={setDays} options={[{ value: "30", label: "1M" }, { value: "90", label: "3M" }, { value: "365", label: "1Y" }]} />} />
        <CardBody>{loading && !data ? <Loading /> : <StackedBreadth data={data?.breadth ?? []} height={300} />}</CardBody>
      </Card>
      <Card>
        <DataTable dense sortable searchable searchPlaceholder="Search a date" rows={[...(data?.breadth ?? [])].reverse()} rowKey={(r) => r.trade_date} columns={[
          { key: "trade_date", label: "Session", render: (r) => dateTime(r.trade_date) },
          { key: "advances", label: "Advances", align: "right", render: (r) => <span className="text-up">{num(r.advances, 0)}</span> },
          { key: "declines", label: "Declines", align: "right", render: (r) => <span className="text-down">{num(r.declines, 0)}</span> },
          { key: "unchanged", label: "Unchanged", align: "right", render: (r) => num(r.unchanged, 0) },
          { key: "ratio", label: "A/D ratio", align: "right", sortValue: (r) => r.advances / Math.max(1, r.declines), render: (r) => num(r.advances / Math.max(1, r.declines)) },
        ]} />
      </Card>
    </>
  );
}

function Sectors() {
  const { data, loading } = useApi<{ sectors: { sector: string; members: number; avg_pct: number; turnover: number }[] }>("/api/sectors");
  return (
    <>
      <PageTitle title="Sector performance" subtitle="Average session move of each sector's companies" actions={<Button href="/market-data">All modules</Button>} />
      <Card className="mb-6"><CardBody>{loading && !data ? <Loading /> : <SignedBars data={data?.sectors ?? []} labelKey="sector" valueKey="avg_pct" height={Math.max(300, (data?.sectors.length ?? 10) * 28)} />}</CardBody></Card>
      <Card>
        <DataTable dense sortable searchable searchPlaceholder="Search sector" rows={data?.sectors ?? []} rowKey={(r) => r.sector} initialSort={{ key: "avg_pct", dir: "desc" }} columns={[
          { key: "sector", label: "Sector", render: (r) => <Link href={`/screens/custom?sector=${encodeURIComponent(r.sector)}`} className="font-medium text-indigo-700 hover:underline dark:text-indigo-300">{r.sector}</Link> },
          { key: "members", label: "Companies", align: "right", render: (r) => num(r.members, 0) },
          { key: "avg_pct", label: "Avg move", align: "right", render: (r) => <Pct value={r.avg_pct} /> },
          { key: "turnover", label: "Turnover", align: "right", render: (r) => compact(r.turnover) },
        ]} />
      </Card>
    </>
  );
}

interface Mover { id: string; name: string | null; close: number; prev_close: number; pct: number; volume: number | null; turnover: number | null }

function Movers({ exchange }: { exchange: "nse" | "bse" }) {
  const { data, loading } = useApi<{ day: string; gainers: Mover[]; losers: Mover[]; active: Mover[] }>(`/api/movers?exchange=${exchange}&limit=50`);
  const [tab, setTab] = useState<"gainers" | "losers" | "active">("gainers");
  const cols: Column<Mover>[] = [
    { key: "id", label: "Symbol", render: (r) => exchange === "nse"
      ? <Link href={`/company/${r.id}`} className="font-semibold text-indigo-700 hover:underline dark:text-indigo-300">{r.id}</Link>
      : <span className="font-semibold">{r.id}</span> },
    { key: "name", label: "Company", render: (r) => <span className="text-slate-500">{r.name ?? "—"}</span> },
    { key: "close", label: "Close", align: "right", render: (r) => num(r.close) },
    { key: "prev_close", label: "Prev close", align: "right", render: (r) => num(r.prev_close) },
    { key: "pct", label: "% Chg", align: "right", render: (r) => <Pct value={r.pct} /> },
    { key: "volume", label: "Volume", align: "right", render: (r) => compact(r.volume) },
    { key: "turnover", label: "Turnover", align: "right", render: (r) => compact(r.turnover) },
  ];
  return (
    <>
      <PageTitle title={`Top movers · ${exchange.toUpperCase()}`} subtitle={data?.day ? `Session ${dateTime(data.day)}` : undefined} actions={<Button href="/market-data">All modules</Button>} />
      <Card>
        <div className="px-5 pt-5 sm:px-6">
          <Segmented size="sm" value={tab} onChange={setTab} options={[{ value: "gainers", label: "Gainers" }, { value: "losers", label: "Losers" }, { value: "active", label: "Most active" }]} />
        </div>
        <div className="pt-3">{loading && !data ? <Loading rows={12} /> : <DataTable numbered dense sortable searchable searchPlaceholder="Search symbol or company" rows={data?.[tab] ?? []} rowKey={(r) => r.id} columns={cols} />}</div>
      </Card>
    </>
  );
}

export default function ModulePage() {
  const { module } = useParams<{ module: string }>();
  if (module === "breadth") return <Breadth />;
  if (module === "sectors") return <Sectors />;
  if (module === "movers-nse") return <Movers exchange="nse" />;
  if (module === "movers-bse") return <Movers exchange="bse" />;
  return <LiveModule moduleKey={module} />;
}
