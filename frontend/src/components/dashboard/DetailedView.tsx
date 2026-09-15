"use client";

import clsx from "clsx";
import { ExternalLink } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { sma, TimeChart } from "@/components/charts/TimeChart";
import { Documents, Peers } from "@/components/company/Sections";
import { Badge, Card, CardBody, CardHeader, Segmented } from "@/components/ui";
import { formatMetric, METRICS, type AnnualLine, type Dashboard, type QuarterLine } from "@/lib/dashboard";
import { countIN, dateOnly, dateTime, inr, inrCrore, isNum, monthYear, num, pct, percent, tone, type Num } from "@/lib/format";
import { PeriodBars, pointsIn, TrendLines, type Series } from "./Charts";
import { ChartCard, InsufficientData, NotAvailable, SectionTitle } from "./Parts";
import { BalanceSheetSection, CashFlowSection } from "./Statements";
import { COLORS, Observations, quarterSeries } from "./SummaryView";

const SECTIONS = [
  ["overview", "Overview"], ["price", "Price"], ["revenue", "Revenue"], ["gross-profit", "Gross profit"],
  ["net-profit", "Net profit"], ["eps", "EPS"], ["shares", "Shares"], ["valuation", "Valuation"],
  ["profitability", "Profitability"], ["growth", "Growth"], ["financials", "Financials"], ["balance-sheet", "Balance sheet"], ["cash-flow", "Cash flow"], ["performance", "Performance"],
  ["observations", "Observations"], ["peers", "Peers"], ["documents", "Documents"], ["sources", "Sources"],
] as const;

type Period = "quarterly" | "annual";

