"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { SignedBars } from "@/components/charts/Categorical";
import { DataTable } from "@/components/DataTable";
import { Card, CardBody, CardHeader, ErrorNote, Loading, PageTitle, Pct, Segmented } from "@/components/ui";
import { useApi } from "@/lib/api";
import { dateTime, num, signed, tone } from "@/lib/format";

interface IndexRow {
  index_name: string; display_name: string; close: number; pts_change: number; pct_change: number;
  open: number; high: number; low: number; pe: number | null; pb: number | null; div_yield: number | null;
  ret_1y: number | null; high_52w: number | null; low_52w: number | null; turnover_cr: number | null; slug: string | null;
}

type Group = "all" | "broad" | "sector" | "strategy";

function group(name: string): Exclude<Group, "all"> {
  if (/^NIFTY (50|NEXT 50|100|200|500|MIDCAP|SMALLCAP|MICROCAP|LARGEMIDCAP|MIDSMALLCAP|TOTAL MARKET)/.test(name)) return "broad";
  if (/(BANK|IT$|AUTO|PHARMA|FMCG|METAL|REALTY|ENERGY|MEDIA|FINANCIAL|HEALTHCARE|CONSUMER|OIL|INFRA|COMMODITIES|PSE|CPSE|MNC|SERVICES|CHEMICALS|HOUSING|DEFENCE|TOURISM|RAILWAYS|CAPITAL MARKETS|MANUFACTURING|MOBILITY|INTERNET|DIGITAL|LOGISTICS|TRANSPORT)/.test(name)) return "sector";
  return "strategy";
}

export default function IndicesPage() {
  const { data, error, loading, reload } = useApi<{ asOf: string; indices: IndexRow[] }>("/api/v2/indices");
  const [g, setG] = useState<Group>("broad");
  const [q, setQ] = useState("");

  const rows = useMemo(() => (data?.indices ?? [])
    .filter((r) => g === "all" || group(r.index_name) === g)
    .filter((r) => !q || r.display_name.toLowerCase().includes(q.toLowerCase())), [data, g, q]);

  const movers = useMemo(() => [...(data?.indices ?? [])]
    .filter((r) => group(r.index_name) === "sector" && r.pct_change != null)
    .sort((a, b) => b.pct_change - a.pct_change).slice(0, 16), [data]);

  return (
    <>
      <PageTitle title="Indices" subtitle={data ? `${data.indices.length} NSE indices · close on ${dateTime(data.asOf)}` : "NSE indices"} />
      {error && <Card><ErrorNote message={error} onRetry={reload} /></Card>}
      {loading && !data && <Card><Loading rows={12} /></Card>}
      {data && (
        <div className="space-y-6">
          <Card>
            <CardHeader title="Sector indices today" subtitle="Percent change on the session" />
            <CardBody><SignedBars data={movers.map((m) => ({ name: m.display_name, pct: m.pct_change }))} labelKey="name" valueKey="pct" height={Math.max(260, movers.length * 26)} /></CardBody>
          </Card>

          <Card>
            <div className="flex flex-wrap items-center justify-between gap-3 px-5 pt-5 sm:px-6">
              <Segmented size="sm" value={g} onChange={setG} options={[
                { value: "broad", label: "Broad market" }, { value: "sector", label: "Sectoral" },
                { value: "strategy", label: "Thematic & strategy" }, { value: "all", label: "All" },
              ]} />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter indices"
                className="w-56 rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-sm outline-none focus:border-indigo-400 dark:border-slate-700 dark:bg-slate-900" />
            </div>
            <div className="pt-4">
              <DataTable<IndexRow> dense sortable pageSize={50} rows={rows} rowKey={(r) => r.index_name} initialSort={{ key: "pct_change", dir: "desc" }}
                columns={[
                  { key: "display_name", label: "Index", render: (r) => <Link href={`/indices/${encodeURIComponent(r.index_name)}`} className="font-semibold text-indigo-700 hover:underline dark:text-indigo-300">{r.display_name}</Link> },
                  { key: "close", label: "Last", align: "right", render: (r) => num(r.close) },
                  { key: "pts_change", label: "Change", align: "right", render: (r) => <span className={tone(r.pts_change)}>{signed(r.pts_change)}</span> },
                  { key: "pct_change", label: "% Chg", align: "right", render: (r) => <Pct value={r.pct_change} /> },
                  { key: "ret_1y", label: "1Y", align: "right", render: (r) => <Pct value={r.ret_1y} digits={1} /> },
                  { key: "high_52w", label: "52W high", align: "right", render: (r) => num(r.high_52w) },
                  { key: "low_52w", label: "52W low", align: "right", render: (r) => num(r.low_52w) },
                  { key: "pe", label: "P/E", align: "right", render: (r) => num(r.pe) },
                  { key: "pb", label: "P/B", align: "right", render: (r) => num(r.pb) },
                  { key: "div_yield", label: "Div yield", align: "right", render: (r) => num(r.div_yield) },
                ]} />
            </div>
          </Card>
        </div>
      )}
    </>
  );
}
