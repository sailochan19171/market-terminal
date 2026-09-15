"use client";

import clsx from "clsx";
import Link from "next/link";
import { useParams, usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo } from "react";
import { CompanySelect, DateRangeFilter, ExchangeFilter, VersionSelect, ViewTabs } from "@/components/dashboard/Controls";
import { DetailedView } from "@/components/dashboard/DetailedView";
import { KpiSkeleton, StatusBar, SyncProgress } from "@/components/dashboard/Parts";
import { CompanyHeader, SummaryView } from "@/components/dashboard/SummaryView";
import { VersionHistory } from "@/components/dashboard/VersionHistory";
import { startRouteProgress } from "@/components/RouteProgress";
import { Button, Card, CardBody, ErrorNote, Skeleton } from "@/components/ui";
import { api, useApi } from "@/lib/api";
import type { Dashboard, Exchange, Preset, SyncStatus, ViewMode } from "@/lib/dashboard";

const VIEWS: ViewMode[] = ["summary", "detailed", "versions"];

function DashboardSkeleton() {
  return (
    <div className="space-y-5" role="status" aria-label="Loading company dashboard">
      <Card><CardBody className="flex justify-between gap-4"><div className="space-y-3"><Skeleton className="h-8 w-72" /><Skeleton className="h-5 w-56" /></div><Skeleton className="h-10 w-40" /></CardBody></Card>
      <KpiSkeleton count={12} />
      <div className="grid gap-5 xl:grid-cols-2">
        {Array.from({ length: 4 }).map((_, i) => <Card key={i}><CardBody><Skeleton className="h-5 w-40" /><Skeleton className="mt-4 h-[240px] w-full" /></CardBody></Card>)}
      </div>
    </div>
  );
}

interface NotFoundBody { message?: string; redirect?: string; suggestions?: { key: string; company: string }[] }

function NotFound({ symbol, body }: { symbol: string; body: NotFoundBody | undefined }) {
  return (
    <Card className="motion-rise">
      <div className="px-6 py-10 text-center">
        <p className="text-sm font-semibold text-indigo-600">{symbol}</p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">No company found</h1>
        <p className="mx-auto mt-2 max-w-lg text-sm text-slate-500">{body?.message ?? "Nothing trades on NSE or BSE under this identifier in the stored data."}</p>
        {body?.redirect && <Button variant="primary" href={body.redirect} className="mt-4">Open the index page</Button>}
      </div>
      {!!body?.suggestions?.length && (
        <div className="border-t border-slate-100 px-6 py-5 dark:border-slate-800">
          <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-slate-500">Did you mean</p>
          <div className="grid gap-2 sm:grid-cols-2">
            {body.suggestions.map((m) => (
              <Link key={m.key} href={`/company/${encodeURIComponent(m.key)}`} className="hover-lift rounded-xl border border-slate-200 px-4 py-3 dark:border-slate-800">
                <span className="block text-sm font-semibold">{m.key}</span><span className="block truncate text-xs text-slate-500">{m.company}</span>
              </Link>
            ))}
          </div>
        </div>
      )}
    </Card>
  );
}

