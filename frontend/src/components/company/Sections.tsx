"use client";

import clsx from "clsx";
import { CheckCircle2, ExternalLink, FileText, XCircle } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { ChartTooltipCard, Donut, GroupedBars } from "@/components/charts/Categorical";
import { DataTable } from "@/components/DataTable";
import { Badge, Card, CardBody, CardHeader, ErrorNote, Loading, Pct, Segmented, Unavailable } from "@/components/ui";
import { useApi } from "@/lib/api";
import { compact, dateOnly, dateTime, monthYear, num } from "@/lib/format";

// --- peers -------------------------------------------------------------------
interface Peer {
  symbol: string; company: string; close: number | null; pe: number | null; market_cap_cr: number | null; div_yield: number | null;
  np_qtr_cr: number | null; qtr_profit_var: number | null; sales_qtr_cr: number | null; qtr_sales_var: number | null;
  net_margin_ttm: number | null; ret_1y: number | null;
}
interface PeersData { industry: string | null; peers: Peer[]; median: Partial<Peer> | null; industrySize: number }

export function Peers({ symbol }: { symbol: string }) {
  const { data, loading } = useApi<PeersData>(`/api/v2/company/${encodeURIComponent(symbol)}/peers`);
  const med = data?.median ?? {};
  const n = (v: number | null | undefined, d = 2) => num(v ?? null, d);
  return (
    <Card id="peers">
      <CardHeader title="Peer comparison"
        subtitle={data?.industry ? <>Sector: <Link className="font-medium text-indigo-700 hover:underline dark:text-indigo-300" href={`/screens/custom?sector=${encodeURIComponent(data.industry)}`}>{data.industry}</Link> · top {data.peers.length} of {data.industrySize} by market cap</> : undefined} />
      <div className="pt-3">
        {loading && !data ? <Loading /> : !data?.industry ? (
          <CardBody><Unavailable title="No sector classification" reason="Sector tags come from NSE index constituent lists, which cover roughly the 750 largest companies." /></CardBody>
        ) : (
          <DataTable<Peer>
            pageSize={0} numbered dense sortable rows={data.peers} rowKey={(r) => r.symbol}
            highlight={(r) => r.symbol === symbol}
            initialSort={{ key: "market_cap_cr", dir: "desc" }}
            columns={[
              { key: "company", label: "Company", render: (r) => <Link href={`/company/${r.symbol}`} className="font-medium text-indigo-700 hover:underline dark:text-indigo-300">{r.company ?? r.symbol}</Link> },
              { key: "close", label: "CMP ₹", align: "right", render: (r) => n(r.close) },
              { key: "pe", label: "P/E", align: "right", render: (r) => n(r.pe, 1) },
              { key: "market_cap_cr", label: "Mkt cap ₹ Cr", align: "right", render: (r) => n(r.market_cap_cr, 0) },
              { key: "div_yield", label: "Div yield %", align: "right", render: (r) => n(r.div_yield) },
              { key: "np_qtr_cr", label: "NP qtr ₹ Cr", align: "right", render: (r) => n(r.np_qtr_cr, 1) },
              { key: "qtr_profit_var", label: "Qtr profit var %", align: "right", render: (r) => <Pct value={r.qtr_profit_var} digits={1} /> },
              { key: "sales_qtr_cr", label: "Sales qtr ₹ Cr", align: "right", render: (r) => n(r.sales_qtr_cr, 1) },
              { key: "qtr_sales_var", label: "Qtr sales var %", align: "right", render: (r) => <Pct value={r.qtr_sales_var} digits={1} /> },
              { key: "ret_1y", label: "1Y return", align: "right", render: (r) => <Pct value={r.ret_1y} digits={1} /> },
            ]}
            footer={
              <tr className="border-t-2 border-slate-200 bg-slate-50/70 text-sm font-semibold dark:border-slate-700 dark:bg-slate-800/40">
                <td className="px-3 py-2.5" />
                <td className="px-3 py-2.5">Median of {data.peers.length}</td>
                <td className="tabular px-3 py-2.5 text-right">{n(med.close)}</td>
                <td className="tabular px-3 py-2.5 text-right">{n(med.pe, 1)}</td>
                <td className="tabular px-3 py-2.5 text-right">{n(med.market_cap_cr, 0)}</td>
                <td className="tabular px-3 py-2.5 text-right">{n(med.div_yield)}</td>
                <td className="tabular px-3 py-2.5 text-right">{n(med.np_qtr_cr, 1)}</td>
                <td className="tabular px-3 py-2.5 text-right">{n(med.qtr_profit_var, 1)}</td>
                <td className="tabular px-3 py-2.5 text-right">{n(med.sales_qtr_cr, 1)}</td>
                <td className="tabular px-3 py-2.5 text-right">{n(med.qtr_sales_var, 1)}</td>
                <td className="tabular px-3 py-2.5 text-right">{n(med.ret_1y, 1)}</td>
              </tr>
            }
          />
        )}
      </div>
    </Card>
  );
}

