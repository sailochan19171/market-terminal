"use client";

import clsx from "clsx";
import { ExternalLink } from "lucide-react";
import { useMemo, useState } from "react";
import { Card, CardBody, CardHeader, Segmented } from "@/components/ui";
import type { Dashboard, StatementBlock } from "@/lib/dashboard";
import { inrCrore, isNum, monthYear, num } from "@/lib/format";
import { PeriodBars } from "./Charts";
import { ChartCard, InsufficientData } from "./Parts";

function inRange(periodEnd: string, range: Dashboard["range"]) {
  return (!range.from || periodEnd >= range.from) && (!range.to || periodEnd <= range.to);
}

function periodLabel(p: StatementBlock["periods"][number], cashFlow = false) {
  const base = monthYear(p.periodEnd);
  if (!cashFlow) return base;
  return p.months && p.months < 12 ? `H1 to ${base}` : `FY ${base}`;
}

function StatementTable({ block, periods, cashFlow, caption }: { block: StatementBlock; periods: StatementBlock["periods"]; cashFlow?: boolean; caption: string }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        <caption className="sr-only">{caption}, ₹ crore</caption>
        <thead>
          <tr className="border-b border-slate-200 dark:border-slate-800">
            <th scope="col" className="sticky left-0 z-10 bg-white px-4 py-2.5 text-left text-xs font-semibold text-slate-500 dark:bg-slate-900">₹ Crore</th>
            {periods.map((p) => (
              <th scope="col" key={p.periodEnd} className="whitespace-nowrap px-4 py-2.5 text-right text-xs font-semibold text-slate-500">
                {periodLabel(p, cashFlow)}<span className="block font-normal text-slate-400">{p.basis}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="motion-fade">
          {block.lines.map((ln) => (
            <tr key={ln.key} className={clsx("border-b border-slate-100 last:border-0 dark:border-slate-800/70", ln.level === 0 && "bg-slate-50/70 dark:bg-slate-800/30")}>
              <th scope="row" className={clsx("sticky left-0 z-10 whitespace-nowrap py-2 pr-4 text-left",
                ln.level === 0 ? "bg-slate-50 pl-4 font-semibold dark:bg-slate-800" : "bg-white font-normal text-slate-600 dark:bg-slate-900 dark:text-slate-300",
                ln.level === 1 && "pl-7", ln.level === 2 && "pl-10 text-xs")}>
                {ln.label}
              </th>
              {periods.map((p) => {
                const v = p.values[ln.key];
                return (
                  <td key={p.periodEnd} className={clsx("tabular whitespace-nowrap px-4 py-2 text-right", ln.level === 0 && "font-semibold", isNum(v) && v < 0 && "text-down")}>
                    {isNum(v) ? num(v, 0) : <span className="text-slate-300 dark:text-slate-600" title="Not reported in this filing">—</span>}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <th scope="row" className="sticky left-0 bg-white px-4 py-2 text-left text-xs font-normal text-slate-500 dark:bg-slate-900">Source</th>
            {periods.map((p) => (
              <td key={p.periodEnd} className="px-4 py-2 text-right">
                {p.xbrl_url && <a href={p.xbrl_url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs text-indigo-600 hover:underline dark:text-indigo-300">XBRL <ExternalLink size={11} /></a>}
              </td>
            ))}
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

const noneReason = (data: Dashboard, what: string) =>
  data.noResultsReason && !data.statements.format ? data.noResultsReason
    : `No ${what} on file yet. They come from half-yearly (September) and annual (March) result filings, which are being read in the background.`;

export function BalanceSheetSection({ data }: { data: Dashboard }) {
  const block = data.statements.balanceSheet;
  const bank = data.statements.format === "bank";
  const periods = useMemo(() => block.periods.filter((p) => inRange(p.periodEnd, data.range)), [block, data.range]);
  const chart = periods.map((p) => ({
    label: monthYear(p.periodEnd), total_assets: p.values.total_assets,
    equity: bank ? (p.values.share_capital ?? 0) + (p.values.reserves ?? 0) : p.values.equity ?? p.values.owners_equity,
    debt: bank ? p.values.borrowings : (p.values.borrowings_current ?? 0) + (p.values.borrowings_noncurrent ?? 0),
    deposits: p.values.deposits,
  }));
  const empty = block.periods.length ? `No balance sheet dated between ${data.range.from} and ${data.range.to}. Choose 3Y or 5Y to include more.` : noneReason(data, "balance sheets");

  if (!block.periods.length) {
    return <Card className="motion-rise"><CardHeader title="Balance sheet" /><CardBody><InsufficientData message={empty} /></CardBody></Card>;
  }
  return (
    <div className="space-y-5">
      <ChartCard title="Balance sheet trend" subtitle={bank ? "Total assets, shareholders' funds, deposits and borrowings" : "Total assets, equity and borrowings"}
        unit="₹ Crore" points={chart.length} minPoints={1} empty={empty}>
        <PeriodBars data={chart} title={data.identity.company} format={inrCrore} series={[
          { key: "total_assets", label: "Total assets", color: "#4f46e5" },
          { key: "equity", label: bank ? "Shareholders' funds" : "Total equity", color: "#10b981" },
          ...(bank ? [{ key: "deposits", label: "Deposits", color: "#0ea5e9" }] : []),
          { key: "debt", label: "Borrowings", color: "#f59e0b" },
        ]} />
      </ChartCard>
      <Card className="motion-rise">
        <CardHeader title="Balance sheet" subtitle={`${bank ? "Banking format" : "Statement of assets and liabilities"} · ${periods.length} of ${block.periods.length} periods in the selected range`} />
        <div className="pt-3">
          {periods.length ? <StatementTable block={block} periods={periods} caption="Balance sheet" /> : <CardBody><InsufficientData message={empty} /></CardBody>}
        </div>
      </Card>
    </div>
  );
}

export function CashFlowSection({ data }: { data: Dashboard }) {
  const block = data.statements.cashFlow;
  const [scope, setScope] = useState<"annual" | "all">("annual");
  const periods = useMemo(() => block.periods
    .filter((p) => inRange(p.periodEnd, data.range))
    .filter((p) => scope === "all" || (p.months ?? 0) >= 12), [block, data.range, scope]);
  const chart = periods.map((p) => ({ label: periodLabel(p, true), cfo: p.values.cfo, cfi: p.values.cfi, cff: p.values.cff, fcf: p.values.fcf }));
  const empty = !block.periods.length ? noneReason(data, "cash flow statements")
    : scope === "annual" ? "No full-year cash flow statement in the selected range. Switch to include half-years or widen the range."
    : `No cash flow statement between ${data.range.from} and ${data.range.to}.`;

  if (!block.periods.length) {
    return <Card className="motion-rise"><CardHeader title="Cash flow" /><CardBody><InsufficientData message={empty} /></CardBody></Card>;
  }
  const toggle = <Segmented size="sm" value={scope} onChange={setScope} options={[{ value: "annual", label: "Full years" }, { value: "all", label: "Include half-years" }]} />;
  return (
    <div className="space-y-5">
      <ChartCard title="Cash flows" subtitle="Operating, investing and financing activities" unit="₹ Crore" points={chart.length} minPoints={1} empty={empty} actions={toggle}>
        <PeriodBars data={chart} title={data.identity.company} format={inrCrore} series={[
          { key: "cfo", label: "Operating", color: "#10b981" }, { key: "cfi", label: "Investing", color: "#6366f1" },
          { key: "cff", label: "Financing", color: "#f59e0b" },
          ...(chart.some((c) => isNum(c.fcf)) ? [{ key: "fcf", label: "Free cash flow", color: "#0ea5e9" }] : []),
        ]} />
      </ChartCard>
      <Card className="motion-rise">
        <CardHeader title="Cash flow statement" subtitle="Year-to-date figures as filed; outflows shown as negative" actions={toggle} />
        <div className="pt-3">
          {periods.length ? <StatementTable block={block} periods={periods} cashFlow caption="Cash flow statement" /> : <CardBody><InsufficientData message={empty} /></CardBody>}
        </div>
      </Card>
    </div>
  );
}
