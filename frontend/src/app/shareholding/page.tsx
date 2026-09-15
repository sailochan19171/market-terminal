"use client";

import clsx from "clsx";
import { Search } from "lucide-react";
import Link from "next/link";
import { Suspense, useEffect, useState } from "react";
import { Pagination } from "@/components/DataTable";
import { HeroStat, OwnershipIllustration, PageHero } from "@/components/Illustrations";
import { Card, ErrorNote, Loading, Pct, Segmented, Skeleton } from "@/components/ui";
import { useApi, useDebounced } from "@/lib/api";
import { countIN, dateOnly, inr, inrCrore, num, percent } from "@/lib/format";
import { useQueryParams } from "@/lib/query";

type Category = "fii" | "dii" | "promoter" | "public";
interface Row {
  symbol: string; company: string; industry: string | null; as_of_date: string; prev_date: string; close: number | null; pct_1d: number | null;
  market_cap_cr: number | null; promoter: number | null; fii: number | null; dii: number | null; public: number | null; shareholders: number | null;
  d_promoter: number | null; d_fii: number | null; d_dii: number | null; d_public: number | null; d_shareholders: number | null;
}
interface Changes { category: Category; total: number; page: number; pageSize: number; items: Row[]; coverage: number; listed: number }

const DEFAULTS = { category: "fii", direction: "up", page: "1", pageSize: "25" };
const LABEL: Record<Category, string> = { fii: "FII", dii: "DII", promoter: "Promoter", public: "Public" };

function Change({ v }: { v: number | null }) {
  if (v == null) return <span className="text-slate-300">—</span>;
  return <span className={clsx("tabular font-semibold", v > 0 ? "text-up" : v < 0 ? "text-down" : "text-slate-500")}>{v > 0 ? "+" : ""}{num(v, 2)} pts</span>;
}

