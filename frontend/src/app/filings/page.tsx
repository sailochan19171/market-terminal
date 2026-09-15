"use client";

import { ExternalLink, FileText, Search, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Pagination } from "@/components/DataTable";
import { Badge, Card, ErrorNote, Loading, PageTitle, Segmented } from "@/components/ui";
import { useApi } from "@/lib/api";
import { dateTime } from "@/lib/format";

interface Filing { id: string; company: string | null; title: string; dt: string; url: string | null; exchange: string; hasPage: boolean }
interface FilingsPage { total: number; page: number; pageSize: number; items: Filing[] }

const inputCls = "rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-indigo-400 dark:border-slate-700 dark:bg-slate-900";

export default function FilingsPage() {
  const [input, setInput] = useState("");
  const [q, setQ] = useState("");
  const [exchange, setExchange] = useState<"" | "nse" | "bse">("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);

  useEffect(() => { const t = setTimeout(() => setQ(input.trim()), 300); return () => clearTimeout(t); }, [input]);
  useEffect(() => { setPage(1); }, [q, exchange, from, to, pageSize]);

  const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
  if (q) params.set("q", q);
  if (exchange) params.set("exchange", exchange);
  if (from) params.set("from", from);
  if (to) params.set("to", to);
  const { data, error, loading, reload } = useApi<FilingsPage>(`/api/v2/filings?${params}`);
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const filtered = Boolean(q || exchange || from || to);

  return (
    <>
      <PageTitle title="Corporate filings" subtitle="Every announcement filed with NSE and BSE, newest first." />
      <Card>
        <div className="flex flex-wrap items-end gap-3 px-5 pt-5 sm:px-6">
          <label className="flex min-w-64 flex-1 flex-col gap-1 text-xs font-medium text-slate-500">
            Search
            <span className="relative">
              <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
              <input value={input} onChange={(e) => setInput(e.target.value)} placeholder="Subject, company or symbol, e.g. buyback, dividend, TCS"
                className={`${inputCls} w-full pl-9`} />
            </span>
          </label>
          <label className="flex flex-col gap-1 text-xs font-medium text-slate-500">From
            <input type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} className={inputCls} />
          </label>
          <label className="flex flex-col gap-1 text-xs font-medium text-slate-500">To
            <input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} className={inputCls} />
          </label>
          <div className="flex flex-col gap-1 text-xs font-medium text-slate-500">Exchange
            <Segmented size="sm" value={exchange} onChange={setExchange} options={[{ value: "", label: "Both" }, { value: "nse", label: "NSE" }, { value: "bse", label: "BSE" }]} />
          </div>
          {filtered && (
            <button onClick={() => { setInput(""); setExchange(""); setFrom(""); setTo(""); }}
              className="mb-1 inline-flex items-center gap-1 rounded-lg px-2 py-1.5 text-sm text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800">
              <X size={14} /> Clear filters
            </button>
          )}
        </div>
        <p className="px-5 pt-4 text-sm text-slate-500 sm:px-6">
          {data ? <><span className="font-semibold text-slate-900 dark:text-white">{data.total.toLocaleString("en-IN")}</span> filings{filtered ? " match" : ""}</> : "Loading…"}
        </p>
        {error && <ErrorNote message={error} onRetry={reload} />}
        {loading && !data ? <Loading rows={12} /> : (
          <ul className={`mt-3 divide-y divide-slate-100 transition-opacity dark:divide-slate-800 ${loading ? "opacity-60" : ""}`}>
            {(data?.items ?? []).length === 0 && <li className="px-6 py-12 text-center text-sm text-slate-500">No filings match these filters.</li>}
            {(data?.items ?? []).map((f, i) => (
              <li key={`${f.dt}-${f.id}-${i}`} className="flex items-start justify-between gap-4 px-5 py-3.5 sm:px-6">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={f.exchange === "NSE" ? "brand" : "up"}>{f.exchange}</Badge>
                    {f.hasPage
                      ? <Link href={`/company/${encodeURIComponent(f.id)}`} className="text-sm font-semibold hover:text-indigo-700 dark:hover:text-indigo-300">{f.company ?? f.id}</Link>
                      : <span className="text-sm font-semibold">{f.company ?? f.id}</span>}
                    <span className="text-xs text-slate-400">{f.id} · {dateTime(f.dt)}</span>
                  </div>
                  <p className="mt-1 text-sm text-slate-700 dark:text-slate-300">{f.title}</p>
                </div>
                {f.url && (
                  <a href={f.url} target="_blank" rel="noopener noreferrer"
                    className="flex shrink-0 items-center gap-1 rounded-lg border border-slate-200 px-2 py-1 text-xs font-medium text-slate-600 hover:border-indigo-300 hover:text-indigo-700 dark:border-slate-700 dark:text-slate-300">
                    <FileText size={13} /> PDF <ExternalLink size={11} />
                  </a>
                )}
              </li>
            ))}
          </ul>
        )}
        {data && <Pagination page={page} pages={pages} total={data.total} pageSize={pageSize} onPage={(p) => setPage(Math.max(1, Math.min(pages, p)))} onPageSize={setPageSize} />}
      </Card>
    </>
  );
}
