"use client";

import clsx from "clsx";
import { ArrowRight, CheckCircle2, Layers, Search, X } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { Pagination } from "@/components/DataTable";
import { Badge, Card, CardBody, ErrorNote, PageTitle, Segmented, Skeleton } from "@/components/ui";
import { useApi, useDebounced } from "@/lib/api";
import { KIND_LABEL, type VersionMeta } from "@/lib/dashboard";
import { dateOnly, dateTime, monthYear } from "@/lib/format";

interface AnalysesPage {
  total: number; page: number; pageSize: number; items: VersionMeta[];
  stats: { companies: number; versions: number; last_updated: string | null };
}

const inputCls = "rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-indigo-400 dark:border-slate-700 dark:bg-slate-900";

function AnalysesList() {
  const search = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const get = (k: string, d = "") => search.get(k) ?? d;

  const [text, setText] = useState(get("q"));
  const q = useDebounced(text.trim(), 300);
  const page = Number(get("page", "1")) || 1;
  const pageSize = Number(get("pageSize", "20")) || 20;

  const set = (changes: Record<string, string | null>) => {
    const next = new URLSearchParams(search.toString());
    for (const [k, v] of Object.entries(changes)) (v ? next.set(k, v) : next.delete(k));
    if (!("page" in changes)) next.delete("page");
    router.replace(`${pathname}${next.size ? `?${next}` : ""}`, { scroll: false });
  };
  useEffect(() => { if (q !== get("q")) set({ q: q || null }); }, [q]); // eslint-disable-line react-hooks/exhaustive-deps

  const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize), latest: get("latest", "1") });
  for (const k of ["q", "exchange", "from", "to", "kind"]) if (get(k)) params.set(k, get(k));
  const { data, error, loading, reload } = useApi<AnalysesPage>(`/api/v2/analyses?${params}`);
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const filtered = ["q", "exchange", "from", "to", "kind"].some((k) => get(k));

  return (
    <>
      <PageTitle title="Completed analyses"
        subtitle={data ? `${data.stats.companies.toLocaleString("en-IN")} companies · ${data.stats.versions.toLocaleString("en-IN")} stored analyses · last updated ${dateTime(data.stats.last_updated)}` : "Stored analyses for every company"} />

      <Card className="mb-5">
        <CardBody className="flex flex-wrap items-end gap-3">
          <label className="flex min-w-64 flex-1 flex-col gap-1 text-xs font-medium text-slate-500">Company
            <span className="relative">
              <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
              <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Name, NSE symbol or BSE code" className={`${inputCls} w-full pl-9`} />
            </span>
          </label>
          <label className="flex flex-col gap-1 text-xs font-medium text-slate-500">Analysis date from
            <input type="date" value={get("from")} max={get("to") || undefined} onChange={(e) => set({ from: e.target.value || null })} className={inputCls} />
          </label>
          <label className="flex flex-col gap-1 text-xs font-medium text-slate-500">to
            <input type="date" value={get("to")} min={get("from") || undefined} onChange={(e) => set({ to: e.target.value || null })} className={inputCls} />
          </label>
          <div className="flex flex-col gap-1 text-xs font-medium text-slate-500">Exchange
            <Segmented size="sm" value={get("exchange")} onChange={(v) => set({ exchange: v || null })}
              options={[{ value: "", label: "Both" }, { value: "NSE", label: "NSE" }, { value: "BSE", label: "BSE" }]} />
          </div>
          <label className="flex flex-col gap-1 text-xs font-medium text-slate-500">Type
            <select value={get("kind")} onChange={(e) => set({ kind: e.target.value || null })} className={inputCls}>
              <option value="">All types</option>
              {Object.entries(KIND_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
          </label>
          <div className="flex flex-col gap-1 text-xs font-medium text-slate-500">Show
            <Segmented size="sm" value={get("latest", "1")} onChange={(v) => set({ latest: v === "1" ? null : v })}
              options={[{ value: "1", label: "Latest per company" }, { value: "0", label: "Every version" }]} />
          </div>
          {filtered && (
            <button onClick={() => { setText(""); router.replace(pathname, { scroll: false }); }}
              className="mb-1 inline-flex items-center gap-1 rounded-lg px-2 py-1.5 text-sm text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800">
              <X size={14} /> Clear filters
            </button>
          )}
        </CardBody>
      </Card>

      {error && <Card className="mb-5"><ErrorNote message={`Analyses could not load: ${error}`} onRetry={reload} /></Card>}

      {!data && loading ? (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3" role="status" aria-label="Loading analyses">
          {Array.from({ length: 6 }).map((_, i) => <Card key={i}><CardBody><Skeleton className="h-5 w-48" /><Skeleton className="mt-3 h-4 w-full" /><Skeleton className="mt-2 h-4 w-2/3" /></CardBody></Card>)}
        </div>
      ) : data && data.items.length === 0 ? (
        <Card><CardBody className="py-12 text-center">
          <Layers className="mx-auto text-slate-300" size={32} />
          <p className="mt-3 text-sm font-semibold">No analyses match these filters</p>
          <p className="mt-1 text-sm text-slate-500">Analyses are created automatically for tracked companies, or on demand from any company's Analysis history tab.</p>
        </CardBody></Card>
      ) : data && (
        <div className={clsx(loading && "is-refreshing")}>
          <ul className="motion-stagger grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {data.items.map((v) => (
              <li key={v.id}>
                <Card className="hover-lift flex h-full flex-col">
                  <CardBody className="flex flex-1 flex-col gap-3">
                    <div className="flex w-full items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-semibold">{v.company}</p>
                        <div className="mt-1 flex flex-wrap gap-1">
                          {v.symbol && <Badge tone="brand">NSE {v.symbol}</Badge>}
                          {v.bse_code && <Badge tone="up">BSE {v.bse_code}</Badge>}
                        </div>
                      </div>
                      <span className="shrink-0"><Badge tone="up"><CheckCircle2 size={11} className="mr-1" /> Completed</Badge></span>
                    </div>
                    <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
                      <dt className="text-slate-500">Analysis date</dt><dd className="font-semibold">{dateOnly(v.analysis_date)}</dd>
                      <dt className="text-slate-500">Version</dt><dd>v{v.version}{v.versions && v.versions > 1 ? ` of ${v.versions}` : ""} · {KIND_LABEL[v.kind]} · {v.exchange}</dd>
                      <dt className="text-slate-500">Data period</dt><dd>{dateOnly(v.data_from)} – {dateOnly(v.data_to)}</dd>
                      <dt className="text-slate-500">Results to</dt><dd>{v.results_as_of ? monthYear(v.results_as_of) : "Not available"}</dd>
                      <dt className="text-slate-500">Last updated</dt><dd>{dateTime(v.updated_at)}</dd>
                    </dl>
                    <p className="flex-1 text-xs leading-relaxed text-slate-600 dark:text-slate-300">{v.summary}</p>
                    <Link href={`/company/${encodeURIComponent(v.company_key)}?version=${v.id}`}
                      className="inline-flex items-center justify-center gap-1.5 rounded-xl bg-indigo-600 px-3 py-2 text-sm font-semibold text-white transition hover:bg-indigo-500">
                      View analysis <ArrowRight size={15} />
                    </Link>
                  </CardBody>
                </Card>
              </li>
            ))}
          </ul>
          <Card className="mt-4">
            <Pagination page={page} pages={pages} total={data.total} pageSize={pageSize}
              onPage={(p) => set({ page: String(p) })} onPageSize={(n) => set({ pageSize: String(n), page: null })} />
          </Card>
        </div>
      )}
    </>
  );
}

export default function AnalysesPage() {
  return <Suspense fallback={<Skeleton className="h-96 w-full" />}><AnalysesList /></Suspense>;
}
