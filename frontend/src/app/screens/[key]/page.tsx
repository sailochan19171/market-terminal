"use client";

import clsx from "clsx";
import { Columns3, Download, Filter, Play, Plus, X } from "lucide-react";
import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { DataTable, Pagination, type Column } from "@/components/DataTable";
import { Badge, Button, Card, CardBody, CardHeader, ErrorNote, Loading, PageTitle, Pct } from "@/components/ui";
import { post, useApi } from "@/lib/api";
import { compact, num } from "@/lib/format";
import type { ScreensMeta } from "@/lib/types";

type Row = Record<string, number | string | null> & { symbol: string; company: string | null; industry: string | null };
interface Result { total: number; page: number; pageSize: number; results: Row[]; coverage: { withFundamentals: number; companies: number } }
interface FilterRow { field: string; op: string; value: string }

const DEFAULT_COLUMNS = ["close", "pe", "market_cap_cr", "div_yield", "np_qtr_cr", "qtr_profit_var", "sales_qtr_cr", "qtr_sales_var", "ret_1y"];
const OPS = [{ v: "gt", l: ">" }, { v: "gte", l: "≥" }, { v: "lt", l: "<" }, { v: "lte", l: "≤" }, { v: "eq", l: "=" }];
const PCT_COLS = new Set(["pct_1d", "qtr_profit_var", "qtr_sales_var", "ret_1m", "ret_3m", "ret_1y", "from_high", "from_low", "sales_growth_3y", "profit_growth_3y"]);

function fmt(col: string, v: number | string | null) {
  if (v == null) return <span className="text-slate-300 dark:text-slate-600">—</span>;
  if (typeof v === "string") return v;
  if (PCT_COLS.has(col)) return <Pct value={v} digits={1} />;
  if (col === "volume" || col === "turnover") return compact(v);
  if (col === "earnings_years") return num(v, 0);
  if (col.endsWith("_cr")) return num(v, col === "market_cap_cr" ? 0 : 1);
  return num(v, col === "pe" || col === "price_to_avg_earnings" ? 1 : 2);
}