function CompanyDashboard() {
  const params = useParams<{ symbol: string }>();
  const symbol = decodeURIComponent(params.symbol ?? "").toUpperCase();
  const search = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  const view = (VIEWS.includes(search.get("view") as ViewMode) ? search.get("view") : "summary") as ViewMode;
  const preset = ((search.get("range") ?? "1Y").toUpperCase() === "CUSTOM" ? "custom" : (search.get("range") ?? "1Y").toUpperCase()) as Preset;
  const from = search.get("from");
  const to = search.get("to");
  const version = search.get("version");
  const exchange = search.get("exchange") as Exchange | null;

  const apiPath = useMemo(() => {
    const q = new URLSearchParams();
    if (exchange) q.set("exchange", exchange);
    if (version) q.set("version", version);
    q.set("range", preset === "custom" ? "custom" : preset);
    if (preset === "custom" && from) q.set("from", from);
    if (preset === "custom" && to) q.set("to", to);
    return `/api/v2/company/${encodeURIComponent(symbol)}/dashboard?${q}`;
  }, [symbol, exchange, version, preset, from, to]);

  const { data, error, errorStatus, errorBody, loading, stale, updatedAt, reload } = useApi<Dashboard>(symbol ? apiPath : null);

  /** Merge changes into the URL; the URL is the single source of filter state. */
  const update = useCallback((changes: Record<string, string | null>, path = pathname) => {
    const next = new URLSearchParams(search.toString());
    for (const [k, v] of Object.entries(changes)) {
      if (v === null || v === "") next.delete(k);
      else next.set(k, v);
    }
    const qs = next.toString();
    router.replace(`${path}${qs ? `?${qs}` : ""}`, { scroll: false });
  }, [pathname, router, search]);

  // Poll an on-demand filing sync, then rebuild the dashboard when it completes.
  const syncing = Boolean(data?.sync && (data.sync.running || data.sync.status === "running"));
  useEffect(() => {
    if (!syncing) return;
    const id = setInterval(async () => {
      try {
        const s = await api<SyncStatus>(`/api/v2/company/${encodeURIComponent(symbol)}/sync`);
        if (!s.running && s.status !== "running") reload();
      } catch { /* the next poll retries */ }
    }, 3000);
    return () => clearInterval(id);
  }, [syncing, symbol, reload]);

  useEffect(() => {
    if (data?.identity.company) document.title = `${data.identity.company} · Market Terminal`;
  }, [data?.identity.company]);

  // A different company is loading: do not dress the previous one up as current.
  const otherCompany = data && stale && ![data.identity.key, data.identity.bseCode, data.identity.symbol, data.identity.bseTicker]
    .filter(Boolean).map((x) => String(x).toUpperCase()).includes(symbol);

  if (!data || otherCompany) {
    if (error && errorStatus === 404) return <NotFound symbol={symbol} body={errorBody as NotFoundBody} />;
    if (error) return (
      <Card><ErrorNote message={errorStatus === 400 ? `These filters are not valid: ${error}` : `The dashboard could not load: ${error}`}
        onRetry={errorStatus === 400 ? () => router.replace(pathname) : reload} /></Card>
    );
    return <DashboardSkeleton />;
  }

  const anchorMax = data.mode === "version" ? data.version?.analysis_date : data.freshness.prices.latestStored;
  const refreshing = loading && Boolean(data);
  const filterError = error && errorStatus === 400 ? error : null;

  return (
    <div className="space-y-4">
      {/* Filters */}
      <div className="sticky top-[104px] lg:top-[153px] z-30 -mx-4 border-b border-slate-200 bg-slate-50/90 px-4 py-3 backdrop-blur sm:-mx-6 sm:px-6 dark:border-slate-800 dark:bg-slate-950/85">
        <div className="flex flex-wrap items-center gap-3">
          <CompanySelect current={{ key: data.identity.key, company: data.identity.company, symbol: data.identity.symbol, bseCode: data.identity.bseCode }}
            onSelect={(key) => {
              // Keep the view and dates; a stored analysis belongs to one company, so drop it.
              const next = new URLSearchParams(search.toString());
              next.delete("version");
              next.delete("exchange");
              const href = `/company/${encodeURIComponent(key)}${next.size ? `?${next}` : ""}`;
              startRouteProgress(href);
              router.push(href, { scroll: false });
            }} />
          <ExchangeFilter value={data.exchange} available={data.identity.exchanges} disabled={data.mode === "version"}
            onChange={(ex) => update({ exchange: ex })} />
          <DateRangeFilter preset={preset} from={data.range.from} to={data.range.to} max={anchorMax} min={data.dataPeriod.pricesFrom}
            onPreset={(p) => update(p === "custom" ? { range: "custom", from: data.range.from, to: data.range.to } : { range: p, from: null, to: null })}
            onCustom={(f, t) => update({ range: "custom", from: f, to: t })} />
          <div className="ml-auto">
            <VersionSelect versions={data.versions} value={data.version?.id ?? null}
              onChange={(id) => update(id ? { version: String(id), exchange: null } : { version: null })} />
          </div>
        </div>
      </div>

      <StatusBar data={data} updatedAt={updatedAt} refreshing={refreshing}
        error={filterError ? `these filters are not valid (${filterError})` : error}
        onRetry={reload} onLatest={() => update({ version: null, range: preset === "custom" ? "1Y" : preset, from: null, to: null })} />
      <SyncProgress sync={data.sync} />
      {data.identity.limited && (
        <div className="rounded-2xl border border-indigo-100 bg-indigo-50/60 px-5 py-3 text-sm text-indigo-900 dark:border-indigo-500/20 dark:bg-indigo-500/10 dark:text-indigo-200">
          <strong>{data.identity.instrumentType}.</strong> This instrument trades on NSE but is not an operating company, so financial results and shareholding do not apply.
        </div>
      )}

      <div className={clsx("space-y-5", refreshing && "is-refreshing")} aria-busy={refreshing}>
        <CompanyHeader data={data} />
        <ViewTabs value={view} onChange={(v) => update({ view: v === "summary" ? null : v })} versionCount={data.versions.length} />
        <div role="tabpanel" id={`panel-${view}`} aria-labelledby={`tab-${view}`} key={`${view}-${data.version?.id ?? "live"}`} className="motion-fade">
          {view === "summary" && <SummaryView data={data} />}
          {view === "detailed" && <DetailedView data={data} />}
          {view === "versions" && <VersionHistory data={data} from={data.range.from} to={data.range.to} onView={(id) => update({ version: String(id), exchange: null, view: null })} />}
        </div>
      </div>
    </div>
  );
}

export default function CompanyPage() {
  return <Suspense fallback={<DashboardSkeleton />}><CompanyDashboard /></Suspense>;
}
