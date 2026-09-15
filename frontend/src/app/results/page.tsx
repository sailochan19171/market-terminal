"use client";

import clsx from "clsx";
import { ExternalLink, Search, X } from "lucide-react";
import Link from "next/link";
import { Suspense, useEffect, useState } from "react";
import { Pagination } from "@/components/DataTable";
import { CountUp, HeroStat, PageHero, ResultsIllustration } from "@/components/Illustrations";
import { Card, ErrorNote, Loading, Pct, Segmented, Skeleton } from "@/components/ui";
import { useApi, useDebounced } from "@/lib/api";
import { dateTime, inr, inrCrore, monthYear, num, percent } from "@/lib/format";
import { useQueryParams } from "@/lib/query";

interface Row {
  symbol: string; company: string; industry: string | null; basis: string; filed_at: string | null; revenue_cr: number | null;
  profit_cr: number | null; eps: number | null; npm: number | null; revenue_yoy: number | null; profit_yoy: number | null;
  close: number | null; pe: number | null; market_cap_cr: number | null;
}
interface Results {
  quarter: string; priorQuarter: string; quarters: { period_end: string; companies: number }[]; sectors: string[];
  stats: { reported: number; profit_up: number; profit_down: number; losses: number; revenue_cr: number; profit_cr: number };
  total: number; page: number; pageSize: number; items: Row[];
}

const DEFAULTS = { sort: "filed_at", order: "desc", basis: "preferred", page: "1", pageSize: "25" };
const COLS = [
  ["company", "Company", false], ["filed_at", "Filed", true], ["revenue", "Revenue", true], ["revenue_yoy", "YoY", true],
  ["profit", "Net profit", true], ["profit_yoy", "YoY", true], ["npm", "Net margin", true], ["eps", "EPS", false], ["mcap", "Mkt cap", true],
] as const;

