"use client";

import clsx from "clsx";
import { CalendarDays, Search } from "lucide-react";
import Link from "next/link";
import { Suspense, useEffect, useMemo, useState } from "react";
import { Pagination } from "@/components/DataTable";
import { CalendarIllustration, HeroStat, PageHero } from "@/components/Illustrations";
import { Badge, Card, ErrorNote, Loading, Pct, Segmented, Skeleton } from "@/components/ui";
import { useApi, useDebounced } from "@/lib/api";
import { dateOnly, inr, num } from "@/lib/format";
import { useQueryParams } from "@/lib/query";

interface Row { symbol: string; company: string; meeting_dt: string; purpose: string | null; description: string | null; close: number | null; pct_1d: number | null }
interface Meetings { when: string; total: number; page: number; pageSize: number; items: Row[]; nextSevenDays: number }

const DEFAULTS = { when: "upcoming", page: "1", pageSize: "25" };

function purposeTone(p: string): "brand" | "up" | "amber" | "slate" {
  const s = p.toLowerCase();
  if (s.includes("result")) return "brand";
  if (s.includes("dividend") || s.includes("bonus")) return "up";
  if (s.includes("fund") || s.includes("buy")) return "amber";
  return "slate";
}

function Inner() {
  const qp = useQueryParams(DEFAULTS);
  const [text, setText] = useState(qp.get("q"));
  const q = useDebounced(text.trim(), 300);
  useEffect(() => { if (q !== qp.get("q")) qp.set({ q }); }, [q]); // eslint-disable-line react-hooks/exhaustive-deps
  const { data, error, loading, reload } = useApi<Meetings>(`/api/v2/board-meetings?${qp.toApi(["when", "purpose", "q", "page", "pageSize"], { when: qp.get("when") })}`);
  const page = Number(qp.get("page")) || 1, pageSize = Number(qp.get("pageSize")) || 25;

  // Group rows by date for a calendar-like list.
  const groups = useMemo(() => {
    const out: [string, Row[]][] = [];
    for (const r of data?.items ?? []) {
      const last = out[out.length - 1];
      if (last && last[0] === r.meeting_dt) last[1].push(r); else out.push([r.meeting_dt, [r]]);
    }
    return out;
  }, [data]);

  return (
    <>
      <PageHero eyebrow="Corporates" title="Board meetings"
        subtitle="Scheduled and past board meetings filed with NSE: results, dividends, bonus issues, splits, buybacks and fund raising."
        art={<CalendarIllustration />}>
        {data && <div className="flex flex-wrap gap-2">
          <HeroStat label="Next 7 days" value={num(data.nextSevenDays, 0)} />
          <HeroStat label={data.when === "upcoming" ? "Upcoming matching" : "Past matching"} value={num(data.total, 0)} />
        </div>}
      </PageHero>

      <Card className="motion-rise">
        <div className="flex flex-wrap items-end gap-3 px-5 pt-5 sm:px-6">
          <div className="flex flex-col gap-1 text-xs font-medium text-slate-500">When
            <Segmented value={qp.get("when")} onChange={(v) => qp.set({ when: v })} options={[{ value: "upcoming", label: "Upcoming" }, { value: "past", label: "Past" }]} />
          </div>
          <div className="flex flex-col gap-1 text-xs font-medium text-slate-500">Purpose
            <Segmented size="sm" value={qp.get("purpose")} onChange={(v) => qp.set({ purpose: v })} options={[
              { value: "", label: "All" }, { value: "results", label: "Results" }, { value: "dividend", label: "Dividend" },
              { value: "fund", label: "Fund raising" }, { value: "bonus", label: "Bonus" }, { value: "split", label: "Split" }, { value: "buyback", label: "Buyback" },
            ]} />
          </div>
          <label className="flex min-w-56 flex-1 flex-col gap-1 text-xs font-medium text-slate-500">Company
            <span className="relative"><Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
              <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Name or NSE symbol" className="w-full rounded-xl border border-slate-200 bg-white py-2 pl-9 pr-3 text-sm outline-none focus:border-indigo-400 dark:border-slate-700 dark:bg-slate-900" /></span>
          </label>
        </div>
        {error && <ErrorNote message={`Board meetings could not load: ${error}`} onRetry={reload} />}
        {!data && loading ? <Loading rows={10} /> : data && (
          <div className={clsx("mt-4", loading && "is-refreshing")}>
            {groups.length === 0 && <p className="px-6 py-10 text-center text-sm text-slate-500">No board meetings match these filters.</p>}
            <ol className="motion-stagger">
              {groups.map(([day, items]) => (
                <li key={day} className="border-t border-slate-100 dark:border-slate-800">
                  <div className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:px-6">
                    <div className="flex w-28 shrink-0 items-center gap-2 sm:block">
                      <CalendarDays size={16} className="text-indigo-600 sm:hidden" />
                      <p className="text-sm font-semibold">{dateOnly(day)}</p>
                      <p className="text-xs text-slate-500">{items.length} {items.length === 1 ? "meeting" : "meetings"}</p>
                    </div>
                    <ul className="flex-1 space-y-2">
                      {items.map((r, i) => (
                        <li key={`${r.symbol}-${i}`} className="hover-lift flex flex-wrap items-start justify-between gap-3 rounded-xl border border-slate-200 px-4 py-3 dark:border-slate-800">
                          <div className="min-w-0">
                            <Link href={`/company/${r.symbol}`} className="font-semibold hover:text-indigo-700 dark:hover:text-indigo-300">{r.company}</Link>
                            <span className="ml-2 text-xs text-slate-500">{r.symbol}</span>
                            {r.purpose && <div className="mt-1"><Badge tone={purposeTone(r.purpose)}>{r.purpose}</Badge></div>}
                            {r.description && r.description !== r.purpose && <p className="mt-1 line-clamp-2 text-xs text-slate-500">{r.description}</p>}
                          </div>
                          {r.close != null && <span className="tabular text-right text-sm"><span className="block font-semibold">{inr(r.close)}</span><Pct value={r.pct_1d} className="text-xs" /></span>}
                        </li>
                      ))}
                    </ul>
                  </div>
                </li>
              ))}
            </ol>
            <Pagination page={page} pages={Math.max(1, Math.ceil(data.total / pageSize))} total={data.total} pageSize={pageSize}
              onPage={(p) => qp.set({ page: String(p) })} onPageSize={(n) => qp.set({ pageSize: String(n) })} />
          </div>
        )}
      </Card>
    </>
  );
}

export default function BoardMeetingsPage() {
  return <Suspense fallback={<Skeleton className="h-96 w-full" />}><Inner /></Suspense>;
}
