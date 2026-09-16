"use client";

import clsx from "clsx";
import { CheckCircle2, XCircle } from "lucide-react";
import Link from "next/link";
import { useMemo } from "react";
import { QuoteStamp } from "@/components/AsOf";
import { VerdictPanel } from "@/components/research/VerdictPanel";
import { RiskFlags } from "@/components/research/RiskFlags";
import { WhyMoving } from "@/components/research/WhyMoving";
import { Donut } from "@/components/charts/Categorical";
import { TimeChart } from "@/components/charts/TimeChart";
import { Badge, Card, CardBody, CardHeader } from "@/components/ui";
import type { Dashboard } from "@/lib/dashboard";
import { countIN, dateOnly, inr, inrCrore, isNum, monthYear, num, pct, percent, tone } from "@/lib/format";
import { PeriodBars, pointsIn, TrendLines } from "./Charts";
import { ChartCard, Delta, KpiCard, NotAvailable } from "./Parts";
import { WatchButton } from "./WatchButton";

export const COLORS = { sales: "#4f46e5", gross: "#0ea5e9", profit: "#10b981", op: "#f59e0b", eps: "#8b5cf6", shares: "#64748b" };

export function CompanyHeader({ data }: { data: Dashboard }) {
  const { identity: id, quote: q, price } = data;
  // The price service is the authority on what the stock is worth right now; the bars only add the 52-week range.
  const last = price?.lastPrice ?? q?.close ?? null;
  const change = price?.changeAbs ?? q?.change ?? null;
  const changePct = price?.changePct ?? q?.changePct ?? null;
  const range = q && isNum(q.high52w) && isNum(q.low52w) && isNum(last) && q.high52w > q.low52w
    ? Math.min(100, Math.max(0, ((last - q.low52w) / (q.high52w - q.low52w)) * 100)) : null;
  return (
    <Card className="motion-rise">
      <CardBody className="flex flex-wrap items-start justify-between gap-5">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{id.company}</h1>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {id.symbol && <Badge tone="brand">NSE: {id.symbol}</Badge>}
            {id.bseCode && <Badge tone="up">BSE: {id.bseCode}{id.bseTicker && id.bseTicker !== id.symbol ? ` · ${id.bseTicker}` : ""}</Badge>}
            {id.isin && <Badge>ISIN {id.isin}</Badge>}
            {id.industry && <Link href={`/screens/custom?sector=${encodeURIComponent(id.industry)}`}><Badge tone="amber">{id.industry}</Badge></Link>}
            {id.instrumentType !== "Equity" && <Badge>{id.instrumentType}</Badge>}
          </div>
        </div>
        <div className="flex flex-wrap items-start gap-5">
          <div className="text-right">
            {isNum(last) ? (
              <>
                <div className="flex items-baseline justify-end gap-2">
                  <span className="tabular text-3xl font-semibold">{inr(last)}</span>
                  <span className={clsx("tabular text-sm font-semibold", tone(change))}>
                    {isNum(change) ? `${change >= 0 ? "+" : ""}${num(change)}` : ""} ({pct(changePct)})
                  </span>
                </div>
                <QuoteStamp quote={price} className="mt-1 justify-end" />
                {range != null && q && (
                  <div className="mt-2 w-56" aria-label={`52-week range ${inr(q.low52w)} to ${inr(q.high52w)}`}>
                    <div className="relative h-1.5 rounded-full bg-gradient-to-r from-rose-200 via-slate-200 to-emerald-200 dark:from-rose-500/30 dark:via-slate-700 dark:to-emerald-500/30">
                      <span className="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-indigo-600 shadow dark:border-slate-900" style={{ left: `${range}%` }} />
                    </div>
                    <div className="tabular mt-1 flex justify-between text-[11px] text-slate-500">
                      <span>52W L {inr(q.low52w)}</span><span>H {inr(q.high52w)}</span>
                    </div>
                  </div>
                )}
              </>
            ) : <NotAvailable reason={data.reasons.price} />}
          </div>
          {data.mode === "latest" && <WatchButton identity={id} />}
        </div>
      </CardBody>
    </Card>
  );
}