// --- documents -----------------------------------------------------------------
interface Docs {
  announcements: { title: string; details: string | null; dt: string; url: string | null; source: string }[];
  investorMeets: Docs["announcements"];
  results: { period_end: string; consolidated: string; audited: string | null; broadcast_dt: string | null; xbrl_url: string | null }[];
  boardMeetings: { meeting_dt: string; purpose: string | null; description: string | null }[];
  corporateActions: { purpose: string; ex_date: string; record_date: string; source: string }[];
  insider: { broadcast: string; acquirer: string; security: string | null; quantity: number | null; value: number | null; txn_type: string | null }[];
}

type DocTab = "announcements" | "meets" | "results" | "board" | "actions" | "insider";

export function Documents({ symbol, from, to }: { symbol: string; from?: string | null; to?: string | null }) {
  const params = new URLSearchParams();
  if (from) params.set("from", from);
  if (to) params.set("to", to);
  const { data, loading, error, reload } = useApi<Docs>(`/api/v2/company/${encodeURIComponent(symbol)}/documents${params.size ? `?${params}` : ""}`);
  const [tab, setTab] = useState<DocTab>("announcements");
  const [q, setQ] = useState("");

  const filtered = (data?.[tab === "meets" ? "investorMeets" : "announcements"] ?? [])
    .filter((a) => !q || `${a.title} ${a.details}`.toLowerCase().includes(q.toLowerCase()));

  const counts: Record<DocTab, number> = {
    announcements: data?.announcements.length ?? 0, meets: data?.investorMeets.length ?? 0,
    results: data?.results.length ?? 0, board: data?.boardMeetings.length ?? 0,
    actions: data?.corporateActions.length ?? 0, insider: data?.insider.length ?? 0,
  };

  return (
    <Card id="documents">
      <CardHeader title="Documents" subtitle={from || to ? `Exchange filings from NSE and BSE, ${from ? dateOnly(from) : "start"} – ${to ? dateOnly(to) : "today"}` : "Exchange filings from NSE and BSE"} />
      {error && <ErrorNote message={`Filings could not load: ${error}`} onRetry={reload} />}
      <div className="flex flex-wrap items-center justify-between gap-3 px-5 pt-4 sm:px-6">
        <Segmented size="sm" value={tab} onChange={setTab} options={[
          { value: "announcements", label: `Announcements (${counts.announcements})` },
          { value: "meets", label: `Investor meets (${counts.meets})` },
          { value: "results", label: `Result filings (${counts.results})` },
          { value: "board", label: `Board meetings (${counts.board})` },
          { value: "actions", label: `Corporate actions (${counts.actions})` },
          { value: "insider", label: `Insider trades (${counts.insider})` },
        ]} />
        {(tab === "announcements" || tab === "meets") && (
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search filings"
            className="w-56 rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-sm outline-none focus:border-indigo-400 dark:border-slate-700 dark:bg-slate-900" />
        )}
      </div>
      <div className="pt-3">
        {loading && !data ? <Loading /> : (
          <>
            {(tab === "announcements" || tab === "meets") && (
              filtered.length === 0 ? <CardBody><Unavailable title="No filings" reason={q ? "Nothing matches this search." : "No announcements were filed in this period."} /></CardBody> : (
                <ul className="max-h-[520px] divide-y divide-slate-100 overflow-y-auto dark:divide-slate-800">
                  {filtered.map((a, i) => (
                    <li key={i} className="flex items-start justify-between gap-4 px-5 py-3 sm:px-6">
                      <div className="min-w-0">
                        <p className="text-sm font-medium">{a.title}</p>
                        {a.details && a.details !== a.title && <p className="mt-0.5 line-clamp-2 text-sm text-slate-500">{a.details}</p>}
                        <p className="mt-1 flex items-center gap-2 text-xs text-slate-400"><Badge>{a.source}</Badge>{dateTime(a.dt)}</p>
                      </div>
                      {a.url && <a href={a.url} target="_blank" rel="noopener noreferrer" className="flex shrink-0 items-center gap-1 rounded-lg border border-slate-200 px-2 py-1 text-xs font-medium text-slate-600 hover:border-indigo-300 hover:text-indigo-700 dark:border-slate-700 dark:text-slate-300"><FileText size={13} /> PDF <ExternalLink size={11} /></a>}
                    </li>
                  ))}
                </ul>
              ))}
            {tab === "results" && (
              <DataTable dense searchable searchPlaceholder="Search result filings" rows={data?.results ?? []} rowKey={(r, i) => `${r.period_end}-${r.consolidated}-${i}`} columns={[
                { key: "period_end", label: "Quarter", render: (r) => monthYear(r.period_end) },
                { key: "consolidated", label: "Basis" },
                { key: "audited", label: "Audit", render: (r) => r.audited ?? "—" },
                { key: "broadcast_dt", label: "Filed", render: (r) => dateTime(r.broadcast_dt) },
                { key: "xbrl_url", label: "Document", align: "right", render: (r) => r.xbrl_url ? <a href={r.xbrl_url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-indigo-600 hover:underline dark:text-indigo-300">XBRL <ExternalLink size={11} /></a> : "—" },
              ]} />
            )}
            {tab === "board" && (
              <DataTable dense searchable searchPlaceholder="Search board meetings" rows={data?.boardMeetings ?? []} rowKey={(r, i) => `${r.meeting_dt}-${i}`} columns={[
                { key: "meeting_dt", label: "Date", render: (r) => dateOnly(r.meeting_dt) },
                { key: "purpose", label: "Purpose", render: (r) => r.purpose ?? "—" },
                { key: "description", label: "Details", className: "whitespace-normal max-w-xl text-slate-500", render: (r) => r.description ?? "—" },
              ]} />
            )}
            {tab === "actions" && (
              <DataTable dense searchable searchPlaceholder="Search corporate actions" rows={data?.corporateActions ?? []} rowKey={(r, i) => `${r.ex_date}-${r.purpose}-${i}`} columns={[
                { key: "ex_date", label: "Ex-date", render: (r) => dateOnly(r.ex_date) },
                { key: "purpose", label: "Action", className: "whitespace-normal" },
                { key: "record_date", label: "Record date", render: (r) => dateOnly(r.record_date || null) },
                { key: "source", label: "Exchange", render: (r) => <Badge>{r.source}</Badge> },
              ]} />
            )}
            {tab === "insider" && (
              <DataTable dense searchable searchPlaceholder="Search insider trades" rows={data?.insider ?? []} rowKey={(r, i) => `${r.broadcast}-${i}`} columns={[
                { key: "broadcast", label: "Disclosed", render: (r) => dateTime(r.broadcast) },
                { key: "acquirer", label: "Person", className: "whitespace-normal" },
                { key: "txn_type", label: "Type", render: (r) => r.txn_type ?? "—" },
                { key: "quantity", label: "Quantity", align: "right", render: (r) => compact(r.quantity) },
                { key: "value", label: "Value ₹", align: "right", render: (r) => compact(r.value) },
              ]} />
            )}
          </>
        )}
      </div>
    </Card>
  );
}