/** Metric rows in a definition list, each value or a reasoned "Not available". */
function MetricList({ data, keys }: { data: Dashboard; keys: string[] }) {
  return (
    <dl className="grid gap-x-6 sm:grid-cols-2">
      {keys.map((k) => {
        const v = data.metrics[k] as Num;
        return (
          <div key={k} className="flex items-baseline justify-between gap-3 border-b border-slate-100 py-2.5 dark:border-slate-800">
            <dt className="text-sm text-slate-500 dark:text-slate-400" title={METRICS[k]?.hint}>{METRICS[k]?.label ?? k}</dt>
            <dd className={clsx("tabular text-right text-sm font-semibold", METRICS[k]?.kind === "change" && tone(v))}>
              {isNum(v) ? formatMetric(k, v) : <NotAvailable reason={data.reasons[k]} compact />}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

function annualInRange(data: Dashboard): (AnnualLine & { label: string })[] {
  const { from, to } = data.range;
  return data.annual.filter((y) => {
    const end = `${y.label.slice(4)}-03-31`;
    return (!from || end >= from.slice(0, 4) + "-01-01") && (!to || end <= to);
  });
}

function PeriodToggle({ value, onChange }: { value: Period; onChange: (p: Period) => void }) {
  return <Segmented size="sm" value={value} onChange={onChange} options={[{ value: "quarterly", label: "Quarterly" }, { value: "annual", label: "Annual" }]} />;
}

const LINES: { key: keyof QuarterLine & keyof AnnualLine; label: string; kind: "cr" | "pct" | "inr"; strong?: boolean }[] = [
  { key: "sales", label: "Revenue", kind: "cr", strong: true },
  { key: "expenses", label: "Expenses", kind: "cr" },
  { key: "gross_profit", label: "Gross profit", kind: "cr" },
  { key: "gpm", label: "Gross margin", kind: "pct" },
  { key: "operating_profit", label: "Operating profit", kind: "cr", strong: true },
  { key: "opm", label: "Operating margin", kind: "pct" },
  { key: "other_income", label: "Other income", kind: "cr" },
  { key: "interest", label: "Interest", kind: "cr" },
  { key: "depreciation", label: "Depreciation", kind: "cr" },
  { key: "pbt", label: "Profit before tax", kind: "cr" },
  { key: "tax_pct", label: "Tax rate", kind: "pct" },
  { key: "net_profit", label: "Net profit", kind: "cr", strong: true },
  { key: "npm", label: "Net margin", kind: "pct" },
  { key: "eps", label: "EPS (₹, adjusted)", kind: "inr" },
];

function FinancialTable({ columns, footer }: { columns: { label: string; row: Partial<QuarterLine & AnnualLine>; highlight?: boolean }[]; footer?: ReactNode }) {
  const cell = (v: Num, kind: "cr" | "pct" | "inr") => {
    if (!isNum(v)) return <span className="text-slate-300 dark:text-slate-600" title="Not available in the filing">—</span>;
    if (kind === "pct") return `${num(v, 1)}%`;
    if (kind === "inr") return num(v, 2);
    return <span className={v < 0 ? "text-down" : undefined}>{num(v, 0)}</span>;
  };
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        <caption className="sr-only">Financial statement, amounts in ₹ crore</caption>
        <thead>
          <tr className="border-b border-slate-200 dark:border-slate-800">
            <th scope="col" className="sticky left-0 z-10 bg-white px-4 py-2.5 text-left text-xs font-semibold text-slate-500 dark:bg-slate-900">₹ Crore</th>
            {columns.map((c) => <th scope="col" key={c.label} className={clsx("whitespace-nowrap px-4 py-2.5 text-right text-xs font-semibold", c.highlight ? "text-indigo-600 dark:text-indigo-300" : "text-slate-500")}>{c.label}</th>)}
          </tr>
        </thead>
        <tbody className="motion-fade">
          {LINES.map((ln) => (
            <tr key={ln.key} className={clsx("border-b border-slate-100 last:border-0 dark:border-slate-800/70", ln.strong && "bg-slate-50/70 dark:bg-slate-800/30")}>
              <th scope="row" className={clsx("sticky left-0 z-10 whitespace-nowrap px-4 py-2 text-left font-normal", ln.strong ? "bg-slate-50 font-semibold dark:bg-slate-800" : "bg-white text-slate-600 dark:bg-slate-900 dark:text-slate-300")}>{ln.label}</th>
              {columns.map((c) => <td key={c.label} className={clsx("tabular whitespace-nowrap px-4 py-2 text-right", ln.strong && "font-semibold")}>{cell(c.row[ln.key] as Num, ln.kind)}</td>)}
            </tr>
          ))}
        </tbody>
        {footer}
      </table>
    </div>
  );
}

export function DetailedView({ data }: { data: Dashboard }) {
  const [period, setPeriod] = useState<Period>("quarterly");
  const [candles, setCandles] = useState(true);
  const [dma, setDma] = useState(true);
  const company = data.identity.company;
  const quarters = useMemo(() => quarterSeries(data.quartersInRange), [data.quartersInRange]);
  const years = useMemo(() => annualInRange(data), [data]);
  const periodRows = (period === "quarterly" ? quarters : years) as unknown as Record<string, unknown>[];
  const rangeLabel = `${dateOnly(data.range.from)} – ${dateOnly(data.range.to)}`;
  const emptyFin = data.noResultsReason ?? (period === "quarterly"
    ? `No quarter ended between ${rangeLabel}. Widen the date range.`
    : `No complete fiscal year (all four quarters verified) ends in ${rangeLabel}.`);

  // Year-on-year growth per quarter, matching the same quarter a year earlier.
  const yoy = useMemo(() => data.quarters.map((q) => {
    const target = `${Number(q.period_end.slice(0, 4)) - 1}${q.period_end.slice(4)}`;
    const ly = data.quarters.find((x) => x.period_end === target);
    const g = (a: Num, b: Num) => (isNum(a) && isNum(b) && b !== 0 ? ((a - b) / Math.abs(b)) * 100 : null);
    return { period_end: q.period_end, label: monthYear(q.period_end), sales: g(q.sales, ly?.sales), net_profit: g(q.net_profit, ly?.net_profit), eps: g(q.eps, ly?.eps) };
  }).filter((r) => quarters.some((q) => q.period_end === r.period_end)), [data.quarters, quarters]);

  const overlays = useMemo(() => dma && data.prices.length >= 50 ? [{ name: "50 DMA", color: "#f59e0b", points: sma(data.prices, 50) }] : [], [data.prices, dma]);
  const peLine = useMemo(() => data.valuationSeries.map((p) => ({ t: p.t, value: p.pe })), [data.valuationSeries]);
  const sharesRows = useMemo(() => {
    const byDate = new Map<string, { label: string; t: string; filing: Num; holding: Num }>();
    for (const q of data.quartersInRange) if (isNum(q.shares)) byDate.set(q.period_end, { t: q.period_end, label: monthYear(q.period_end), filing: q.shares / 1e7, holding: null });
    for (const h of data.shareholdingInRange) if (isNum(h.total_shares)) {
      const cur = byDate.get(h.as_of_date) ?? { t: h.as_of_date, label: monthYear(h.as_of_date), filing: null, holding: null };
      cur.holding = h.total_shares / 1e7;
      byDate.set(h.as_of_date, cur);
    }
    return [...byDate.values()].sort((a, b) => a.t.localeCompare(b.t));
  }, [data.quartersInRange, data.shareholdingInRange]);

  const bars = (series: Series[], empty = emptyFin) => (
    <PeriodBars data={periodRows} series={series} title={company} format={inrCrore}
      details={(r) => [
        ...(isNum(r.npm as Num) ? [{ label: "Net margin", value: percent(r.npm as number) }] : []),
        ...(isNum(r.eps as Num) ? [{ label: "EPS", value: inr(r.eps as number) }] : []),
      ]} />
  );

  return (
    <div className="grid gap-6 lg:grid-cols-[11rem_1fr]">
      <nav aria-label="Sections" className="hidden lg:block">
        <ul className="sticky top-60 space-y-0.5 text-sm">
          {SECTIONS.map(([id, label]) => (
            <li key={id}><a href={`#${id}`} className="block rounded-lg px-2.5 py-1.5 text-slate-500 hover:bg-white hover:text-slate-900 dark:hover:bg-slate-900 dark:hover:text-white">{label}</a></li>
          ))}
        </ul>
      </nav>

      <div className="min-w-0 space-y-5">
        <SectionTitle id="overview">1 · Company overview</SectionTitle>
        <Card className="motion-rise">
          <CardBody className="grid gap-6 md:grid-cols-2">
            <dl className="space-y-2 text-sm">
              {[
                ["Company", company], ["NSE symbol", data.identity.symbol ?? "Not listed on NSE"],
                ["BSE code", data.identity.bseCode ?? "Not listed on BSE"], ["ISIN", data.identity.isin ?? "—"],
                ["Industry", data.identity.industry ?? "Not classified"], ["Instrument", data.identity.instrumentType],
                ["Listed on NSE", dateOnly(data.identity.listingDate)], ["Face value", isNum(data.identity.faceValue) ? inr(data.identity.faceValue) : "—"],
                ["Reporting basis", data.basis.used ? `${data.basis.used[0].toUpperCase()}${data.basis.used.slice(1)}` : "No verified results"],
                ["Report format", data.reportFormat === "bank" ? "Banking" : data.reportFormat === "corporate" ? "Ind-AS corporate" : "—"],
              ].map(([k, v]) => (
                <div key={k} className="flex gap-3"><dt className="w-32 shrink-0 text-slate-500">{k}</dt><dd className="min-w-0 break-words font-medium">{v}</dd></div>
              ))}
            </dl>
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">Index membership</p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {data.identity.indices.length === 0 ? <span className="text-sm text-slate-500">Not in a tracked NSE index.</span>
                  : data.identity.indices.map((i) => <Badge key={i.slug}>{i.name}</Badge>)}
              </div>
              <p className="mt-5 text-xs font-semibold uppercase tracking-wider text-slate-500">Data on file</p>
              <p className="mt-1 text-sm">Prices {dateOnly(data.dataPeriod.pricesFrom)} – {dateOnly(data.dataPeriod.pricesTo)}</p>
              <p className="text-sm">Results {data.dataPeriod.resultsFrom ? `${monthYear(data.dataPeriod.resultsFrom)} – ${monthYear(data.dataPeriod.resultsTo)}` : "none verified yet"}</p>
            </div>
          </CardBody>
        </Card>

        <SectionTitle id="price">2 · Price history</SectionTitle>
        <ChartCard title="Price and volume" subtitle={`${data.exchange}, ${rangeLabel}`} unit="₹ per share" points={data.prices.length}
          empty={`No ${data.exchange} prices between ${rangeLabel}.`}
          actions={<>
            <Segmented size="sm" value={candles ? "c" : "l"} onChange={(v) => setCandles(v === "c")} options={[{ value: "c", label: "Candles" }, { value: "l", label: "Line" }]} />
            <label className="flex items-center gap-1.5 text-xs text-slate-600 dark:text-slate-300">
              <input type="checkbox" checked={dma} onChange={(e) => setDma(e.target.checked)} className="accent-indigo-600" /> 50 DMA
            </label>
          </>}>
          <TimeChart mode={candles ? "candles" : "area"} bars={data.prices} overlays={overlays} showVolume height={380} title={company} />
        </ChartCard>

        <SectionTitle id="revenue">3 · Revenue history</SectionTitle>
        <ChartCard title="Revenue" subtitle={period === "quarterly" ? "Per quarter" : "Per fiscal year (April–March)"} unit="₹ Crore"
          points={pointsIn(periodRows, [{ key: "sales", label: "", color: "" }])} empty={emptyFin} actions={<PeriodToggle value={period} onChange={setPeriod} />}>
          {bars([{ key: "sales", label: "Revenue", color: COLORS.sales }])}
        </ChartCard>

        <SectionTitle id="gross-profit">4 · Gross profit history</SectionTitle>
        <ChartCard title="Gross profit" subtitle="Revenue minus cost of materials, purchases and inventory change" unit="₹ Crore"
          points={pointsIn(periodRows, [{ key: "gross_profit", label: "", color: "" }])}
          empty={data.metrics.gross_profit_ttm == null && data.reasons.gross_profit_ttm ? data.reasons.gross_profit_ttm : emptyFin}
          actions={<PeriodToggle value={period} onChange={setPeriod} />}>
          <PeriodBars data={periodRows} title={company} format={inrCrore} series={[{ key: "gross_profit", label: "Gross profit", color: COLORS.gross }]}
            details={(r) => (isNum(r.gpm as Num) ? [{ label: "Gross margin", value: percent(r.gpm as number) }] : [])} />
        </ChartCard>

        <SectionTitle id="net-profit">5 · Net profit history</SectionTitle>
        <ChartCard title="Net profit" subtitle="After tax, attributable to the reporting entity" unit="₹ Crore"
          points={pointsIn(periodRows, [{ key: "net_profit", label: "", color: "" }])} empty={emptyFin} actions={<PeriodToggle value={period} onChange={setPeriod} />}>
          {bars([{ key: "net_profit", label: "Net profit", color: COLORS.profit }])}
        </ChartCard>

        <SectionTitle id="eps">6 · EPS history</SectionTitle>
        <ChartCard title="Earnings per share" subtitle="Basic EPS, restated for later splits and bonuses" unit="₹ per share"
          points={pointsIn(periodRows, [{ key: "eps", label: "", color: "" }])} empty={emptyFin} actions={<PeriodToggle value={period} onChange={setPeriod} />}>
          <TrendLines data={periodRows} title={company} format={(v) => inr(v)} axis={(v) => `₹${num(v, Math.abs(v) < 100 ? 1 : 0)}`} series={[{ key: "eps", label: "EPS", color: COLORS.eps }]} />
        </ChartCard>

        <SectionTitle id="shares">7 · Shares and ownership</SectionTitle>
        <div className="grid gap-5 xl:grid-cols-2">
          <ChartCard title="Shares outstanding" subtitle="From result filings and shareholding patterns" unit="crore shares"
            points={sharesRows.length} empty="No share counts were filed in this period.">
            <TrendLines data={sharesRows} title={company} format={(v) => `${num(v, 2)} Cr`} axis={(v) => num(v, 0)}
              series={[{ key: "filing", label: "Result filing", color: COLORS.shares }, { key: "holding", label: "Shareholding pattern", color: COLORS.sales }]} />
          </ChartCard>
          <ChartCard title="Ownership trend" subtitle="Percent of equity by holder category" unit="%"
            points={data.shareholdingInRange.length} empty="No shareholding pattern was filed in this period.">
            <TrendLines data={data.shareholdingInRange.map((h) => ({ ...h, label: monthYear(h.as_of_date) }))} title={company}
              format={(v) => `${num(v, 2)}%`} axis={(v) => `${Math.round(v)}%`}
              details={(r) => (isNum(r.shareholders as Num) ? [{ label: "Shareholders", value: countIN(r.shareholders as number) }] : [])}
              series={[
                { key: "promoter", label: "Promoters", color: "#4f46e5" }, { key: "fii", label: "FIIs", color: "#0ea5e9" },
                { key: "dii", label: "DIIs", color: "#10b981" }, { key: "public", label: "Public", color: "#e11d48" },
              ]} />
          </ChartCard>
        </div>
        <HoldingTable data={data} />

        <SectionTitle id="valuation">8 · Valuation</SectionTitle>
        <div className="grid gap-5 xl:grid-cols-2">
          <Card className="motion-rise"><CardHeader title="Valuation metrics" subtitle={`At the ${data.exchange} close of ${dateOnly(data.quote?.session)}`} />
            <CardBody><MetricList data={data} keys={["close", "market_cap", "pe", "pb", "eps_ttm", "bvps", "book_value", "dividend_ttm", "dividend_yield", "shares"]} /></CardBody>
          </Card>
          <ChartCard title="P/E through time" subtitle="Close ÷ trailing EPS known on each date" unit="times earnings" points={peLine.length}
            empty="P/E history needs four consecutive verified quarters with positive earnings.">
            <TimeChart mode="line" line={peLine} showVolume={false} height={300} valueFormat={(v) => num(v, 1)} title={company} valueLabel="P/E" />
          </ChartCard>
        </div>

        <SectionTitle id="profitability">9 · Profitability</SectionTitle>
        <div className="grid gap-5 xl:grid-cols-2">
          <ChartCard title="Margins" subtitle={period === "quarterly" ? "Per quarter" : "Per fiscal year"} unit="% of revenue"
            points={pointsIn(periodRows, [{ key: "npm", label: "", color: "" }])} empty={emptyFin} actions={<PeriodToggle value={period} onChange={setPeriod} />}>
            <TrendLines data={periodRows} title={company} format={(v) => percent(v, 1)} axis={(v) => `${Math.round(v)}%`} series={[
              { key: "opm", label: "Operating", color: COLORS.op }, { key: "gpm", label: "Gross", color: COLORS.gross }, { key: "npm", label: "Net", color: COLORS.profit },
            ]} />
          </ChartCard>
          <Card className="motion-rise"><CardHeader title="Returns on capital" subtitle={data.balance ? `Balance sheet of ${dateOnly(data.balance.periodEnd)} (${data.balance.basis})` : undefined} />
            <CardBody><MetricList data={data} keys={["opm_ttm", "gpm_ttm", "npm_ttm", "roe", "debt_to_equity", "current_ratio", "cash", "cfo_fy", "capex_fy", "fcf_fy"]} />
              {data.balance && (
                <p className="mt-3 text-xs text-slate-500">Equity {inrCrore(data.balance.equity)} · Borrowings {isNum(data.balance.borrowings) ? inrCrore(data.balance.borrowings) : "not reported"} · Total assets {inrCrore(data.balance.totalAssets)}</p>
              )}
            </CardBody>
          </Card>
        </div>

        <SectionTitle id="growth">10 · Growth</SectionTitle>
        <div className="grid gap-5 xl:grid-cols-2">
          <ChartCard title="Year-on-year growth" subtitle="Each quarter against the same quarter a year earlier" unit="%"
            points={pointsIn(yoy, [{ key: "sales", label: "", color: "" }])} empty="Year-on-year growth needs the same quarter a year earlier on file.">
            <PeriodBars data={yoy} title={company} format={(v) => pct(v, 1)} axis={(v) => `${Math.round(v)}%`} series={[
              { key: "sales", label: "Revenue", color: COLORS.sales }, { key: "net_profit", label: "Net profit", color: COLORS.profit },
            ]} />
          </ChartCard>
          <Card className="motion-rise"><CardHeader title="Growth rates" />
            <CardBody>
              <MetricList data={data} keys={["sales_qtr_yoy", "profit_qtr_yoy", "revenue_ttm_growth", "profit_ttm_growth", "eps_ttm_growth", "sales_cagr_3y", "profit_cagr_3y"]} />
              <div className="mt-4 grid grid-cols-3 gap-3 text-sm">
                {(["sales", "profit", "eps"] as const).map((k) => (
                  <div key={k} className="rounded-xl border border-slate-200 p-3 dark:border-slate-800">
                    <p className="text-xs font-semibold capitalize text-slate-500">{k === "eps" ? "EPS" : k} CAGR</p>
                    {Object.keys(data.growth[k]).length === 0 ? <p className="mt-1 text-xs text-slate-400">Needs 4+ complete fiscal years</p>
                      : Object.entries(data.growth[k]).map(([p, v]) => <p key={p} className="tabular mt-1 flex justify-between"><span className="text-slate-500">{p}</span><span className={tone(v)}>{pct(v, 1)}</span></p>)}
                  </div>
                ))}
              </div>
            </CardBody>
          </Card>
        </div>

        <SectionTitle id="financials">11 · Historical financial data</SectionTitle>
        <Card className="motion-rise">
          <CardHeader title={period === "quarterly" ? "Quarterly results" : "Annual results"}
            subtitle={data.basis.used ? `${data.basis.used} figures parsed from each filing's XBRL` : undefined}
            actions={<PeriodToggle value={period} onChange={setPeriod} />} />
          <div className="pt-3">
            {(period === "quarterly" ? quarters.length : years.length) === 0 ? <CardBody><InsufficientData message={emptyFin} /></CardBody> : period === "quarterly" ? (
              <FinancialTable columns={quarters.map((q) => ({ label: q.label, row: q }))} footer={
                <tfoot><tr><th scope="row" className="sticky left-0 bg-white px-4 py-2 text-left text-xs font-normal text-slate-500 dark:bg-slate-900">Source</th>
                  {quarters.map((q) => <td key={q.period_end} className="px-4 py-2 text-right">{q.xbrl_url && <a href={q.xbrl_url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs text-indigo-600 hover:underline dark:text-indigo-300">XBRL <ExternalLink size={11} /></a>}</td>)}
                </tr></tfoot>} />
            ) : (
              <FinancialTable columns={[...years.map((y) => ({ label: y.label, row: y })), ...(data.ttm ? [{ label: "TTM", row: data.ttm, highlight: true }] : [])]} />
            )}
          </div>
        </Card>

        <SectionTitle id="balance-sheet">12 · Balance sheet</SectionTitle>
        <BalanceSheetSection data={data} />

        <SectionTitle id="cash-flow">13 · Cash flow</SectionTitle>
        <CashFlowSection data={data} />

        <SectionTitle id="performance">14 · Stock performance</SectionTitle>
        <Card className="motion-rise">
          <CardHeader title="Returns" subtitle={`${data.exchange} closes, adjusted for splits and bonuses, to ${dateOnly(data.quote?.session)}`} />
          <CardBody>
            <div className="motion-stagger grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
              {["ret_1w", "ret_1m", "ret_3m", "ret_6m", "ret_1y", "ret_3y", "ret_5y"].map((k) => (
                <div key={k} className="rounded-xl border border-slate-200 p-3 text-center dark:border-slate-800">
                  <p className="text-xs text-slate-500">{METRICS[k].label}</p>
                  <p className={clsx("tabular mt-1 text-base font-semibold", tone(data.metrics[k] as Num))}>
                    {isNum(data.metrics[k] as Num) ? pct(data.metrics[k] as number, 1) : <NotAvailable reason={data.reasons[k]} compact />}
                  </p>
                </div>
              ))}
            </div>
            <div className="mt-4"><MetricList data={data} keys={["high_52w", "low_52w", "volume"]} /></div>
          </CardBody>
        </Card>

        <SectionTitle id="observations">15 · Analysis</SectionTitle>
        <Observations data={data} />

        <SectionTitle id="peers">16 · Peers</SectionTitle>
        {data.mode === "latest" && data.identity.symbol ? <Peers symbol={data.identity.symbol} />
          : <Card><CardBody><InsufficientData message={data.mode === "latest" ? "Peer comparison uses NSE sector lists; this company is listed only on BSE." : "Peer figures are current only, so they are hidden for historical views."} /></CardBody></Card>}

        <SectionTitle id="documents">17 · Filings in the selected period</SectionTitle>
        <Documents symbol={data.identity.key} from={data.range.from} to={data.range.to} />

        <SectionTitle id="sources">18 · Data sources and freshness</SectionTitle>
        <Sources data={data} />
      </div>
    </div>
  );
}

function HoldingTable({ data }: { data: Dashboard }) {
  const rows = data.shareholdingInRange.slice(-12);
  if (!rows.length) return null;
  const keys = [["promoter", "Promoters"], ["fii", "FIIs"], ["dii", "DIIs"], ["government", "Government"], ["public", "Public"], ["others", "Others"]] as const;
  return (
    <Card className="motion-rise">
      <CardHeader title="Shareholding pattern" subtitle="Percent of equity" />
      <div className="overflow-x-auto pt-3">
        <table className="w-full text-sm">
          <thead><tr className="border-b border-slate-200 dark:border-slate-800">
            <th scope="col" className="sticky left-0 bg-white px-4 py-2 text-left text-xs font-semibold text-slate-500 dark:bg-slate-900">Holder</th>
            {rows.map((r) => <th scope="col" key={r.as_of_date} className="whitespace-nowrap px-4 py-2 text-right text-xs font-semibold text-slate-500">{monthYear(r.as_of_date)}</th>)}
          </tr></thead>
          <tbody>
            {keys.filter(([k]) => rows.some((r) => isNum(r[k]))).map(([k, label]) => (
              <tr key={k} className="border-b border-slate-100 dark:border-slate-800/70">
                <th scope="row" className="sticky left-0 bg-white px-4 py-2 text-left font-normal text-slate-600 dark:bg-slate-900 dark:text-slate-300">{label}</th>
                {rows.map((r) => <td key={r.as_of_date} className="tabular px-4 py-2 text-right">{isNum(r[k]) ? `${num(r[k], 2)}%` : <span className="text-slate-300">—</span>}</td>)}
              </tr>
            ))}
            <tr><th scope="row" className="sticky left-0 bg-white px-4 py-2 text-left font-normal text-slate-600 dark:bg-slate-900 dark:text-slate-300">Shareholders</th>
              {rows.map((r) => <td key={r.as_of_date} className="tabular px-4 py-2 text-right">{isNum(r.shareholders) ? countIN(r.shareholders) : <span className="text-slate-300">—</span>}</td>)}</tr>
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function Sources({ data }: { data: Dashboard }) {
  const f = data.freshness;
  const rows: [string, ReactNode][] = [
    ["Prices", <>{f.prices.source}; session {dateOnly(f.prices.session)} (newest stored {dateOnly(f.prices.latestStored)})</>],
    ["Financial results", f.results.source ? <>{f.results.source}; latest quarter {dateOnly(f.results.latestQuarter)}, filed {dateTime(f.results.filedAt)}{f.results.pendingFilings ? `; ${f.results.pendingFilings} filings queued for parsing` : ""}</> : "Not available for this company"],
    ["Shareholding", f.shareholding.source ? <>{f.shareholding.source}; as of {dateOnly(f.shareholding.asOf)}</> : "Not available for this company"],
    ["Shares outstanding", data.sharesInfo ? <>{data.sharesInfo.source}, {dateOnly(data.sharesInfo.asOf)}</> : "Not available"],
    ["Computed", data.mode === "version" && data.version ? <>Stored analysis v{data.version.version}, saved {dateTime(data.version.created_at)}</> : dateTime(f.computedAt)],
  ];
  return (
    <Card className="motion-rise">
      <CardBody>
        <dl className="space-y-2.5 text-sm">
          {rows.map(([k, v]) => <div key={k} className="flex flex-col gap-0.5 sm:flex-row sm:gap-4"><dt className="w-40 shrink-0 text-slate-500">{k}</dt><dd>{v}</dd></div>)}
        </dl>
        {Object.keys(data.sources).length > 0 && (
          <div className="mt-4 border-t border-slate-100 pt-3 text-xs text-slate-500 dark:border-slate-800">
            <p className="font-semibold">How figures are derived</p>
            <ul className="mt-1 space-y-0.5">{Object.entries(data.sources).map(([k, v]) => <li key={k}><span className="font-medium text-slate-600 dark:text-slate-300">{METRICS[k]?.label ?? k}:</span> {v}</li>)}</ul>
          </div>
        )}
        {f.notes.length > 0 && <ul className="mt-3 list-disc pl-5 text-xs text-slate-500">{f.notes.map((n) => <li key={n}>{n}</li>)}</ul>}
      </CardBody>
    </Card>
  );
}