export function quarterSeries(rows: Dashboard["quarters"]) {
  return rows.map((r) => ({ ...r, label: monthYear(r.period_end) }));
}

export function Observations({ data }: { data: Dashboard }) {
  const groups = [
    { title: "Strengths", items: data.analysis.pros, icon: <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-up" />, cls: "border-emerald-200 bg-emerald-50/40 dark:border-emerald-500/20 dark:bg-emerald-500/5" },
    { title: "Concerns", items: data.analysis.cons, icon: <XCircle size={16} className="mt-0.5 shrink-0 text-down" />, cls: "border-rose-200 bg-rose-50/40 dark:border-rose-500/20 dark:bg-rose-500/5" },
  ];
  return (
    <Card className="motion-rise">
      <CardHeader title="Observations" subtitle={data.analysis.basis} />
      <CardBody className="grid gap-4 md:grid-cols-2">
        {groups.map((g) => (
          <div key={g.title} className={clsx("rounded-2xl border p-4", g.cls)}>
            <p className="text-xs font-semibold uppercase tracking-wider text-slate-600 dark:text-slate-300">{g.title}</p>
            {g.items.length === 0 ? <p className="mt-2 text-sm text-slate-500">Nothing notable from the available data.</p> : (
              <ul className="motion-stagger mt-2 space-y-2">{g.items.map((t) => <li key={t} className="flex gap-2 text-sm leading-relaxed">{g.icon}<span>{t}</span></li>)}</ul>
            )}
          </div>
        ))}
      </CardBody>
    </Card>
  );
}

export function SummaryView({ data }: { data: Dashboard }) {
  const m = data.metrics;
  const company = data.identity.company;
  const quarters = useMemo(() => quarterSeries(data.quartersInRange), [data.quartersInRange]);
  const holding = data.shareholdingInRange.at(-1) ?? data.shareholding.at(-1);
  const rangeLabel = `${dateOnly(data.range.from)} – ${dateOnly(data.range.to)}`;
  const narrowRange = data.quarters.length > quarters.length
    ? `No quarter ended between ${rangeLabel}. Widen the date range to include more results.` : data.noResultsReason ?? undefined;

  return (
    <div className="space-y-5">
      {data.mode === "latest" && data.identity.symbol && !data.identity.limited && (
        <>
          <WhyMoving symbol={data.identity.symbol} />
          <VerdictPanel symbol={data.identity.symbol} />
          <RiskFlags symbol={data.identity.symbol} />
        </>
      )}
      <div className="motion-stagger grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-6">
        <KpiCard data={data} metric="market_cap" emphasis />
        <KpiCard data={data} metric="revenue_ttm" sub={<Delta value={m.revenue_ttm_growth as number} label="vs prior TTM" />} />
        <KpiCard data={data} metric="gross_profit_ttm" sub={isNum(m.gpm_ttm as number) && <span className="text-slate-500">{percent(m.gpm_ttm as number)} margin</span>} />
        <KpiCard data={data} metric="net_profit_ttm" sub={<Delta value={m.profit_ttm_growth as number} label="vs prior TTM" />} />
        <KpiCard data={data} metric="eps_ttm" sub={<Delta value={m.eps_ttm_growth as number} label="YoY" />} />
        <KpiCard data={data} metric="pe" />
        <KpiCard data={data} metric="pb" />
        <KpiCard data={data} metric="shares" />
        <KpiCard data={data} metric="roe" />
        <KpiCard data={data} metric="dividend_yield" sub={isNum(m.dividend_ttm as number) && <span className="text-slate-500">{inr(m.dividend_ttm as number)} per share</span>} />
        <KpiCard data={data} metric="sales_cagr_3y" />
        <KpiCard data={data} metric="profit_cagr_3y" />
        <KpiCard data={data} metric="cfo_fy" />
        <KpiCard data={data} metric="fcf_fy" />
        <KpiCard data={data} metric="cash" />
        <KpiCard data={data} metric="book_value" />
        <KpiCard data={data} metric="current_ratio" />
        <KpiCard data={data} metric="debt_to_equity" />
      </div>

      <div className="grid gap-5 xl:grid-cols-2">
        <ChartCard title="Price" subtitle={`${data.exchange} close, ${rangeLabel}`} unit="₹ per share" points={data.prices.length}
          empty={`No ${data.exchange} prices between ${rangeLabel}.`}>
          <TimeChart mode="area" bars={data.prices} showVolume height={280} title={company} />
        </ChartCard>
        <ChartCard title="Revenue, gross profit and net profit" subtitle="Quarterly, in the selected range" unit="₹ Crore"
          points={pointsIn(quarters, [{ key: "sales", label: "", color: "" }])} empty={narrowRange}>
          <PeriodBars data={quarters} title={company} format={(v) => inrCrore(v)} series={[
            { key: "sales", label: "Revenue", color: COLORS.sales },
            ...(quarters.some((q) => isNum(q.gross_profit)) ? [{ key: "gross_profit", label: "Gross profit", color: COLORS.gross }] : []),
            { key: "net_profit", label: "Net profit", color: COLORS.profit },
          ]} />
        </ChartCard>
        <ChartCard title="Profit margins" subtitle="Quarterly" unit="% of revenue"
          points={pointsIn(quarters, [{ key: "npm", label: "", color: "" }])} empty={narrowRange}>
          <TrendLines data={quarters} title={company} format={(v) => percent(v, 1)} axis={(v) => `${Math.round(v)}%`} series={[
            { key: "opm", label: "Operating margin", color: COLORS.op },
            ...(quarters.some((q) => isNum(q.gpm)) ? [{ key: "gpm", label: "Gross margin", color: COLORS.gross }] : []),
            { key: "npm", label: "Net margin", color: COLORS.profit },
          ]} />
        </ChartCard>
        <ChartCard title="Earnings per share" subtitle="Quarterly, adjusted for splits and bonuses" unit="₹ per share"
          points={pointsIn(quarters, [{ key: "eps", label: "", color: "" }])} empty={narrowRange}>
          <TrendLines data={quarters} title={company} format={(v) => inr(v)} axis={(v) => `₹${num(v, Math.abs(v) < 100 ? 1 : 0)}`}
            series={[{ key: "eps", label: "EPS", color: COLORS.eps }]} />
        </ChartCard>
      </div>

      <div className="grid gap-5 xl:grid-cols-5">
        <Card className="motion-rise xl:col-span-2">
          <CardHeader title="Shareholding" subtitle={holding ? `As of ${dateOnly(holding.as_of_date)}` : undefined} />
          <CardBody>
            {holding ? (
              <>
                <Donut title={company} height={220} slices={[
                  { name: "Promoters", value: holding.promoter ?? null }, { name: "FIIs", value: holding.fii ?? null },
                  { name: "DIIs", value: holding.dii ?? null }, { name: "Government", value: holding.government ?? null },
                  { name: "Public", value: holding.public ?? null }, { name: "Others", value: holding.others ?? null },
                ]} />
                <p className="mt-2 text-xs text-slate-500">
                  {holding.source === "summary" ? "Promoter / public split only; category detail not yet parsed." : `${countIN(holding.shareholders)} shareholders · ${countIN(holding.total_shares)} shares`}
                </p>
              </>
            ) : <NotAvailable reason={data.reasons.promoter} />}
          </CardBody>
        </Card>
        <div className="xl:col-span-3"><Observations data={data} /></div>
      </div>
    </div>
  );
}
