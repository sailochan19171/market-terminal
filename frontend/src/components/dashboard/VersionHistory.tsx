"use client";

import clsx from "clsx";
import { ArrowRight, CalendarClock, Eye, GitCompare, Loader2, PlayCircle, X } from "lucide-react";
import { useState } from "react";
import { Pagination } from "@/components/DataTable";
import { Badge, Button, Card, CardBody, CardHeader, ErrorNote, Loading } from "@/components/ui";
import { ApiError, post, useApi } from "@/lib/api";
import { formatMetric, KIND_LABEL, type Dashboard, type VersionMeta } from "@/lib/dashboard";
import { dateOnly, dateTime, isNum, monthYear, pct, tone } from "@/lib/format";

interface Compare {
  a: VersionMeta; b: VersionMeta;
  metrics: { key: string; label: string; a: number | null; b: number | null; change: number | null; changePct: number | null }[];
  observations: { added: string[]; removed: string[] };
}

export function VersionHistory({ data, from, to, onView }: {
  data: Dashboard; from: string | null; to: string | null; onView: (id: number) => void;
}) {
  const key = data.identity.key;
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [filterByRange, setFilterByRange] = useState(false);
  const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
  if (filterByRange && from) params.set("from", from);
  if (filterByRange && to) params.set("to", to);
  const list = useApi<{ total: number; items: VersionMeta[] }>(`/api/v2/company/${encodeURIComponent(key)}/analyses?${params}`);

  const [asOf, setAsOf] = useState(to ?? "");
  const [busy, setBusy] = useState<"now" | "asof" | null>(null);
  const [notice, setNotice] = useState<{ tone: "ok" | "error"; text: string; id?: number } | null>(null);
  const [picked, setPicked] = useState<number[]>([]);
  const compare = useApi<Compare>(picked.length === 2 ? `/api/v2/analyses/compare?a=${Math.min(...picked)}&b=${Math.max(...picked)}` : null);

  const create = async (date: string | null) => {
    setBusy(date ? "asof" : "now");
    setNotice(null);
    try {
      const v = await post<VersionMeta & { unchanged: boolean }>(`/api/v2/company/${encodeURIComponent(key)}/analyses`, date ? { asOf: date, exchange: data.exchange } : { exchange: data.exchange });
      setNotice(v.unchanged
        ? { tone: "ok", text: `Nothing changed since analysis v${v.version} of ${dateOnly(v.analysis_date)}; no duplicate was stored.`, id: v.id }
        : { tone: "ok", text: `Saved analysis v${v.version} for ${dateOnly(v.analysis_date)}.`, id: v.id });
      list.reload();
    } catch (e) {
      setNotice({ tone: "error", text: e instanceof ApiError ? e.message : "The analysis could not be created. Is the API running?" });
    } finally {
      setBusy(null);
    }
  };

  const toggle = (id: number) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p.slice(-1), id]));
  const pages = list.data ? Math.max(1, Math.ceil(list.data.total / pageSize)) : 1;

  return (
    <div className="space-y-5">
      <Card className="motion-rise">
        <CardHeader title="Create an analysis" subtitle="Analyses are stored as versions and never overwrite earlier ones." />
        <CardBody className="flex flex-wrap items-end gap-4">
          <Button variant="primary" onClick={() => create(null)} disabled={busy !== null}>
            {busy === "now" ? <Loader2 size={15} className="animate-spin" /> : <PlayCircle size={15} />} Analyse latest data
          </Button>
          <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); if (asOf) create(asOf); }}>
            <label className="flex flex-col gap-1 text-xs font-medium text-slate-500">
              Reconstruct as of
              <input type="date" value={asOf} max={data.freshness.prices.latestStored ?? undefined} onChange={(e) => setAsOf(e.target.value)} required
                className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-900" />
            </label>
            <Button type="submit" disabled={busy !== null || !asOf}>
              {busy === "asof" ? <Loader2 size={15} className="animate-spin" /> : <CalendarClock size={15} />} Build point-in-time analysis
            </Button>
          </form>
          <p className="basis-full text-xs text-slate-500">
            A point-in-time analysis uses only prices up to that session and filings published by then, so it shows the picture as it stood on that date.
          </p>
          {notice && (
            <div role="status" className={clsx("motion-fade flex basis-full flex-wrap items-center justify-between gap-2 rounded-xl border px-3 py-2 text-sm",
              notice.tone === "ok" ? "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-200"
                : "border-rose-200 bg-rose-50 text-rose-800 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-200")}>
              <span>{notice.text}</span>
              {notice.id && <button onClick={() => onView(notice.id!)} className="inline-flex items-center gap-1 font-semibold underline underline-offset-2">Open <ArrowRight size={13} /></button>}
            </div>
          )}
        </CardBody>
      </Card>

      <Card className="motion-rise">
        <CardHeader title="Analysis history" subtitle={list.data ? `${list.data.total} stored ${list.data.total === 1 ? "analysis" : "analyses"} for ${data.identity.company}` : undefined}
          actions={<label className="flex items-center gap-2 text-xs text-slate-600 dark:text-slate-300">
            <input type="checkbox" className="accent-indigo-600" checked={filterByRange} onChange={(e) => { setFilterByRange(e.target.checked); setPage(1); }} />
            Only within {dateOnly(from)} – {dateOnly(to)}
          </label>} />
        {list.error && <ErrorNote message={list.error} onRetry={list.reload} />}
        {list.loading && !list.data ? <Loading rows={5} /> : (
          <div className={clsx("pt-3", list.loading && "is-refreshing")}>
            {list.data?.items.length === 0 ? (
              <p className="px-6 py-10 text-center text-sm text-slate-500">
                {filterByRange ? "No stored analyses fall in the selected date range." : "No analyses stored for this company yet. Create one above."}
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead><tr className="border-b border-slate-200 text-left text-xs font-semibold text-slate-500 dark:border-slate-800">
                    <th scope="col" className="px-4 py-2"><span className="sr-only">Compare</span><GitCompare size={14} aria-hidden /></th>
                    <th scope="col" className="px-3 py-2">Analysis date</th><th scope="col" className="px-3 py-2">Version</th>
                    <th scope="col" className="px-3 py-2">Type</th><th scope="col" className="px-3 py-2">Data period</th>
                    <th scope="col" className="px-3 py-2">Summary</th><th scope="col" className="px-3 py-2">Saved</th><th className="px-3 py-2" />
                  </tr></thead>
                  <tbody className="motion-stagger">
                    {list.data?.items.map((v) => (
                      <tr key={v.id} className={clsx("border-b border-slate-100 last:border-0 dark:border-slate-800/70", data.version?.id === v.id && "bg-indigo-50/60 dark:bg-indigo-500/10")}>
                        <td className="px-4 py-2.5"><input type="checkbox" aria-label={`Compare analysis v${v.version}`} className="accent-indigo-600" checked={picked.includes(v.id)} onChange={() => toggle(v.id)} /></td>
                        <td className="whitespace-nowrap px-3 py-2.5 font-semibold">{dateOnly(v.analysis_date)}</td>
                        <td className="px-3 py-2.5">v{v.version} <Badge>{v.exchange}</Badge></td>
                        <td className="px-3 py-2.5"><Badge tone={v.kind === "point_in_time" ? "amber" : "brand"}>{KIND_LABEL[v.kind]}</Badge></td>
                        <td className="whitespace-nowrap px-3 py-2.5 text-xs text-slate-500">Prices to {dateOnly(v.data_to)}<br />Results to {v.results_as_of ? monthYear(v.results_as_of) : "—"}</td>
                        <td className="max-w-md px-3 py-2.5 text-xs text-slate-600 dark:text-slate-300">{v.summary}</td>
                        <td className="whitespace-nowrap px-3 py-2.5 text-xs text-slate-500">{dateTime(v.created_at)}</td>
                        <td className="px-3 py-2.5 text-right">
                          <Button onClick={() => onView(v.id)} className="!px-2.5 !py-1 text-xs"><Eye size={14} /> View</Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {list.data && <Pagination page={page} pages={pages} total={list.data.total} pageSize={pageSize} onPage={setPage} onPageSize={(n) => { setPageSize(n); setPage(1); }} />}
          </div>
        )}
      </Card>

      {picked.length > 0 && (
        <Card className="motion-rise">
          <CardHeader title="Compare analyses" subtitle={picked.length < 2 ? "Tick one more analysis to compare." : undefined}
            actions={<Button variant="ghost" onClick={() => setPicked([])}><X size={14} /> Clear</Button>} />
          {compare.error && <ErrorNote message={compare.error} onRetry={compare.reload} />}
          {picked.length === 2 && (compare.loading && !compare.data ? <Loading rows={6} /> : compare.data && (
            <div className="overflow-x-auto pt-3">
              <table className="w-full text-sm">
                <thead><tr className="border-b border-slate-200 text-xs font-semibold text-slate-500 dark:border-slate-800">
                  <th scope="col" className="px-4 py-2 text-left">Metric</th>
                  <th scope="col" className="px-4 py-2 text-right">{dateOnly(compare.data.a.analysis_date)} (v{compare.data.a.version})</th>
                  <th scope="col" className="px-4 py-2 text-right">{dateOnly(compare.data.b.analysis_date)} (v{compare.data.b.version})</th>
                  <th scope="col" className="px-4 py-2 text-right">Change</th>
                </tr></thead>
                <tbody>
                  {compare.data.metrics.map((m) => (
                    <tr key={m.key} className="border-b border-slate-100 dark:border-slate-800/70">
                      <th scope="row" className="px-4 py-2 text-left font-normal text-slate-600 dark:text-slate-300">{m.label}</th>
                      <td className="tabular px-4 py-2 text-right">{isNum(m.a) ? formatMetric(m.key, m.a) : <span className="text-slate-400">Not available</span>}</td>
                      <td className="tabular px-4 py-2 text-right">{isNum(m.b) ? formatMetric(m.key, m.b) : <span className="text-slate-400">Not available</span>}</td>
                      <td className={clsx("tabular px-4 py-2 text-right text-xs font-semibold", tone(m.changePct))}>{isNum(m.changePct) ? pct(m.changePct, 1) : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {(compare.data.observations.added.length > 0 || compare.data.observations.removed.length > 0) && (
                <div className="grid gap-4 p-5 md:grid-cols-2 text-sm">
                  <div><p className="text-xs font-semibold uppercase text-slate-500">New observations</p><ul className="mt-1 list-disc pl-5">{compare.data.observations.added.map((t) => <li key={t}>{t}</li>)}</ul></div>
                  <div><p className="text-xs font-semibold uppercase text-slate-500">No longer true</p><ul className="mt-1 list-disc pl-5 text-slate-500">{compare.data.observations.removed.map((t) => <li key={t}>{t}</li>)}</ul></div>
                </div>
              )}
            </div>
          ))}
        </Card>
      )}
    </div>
  );
}