function ScreenInner() {
  const params = useParams<{ key: string }>();
  const search = useSearchParams();
  const key = params.key;
  const meta = useApi<ScreensMeta>("/api/v2/screens");
  const saved = meta.data?.screens.find((s) => s.key === key);

  const [filters, setFilters] = useState<FilterRow[]>([]);
  const [sector, setSector] = useState<string>("");
  const [sort, setSort] = useState<{ key: string; dir: "asc" | "desc" }>({ key: "market_cap_cr", dir: "desc" });
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [q, setQ] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  const [columns, setColumns] = useState<string[]>(DEFAULT_COLUMNS);
  const [showColumns, setShowColumns] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);

  // Initialise from the saved screen or the URL, once metadata has loaded.
  useEffect(() => {
    if (!meta.data || ready) return;
    if (saved) {
      setFilters(saved.filters.map((f) => ({ field: f.field, op: f.op, value: String(f.value) })));
      setSort({ key: saved.sort, dir: saved.order });
      const extra = saved.filters.map((f) => f.field).filter((f) => !DEFAULT_COLUMNS.includes(f) && f !== "turnover");
      setColumns([...DEFAULT_COLUMNS.slice(0, 3), ...Array.from(new Set(extra)), ...DEFAULT_COLUMNS.slice(3)]);
    }
    setSector(search.get("sector") ?? "");
    setReady(true);
  }, [meta.data, saved, search, ready]);

  const run = useCallback(async (p = 1) => {
    setBusy(true);
    setError(null);
    try {
      const r = await post<Result>("/api/v2/screen", {
        filters: filters.filter((f) => f.value !== "").map((f) => ({ ...f, value: Number(f.value) })),
        sector: sector || undefined, q: debouncedQ || undefined, sort: sort.key, order: sort.dir, page: p, pageSize,
      });
      setResult(r);
      setPage(r.page);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [filters, sector, sort, debouncedQ, pageSize]);

  useEffect(() => {
    const id = setTimeout(() => setDebouncedQ(q.trim()), 300);
    return () => clearTimeout(id);
  }, [q]);
  useEffect(() => { if (ready) run(1); }, [ready, sort, sector, debouncedQ, pageSize]); // eslint-disable-line react-hooks/exhaustive-deps

  const labels = meta.data?.columns ?? {};
  const tableColumns: Column<Row>[] = useMemo(() => [
    { key: "company", label: "Company", render: (r) => (
      <div className="min-w-0">
        <Link href={`/company/${r.symbol}`} className="font-semibold text-indigo-700 hover:underline dark:text-indigo-300">{r.company ?? r.symbol}</Link>
        <p className="text-xs text-slate-400">{r.symbol}{r.industry ? ` · ${r.industry}` : ""}</p>
      </div>
    ) },
    ...columns.map((c) => ({ key: c, label: labels[c] ?? c, align: "right" as const, render: (r: Row) => fmt(c, r[c]) })),
  ], [columns, labels]);

  const exportCsv = async () => {
    const all = await post<Result>("/api/v2/screen", {
      filters: filters.filter((f) => f.value !== "").map((f) => ({ ...f, value: Number(f.value) })),
      sector: sector || undefined, q: debouncedQ || undefined, sort: sort.key, order: sort.dir, page: 1, pageSize: 100,
    });
    const head = ["symbol", "company", "industry", ...columns];
    const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const csv = [head.map((h) => esc(labels[h] ?? h)).join(","), ...all.results.map((r) => head.map((h) => esc(r[h])).join(","))].join("\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    const a = Object.assign(document.createElement("a"), { href: url, download: `${key}-screen.csv` });
    a.click();
    URL.revokeObjectURL(url);
  };

  const pages = result ? Math.max(1, Math.ceil(result.total / result.pageSize)) : 1;
  const title = saved?.title ?? (sector ? `${sector} companies` : "Custom screen");

  if (meta.error) return <Card><ErrorNote message={meta.error} onRetry={meta.reload} /></Card>;
  if (!meta.data) return <Card><Loading rows={10} /></Card>;

  return (
    <>
      <PageTitle title={title} subtitle={saved?.description ?? "Combine filters on valuation, growth, returns and ownership."}
        actions={<Link href="/screens" className="text-sm font-medium text-indigo-700 hover:underline dark:text-indigo-300">← All screens</Link>} />

      <Card className="mb-6">
        <CardHeader title={<span className="flex items-center gap-2"><Filter size={17} /> Query</span>}
          subtitle="All conditions must match. Values use the units shown in each column." />
        <CardBody className="space-y-3">
          {filters.map((f, i) => (
            <div key={i} className="flex flex-wrap items-center gap-2">
              {i > 0 && <span className="w-10 text-xs font-semibold text-slate-400">AND</span>}
              <select value={f.field} onChange={(e) => setFilters((fs) => fs.map((x, j) => j === i ? { ...x, field: e.target.value } : x))}
                className="min-w-56 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-900">
                {Object.entries(labels).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
              <select value={f.op} onChange={(e) => setFilters((fs) => fs.map((x, j) => j === i ? { ...x, op: e.target.value } : x))}
                className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-900">
                {OPS.map((o) => <option key={o.v} value={o.v}>{o.l}</option>)}
              </select>
              <input value={f.value} inputMode="decimal" onChange={(e) => setFilters((fs) => fs.map((x, j) => j === i ? { ...x, value: e.target.value } : x))}
                className="w-32 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-900" />
              <button onClick={() => setFilters((fs) => fs.filter((_, j) => j !== i))} aria-label="Remove condition"
                className="rounded-lg p-2 text-slate-400 hover:bg-slate-100 hover:text-rose-600 dark:hover:bg-slate-800"><X size={16} /></button>
            </div>
          ))}
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <Button onClick={() => setFilters((fs) => [...fs, { field: "pe", op: "lt", value: "20" }])}><Plus size={15} /> Add condition</Button>
            <select value={sector} onChange={(e) => setSector(e.target.value)}
              className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-900">
              <option value="">All sectors</option>
              {meta.data.sectors.map((s) => <option key={s.name} value={s.name}>{s.name} ({s.companies})</option>)}
            </select>
            <Button variant="primary" onClick={() => run(1)} disabled={busy}><Play size={15} /> {busy ? "Running…" : "Run screen"}</Button>
          </div>
        </CardBody>
      </Card>

      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3 px-5 pt-5 sm:px-6">
          <div className="flex flex-wrap items-center gap-3">
            <p className="text-sm">
              {result ? <><span className="font-semibold">{num(result.total, 0)}</span> results · page {page} of {pages}</> : "Running…"}
            </p>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter by company or symbol"
              className="w-60 rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-sm outline-none focus:border-indigo-400 dark:border-slate-700 dark:bg-slate-900" />
          </div>
          <div className="relative flex gap-2">
            <Button onClick={() => setShowColumns((s) => !s)}><Columns3 size={15} /> Edit columns</Button>
            <Button onClick={exportCsv} disabled={!result?.total}><Download size={15} /> Export CSV</Button>
            {showColumns && (
              <div className="absolute right-0 top-full z-30 mt-2 max-h-96 w-72 overflow-y-auto rounded-2xl border border-slate-200 bg-white p-3 shadow-xl dark:border-slate-700 dark:bg-slate-900">
                {Object.entries(labels).map(([k, l]) => (
                  <label key={k} className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-slate-50 dark:hover:bg-slate-800">
                    <input type="checkbox" className="accent-indigo-600" checked={columns.includes(k)}
                      onChange={(e) => setColumns((cs) => e.target.checked ? [...cs, k] : cs.filter((c) => c !== k))} />
                    {l}
                  </label>
                ))}
              </div>
            )}
          </div>
        </div>
        {result && result.coverage.withFundamentals < result.coverage.companies / 2 && (
          <p className="mx-5 mt-3 rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-800 sm:mx-6 dark:bg-amber-500/10 dark:text-amber-300">
            Financial filters currently cover {num(result.coverage.withFundamentals, 0)} of {num(result.coverage.companies, 0)} companies; result filings are still being parsed, so screens on earnings will grow.
          </p>
        )}
        {error && <ErrorNote message={error} onRetry={() => run(page)} />}
        <div className={clsx("pt-4 transition-opacity", busy && "opacity-60")}>
          {!result ? <Loading /> : (
            <DataTable<Row> numbered offset={(page - 1) * pageSize} rows={result.results} rowKey={(r) => r.symbol}
              columns={tableColumns}
              sort={sort}
              onSort={(k) => { if (k === "company") return; setSort((s) => s.key === k ? { key: k, dir: s.dir === "asc" ? "desc" : "asc" } : { key: k, dir: "desc" }); }}
              empty="No companies match these conditions." />
          )}
        </div>
        {result && (
          <Pagination page={page} pages={pages} total={result.total} pageSize={result.pageSize}
            onPage={(n) => run(n)} onPageSize={setPageSize} />
        )}
      </Card>
      {saved && (
        <p className="mt-4 flex flex-wrap items-center gap-2 text-xs text-slate-500">
          Rules: {saved.filters.map((f, i) => <Badge key={i}>{labels[f.field] ?? f.field} {OPS.find((o) => o.v === f.op)?.l} {f.value}</Badge>)}
        </p>
      )}
    </>
  );
}

export default function ScreenPage() {
  return <Suspense fallback={<Card><Loading rows={10} /></Card>}><ScreenInner /></Suspense>;
}