function ResultsInner() {
  const qp = useQueryParams(DEFAULTS);
  const [text, setText] = useState(qp.get("q"));
  const q = useDebounced(text.trim(), 300);
  useEffect(() => { if (q !== qp.get("q")) qp.set({ q }); }, [q]); // eslint-disable-line react-hooks/exhaustive-deps
  const { data, error, loading, reload } = useApi<Results>(`/api/v2/results?${qp.toApi(["quarter", "basis", "q", "sector", "profit", "sort", "order", "page", "pageSize"])}`);
  const page = Number(qp.get("page")) || 1, pageSize = Number(qp.get("pageSize")) || 25;
  const sort = qp.get("sort"), order = qp.get("order");
  const s = data?.stats;

  return (
    <>
      <PageHero eyebrow="Corporates" title="Financial results"
        subtitle={data ? `Quarter ended ${monthYear(data.quarter)}: figures parsed from each company's XBRL filing, compared with the same quarter a year earlier.` : "Latest quarterly results parsed from exchange filings."}
        art={<ResultsIllustration />}>
        {s && (
          <div className="flex flex-wrap gap-2">
            <HeroStat label="Companies reported" value={<CountUp value={s.reported} format={(v) => num(v, 0)} />} />
            <HeroStat label="Profit up YoY" value={<CountUp value={s.profit_up} format={(v) => num(v, 0)} />} tone="up" />
            <HeroStat label="Profit down YoY" value={<CountUp value={s.profit_down} format={(v) => num(v, 0)} />} tone="down" />
            <HeroStat label="Combined net profit" value={inrCrore(s.profit_cr)} />
          </div>
        )}
      </PageHero>

      <Card className="motion-rise">
        <div className="flex flex-wrap items-end gap-3 px-5 pt-5 sm:px-6">
          <label className="flex flex-col gap-1 text-xs font-medium text-slate-500">Quarter
            <select value={qp.get("quarter") || data?.quarter || ""} onChange={(e) => qp.set({ quarter: e.target.value })} className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-900">
              {(data?.quarters ?? []).map((x) => <option key={x.period_end} value={x.period_end}>{monthYear(x.period_end)} ({x.companies})</option>)}
            </select>
          </label>
          <label className="flex min-w-56 flex-1 flex-col gap-1 text-xs font-medium text-slate-500">Company
            <span className="relative"><Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
              <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Name or NSE symbol" className="w-full rounded-xl border border-slate-200 bg-white py-2 pl-9 pr-3 text-sm outline-none focus:border-indigo-400 dark:border-slate-700 dark:bg-slate-900" /></span>
          </label>
          <label className="flex flex-col gap-1 text-xs font-medium text-slate-500">Sector
            <select value={qp.get("sector")} onChange={(e) => qp.set({ sector: e.target.value })} className="max-w-56 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-900">
              <option value="">All sectors</option>{(data?.sectors ?? []).map((x) => <option key={x}>{x}</option>)}
            </select>
          </label>
          <div className="flex flex-col gap-1 text-xs font-medium text-slate-500">Profit
            <Segmented size="sm" value={qp.get("profit")} onChange={(v) => qp.set({ profit: v })} options={[
              { value: "", label: "All" }, { value: "up", label: "Growing" }, { value: "down", label: "Falling" },
              { value: "loss", label: "Loss" }, { value: "turnaround", label: "Turnaround" },
            ]} />
          </div>
          <div className="flex flex-col gap-1 text-xs font-medium text-slate-500">Basis
            <Segmented size="sm" value={qp.get("basis")} onChange={(v) => qp.set({ basis: v })} options={[
              { value: "preferred", label: "Consolidated first" }, { value: "consolidated", label: "Consolidated" }, { value: "standalone", label: "Standalone" },
            ]} />
          </div>
          {["q", "sector", "profit"].some((k) => qp.get(k)) && (
            <button onClick={() => { setText(""); qp.set({ q: null, sector: null, profit: null }); }} className="mb-1 inline-flex items-center gap-1 rounded-lg px-2 py-1.5 text-sm text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"><X size={14} /> Clear</button>
          )}
        </div>
        <p className="px-5 pt-3 text-sm text-slate-500 sm:px-6">{data ? <><strong className="text-slate-900 dark:text-white">{num(data.total, 0)}</strong> companies · compared with {monthYear(data.priorQuarter)} · ₹ Crore</> : "Loading…"}</p>
        {error && <ErrorNote message={`Results could not load: ${error}`} onRetry={reload} />}
        {!data && loading ? <Loading rows={12} /> : data && (
          <div className={clsx("mt-3 overflow-x-auto", loading && "is-refreshing")}>
            <table className="w-full text-sm">
              <thead><tr className="border-y border-slate-200 bg-slate-50/70 dark:border-slate-800 dark:bg-slate-800/40">
                {COLS.map(([key, label, sortable]) => (
                  <th key={key + label} scope="col" className={clsx("whitespace-nowrap px-3 py-2.5 text-xs font-semibold", key === "company" ? "text-left" : "text-right")}
                    aria-sort={sort === key ? (order === "asc" ? "ascending" : "descending") : undefined}>
                    {sortable ? (
                      <button onClick={() => qp.set({ sort: key, order: sort === key && order === "desc" ? "asc" : "desc" })}
                        className={clsx("hover:text-slate-900 dark:hover:text-white", sort === key ? "text-indigo-700 dark:text-indigo-300" : "text-slate-500")}>
                        {label}{sort === key && (order === "asc" ? " ↑" : " ↓")}
                      </button>
                    ) : <span className="text-slate-500">{label}</span>}
                  </th>
                ))}
              </tr></thead>
              <tbody className="motion-stagger">
                {data.items.length === 0 && <tr><td colSpan={COLS.length} className="px-4 py-10 text-center text-slate-500">No results match these filters for this quarter.</td></tr>}
                {data.items.map((r) => (
                  <tr key={r.symbol} className="border-b border-slate-100 transition hover:bg-slate-50 dark:border-slate-800/70 dark:hover:bg-slate-800/40">
                    <td className="max-w-[18rem] px-3 py-2">
                      <Link href={`/company/${r.symbol}?view=detailed`} className="block truncate font-semibold hover:text-indigo-700 dark:hover:text-indigo-300">{r.company}</Link>
                      <span className="text-xs text-slate-500">{r.symbol} · {r.industry ?? "Unclassified"} · {r.basis}</span>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-right text-xs text-slate-500">{dateTime(r.filed_at)}</td>
                    <td className="tabular px-3 py-2 text-right">{inrCrore(r.revenue_cr)}</td>
                    <td className="tabular px-3 py-2 text-right"><Pct value={r.revenue_yoy} digits={1} /></td>
                    <td className={clsx("tabular px-3 py-2 text-right font-semibold", (r.profit_cr ?? 0) < 0 && "text-down")}>{inrCrore(r.profit_cr)}</td>
                    <td className="tabular px-3 py-2 text-right"><Pct value={r.profit_yoy} digits={1} /></td>
                    <td className="tabular px-3 py-2 text-right">{r.npm != null ? percent(r.npm) : "—"}</td>
                    <td className="tabular px-3 py-2 text-right">{r.eps != null ? inr(r.eps) : "—"}</td>
                    <td className="tabular px-3 py-2 text-right">{r.market_cap_cr != null ? inrCrore(r.market_cap_cr) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Pagination page={page} pages={Math.max(1, Math.ceil(data.total / pageSize))} total={data.total} pageSize={pageSize}
              onPage={(p) => qp.set({ page: String(p) })} onPageSize={(n) => qp.set({ pageSize: String(n) })} />
          </div>
        )}
        <p className="flex items-center gap-1 px-5 py-3 text-xs text-slate-500 sm:px-6">
          Only filings whose reported totals reconcile are listed. Parsing of result filings continues in the background, so counts grow. <ExternalLink size={11} />
        </p>
      </Card>
    </>
  );
}

export default function ResultsPage() {
  return <Suspense fallback={<Skeleton className="h-96 w-full" />}><ResultsInner /></Suspense>;
}