function Inner() {
  const qp = useQueryParams(DEFAULTS);
  const [text, setText] = useState(qp.get("q"));
  const q = useDebounced(text.trim(), 300);
  useEffect(() => { if (q !== qp.get("q")) qp.set({ q }); }, [q]); // eslint-disable-line react-hooks/exhaustive-deps
  const category = qp.get("category") as Category;
  const { data, error, loading, reload } = useApi<Changes>(`/api/v2/shareholding-changes?${qp.toApi(["category", "direction", "q", "page", "pageSize"], { category, direction: qp.get("direction") })}`);
  const page = Number(qp.get("page")) || 1, pageSize = Number(qp.get("pageSize")) || 25;

  return (
    <>
      <PageHero eyebrow="Corporates" title="Shareholding changes"
        subtitle="Who is buying and selling at the ownership level: the change in each holder category between a company's two latest shareholding patterns."
        art={<OwnershipIllustration />}>
        {data && <div className="flex flex-wrap gap-2">
          <HeroStat label="Companies with detail" value={`${num(data.coverage, 0)} of ${num(data.listed, 0)}`} />
          <HeroStat label={`${LABEL[category]} ${qp.get("direction") === "down" ? "reduced" : "increased"}`} value={num(data.total, 0)} tone={qp.get("direction") === "down" ? "down" : "up"} />
        </div>}
      </PageHero>

      <Card className="motion-rise">
        <div className="flex flex-wrap items-end gap-3 px-5 pt-5 sm:px-6">
          <div className="flex flex-col gap-1 text-xs font-medium text-slate-500">Holder
            <Segmented value={category} onChange={(v) => qp.set({ category: v })} options={[
              { value: "fii", label: "FIIs" }, { value: "dii", label: "DIIs" }, { value: "promoter", label: "Promoters" }, { value: "public", label: "Public" },
            ]} />
          </div>
          <div className="flex flex-col gap-1 text-xs font-medium text-slate-500">Change
            <Segmented value={qp.get("direction")} onChange={(v) => qp.set({ direction: v })} options={[
              { value: "up", label: "Increased" }, { value: "down", label: "Reduced" }, { value: "all", label: "Any" },
            ]} />
          </div>
          <label className="flex min-w-56 flex-1 flex-col gap-1 text-xs font-medium text-slate-500">Company
            <span className="relative"><Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
              <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Name or NSE symbol" className="w-full rounded-xl border border-slate-200 bg-white py-2 pl-9 pr-3 text-sm outline-none focus:border-indigo-400 dark:border-slate-700 dark:bg-slate-900" /></span>
          </label>
        </div>
        {error && <ErrorNote message={`Shareholding changes could not load: ${error}`} onRetry={reload} />}
        {!data && loading ? <Loading rows={10} /> : data && (
          <div className={clsx("mt-4 overflow-x-auto", loading && "is-refreshing")}>
            <table className="w-full text-sm">
              <thead><tr className="border-y border-slate-200 bg-slate-50/70 text-xs font-semibold text-slate-500 dark:border-slate-800 dark:bg-slate-800/40">
                <th scope="col" className="px-3 py-2.5 text-left">Company</th><th scope="col" className="px-3 py-2.5 text-right">Quarter</th>
                {(["promoter", "fii", "dii", "public"] as Category[]).map((k) => <th key={k} scope="col" className={clsx("px-3 py-2.5 text-right", k === category && "text-indigo-700 dark:text-indigo-300")}>{LABEL[k]}</th>)}
                <th scope="col" className="px-3 py-2.5 text-right">Shareholders</th><th scope="col" className="px-3 py-2.5 text-right">Price</th><th scope="col" className="px-3 py-2.5 text-right">Mkt cap</th>
              </tr></thead>
              <tbody className="motion-stagger">
                {data.items.length === 0 && <tr><td colSpan={9} className="px-4 py-10 text-center text-slate-500">No companies match. Category detail is available for {num(data.coverage, 0)} companies so far and grows as filings are parsed.</td></tr>}
                {data.items.map((r) => (
                  <tr key={r.symbol} className="border-b border-slate-100 transition hover:bg-slate-50 dark:border-slate-800/70 dark:hover:bg-slate-800/40">
                    <td className="max-w-[16rem] px-3 py-2"><Link href={`/company/${r.symbol}?view=detailed#shares`} className="block truncate font-semibold hover:text-indigo-700 dark:hover:text-indigo-300">{r.company}</Link><span className="text-xs text-slate-500">{r.symbol} · {r.industry ?? "Unclassified"}</span></td>
                    <td className="whitespace-nowrap px-3 py-2 text-right text-xs text-slate-500">{dateOnly(r.as_of_date)}<br />vs {dateOnly(r.prev_date)}</td>
                    {(["promoter", "fii", "dii", "public"] as Category[]).map((k) => (
                      <td key={k} className={clsx("px-3 py-2 text-right", k === category && "bg-indigo-50/50 dark:bg-indigo-500/5")}>
                        <span className="tabular block">{r[k] != null ? percent(r[k] as number, 2) : "—"}</span>
                        <span className="text-xs"><Change v={r[`d_${k}` as keyof Row] as number | null} /></span>
                      </td>
                    ))}
                    <td className="tabular px-3 py-2 text-right">{countIN(r.shareholders)}<br /><span className="text-xs text-slate-500">{r.d_shareholders != null ? `${r.d_shareholders > 0 ? "+" : ""}${countIN(r.d_shareholders)}` : ""}</span></td>
                    <td className="tabular px-3 py-2 text-right">{r.close != null ? inr(r.close) : "—"}<br /><Pct value={r.pct_1d} className="text-xs" /></td>
                    <td className="tabular px-3 py-2 text-right">{r.market_cap_cr != null ? inrCrore(r.market_cap_cr) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Pagination page={page} pages={Math.max(1, Math.ceil(data.total / pageSize))} total={data.total} pageSize={pageSize}
              onPage={(p) => qp.set({ page: String(p) })} onPageSize={(n) => qp.set({ pageSize: String(n) })} />
          </div>
        )}
      </Card>
    </>
  );
}

export default function ShareholdingPage() {
  return <Suspense fallback={<Skeleton className="h-96 w-full" />}><Inner /></Suspense>;
}
