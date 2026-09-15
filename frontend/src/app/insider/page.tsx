"use client";

import { Search } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { DataTable, Pagination } from "@/components/DataTable";
import { Badge, Card, ErrorNote, Loading, PageTitle, Segmented } from "@/components/ui";
import { useApi } from "@/lib/api";
import { compact, dateTime } from "@/lib/format";

interface Trade { symbol: string; company: string | null; acquirer: string; security: string | null; broadcast: string; quantity: number | null; value: number | null; txn_type: string | null }
interface TradesPage { total: number; page: number; pageSize: number; items: Trade[] }

export default function InsiderPage() {
  const [input, setInput] = useState("");
  const [q, setQ] = useState("");
  const [side, setSide] = useState<"" | "buy" | "sell" | "pledge">("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);

  useEffect(() => { const t = setTimeout(() => setQ(input.trim()), 300); return () => clearTimeout(t); }, [input]);
  useEffect(() => { setPage(1); }, [q, side, pageSize]);

  const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
  if (q) params.set("q", q);
  if (side) params.set("side", side);
  const { data, error, loading, reload } = useApi<TradesPage>(`/api/v2/insider?${params}`);
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <>
      <PageTitle title="Insider trades" subtitle="Disclosures by promoters, directors and designated persons under SEBI insider trading rules." />
      <Card>
        <div className="flex flex-wrap items-center gap-3 px-5 pt-5 sm:px-6">
          <div className="relative w-full max-w-sm">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input value={input} onChange={(e) => setInput(e.target.value)} placeholder="Company, symbol or person"
              className="w-full rounded-xl border border-slate-200 bg-white py-2 pl-9 pr-3 text-sm outline-none focus:border-indigo-400 dark:border-slate-700 dark:bg-slate-900" />
          </div>
          <Segmented size="sm" value={side} onChange={setSide} options={[
            { value: "", label: "All" }, { value: "buy", label: "Buys" }, { value: "sell", label: "Sells" }, { value: "pledge", label: "Pledges" },
          ]} />
          {data && <span className="text-sm text-slate-500"><span className="font-semibold text-slate-900 dark:text-white">{data.total.toLocaleString("en-IN")}</span> disclosures</span>}
        </div>
        {error && <ErrorNote message={error} onRetry={reload} />}
        <div className={`pt-4 transition-opacity ${loading ? "opacity-60" : ""}`}>
          {loading && !data ? <Loading rows={12} /> : (
            <DataTable dense pageSize={0} rows={data?.items ?? []} rowKey={(r, i) => `${r.symbol}-${r.broadcast}-${i}`}
              numbered offset={(page - 1) * pageSize}
              empty="No disclosures match these filters."
              columns={[
                { key: "broadcast", label: "Disclosed", render: (r) => dateTime(r.broadcast) },
                { key: "symbol", label: "Company", render: (r) => (
                  <div><Link href={`/company/${encodeURIComponent(r.symbol)}`} className="font-semibold text-indigo-700 hover:underline dark:text-indigo-300">{r.symbol}</Link>
                    <p className="max-w-56 truncate text-xs text-slate-400">{r.company}</p></div>
                ) },
                { key: "acquirer", label: "Person", className: "whitespace-normal max-w-xs" },
                { key: "security", label: "Security", render: (r) => <span className="text-slate-500">{r.security ?? "—"}</span> },
                { key: "txn_type", label: "Type", render: (r) => {
                  const k = (r.txn_type ?? "").toLowerCase();
                  return <Badge tone={k.includes("buy") ? "up" : k.includes("sell") ? "down" : "slate"}>{r.txn_type ?? "—"}</Badge>;
                } },
                { key: "quantity", label: "Quantity", align: "right", render: (r) => compact(r.quantity) },
                { key: "value", label: "Value ₹", align: "right", render: (r) => compact(r.value) },
              ]} />
          )}
        </div>
        {data && <Pagination page={page} pages={pages} total={data.total} pageSize={pageSize} onPage={(p) => setPage(Math.max(1, Math.min(pages, p)))} onPageSize={setPageSize} />}
      </Card>
    </>
  );
}
