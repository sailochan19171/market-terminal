"use client";

// Order wins, read out of the companies' own announcement PDFs.
//
// Two views of the same rows: every order as it was filed, and the companies whose wins are large against their
// own revenue. Every figure is the filing's own, with a link to the PDF it came from, and a row says plainly
// when the filing did not state something rather than filling the gap.
import clsx from "clsx";
import { ChevronDown, ChevronRight, ExternalLink, FileText, RefreshCw, Search, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { DataTable } from "@/components/DataTable";
import { CapSlider, DateBox, isoDay, NumberBox, Picker, ShareChip, type Option } from "@/components/orders/controls";
import { Badge, Card, ErrorNote, Loading, PageTitle, Segmented, Stat } from "@/components/ui";
import { useApi } from "@/lib/api";
import { inrCrore } from "@/lib/format";

interface Order {
  id: string; exchange: string; symbol: string | null; company: string; announcedAt: string;
  customer: string | null; orderType: string | null; contractValueCr: number | null; currency: string | null;
  durationMonths: number | null; annualValueCr: number | null; orderSizePct: number | null;
  workScope: string | null; location: string | null; summary: string | null; pdfUrl: string | null;
  extractedBy: string | null; model: string | null; confidence: number | null; note: string | null;
  revenueCr: number | null; revenueBasis: string | null; revenueQuarter: string | null; marketCapCr: number | null;
}
interface OrdersPage {
  months: number; total: number; rows: Order[];
  options: { companies: Option[]; customers: Option[]; orderTypes: string[] };
  coverage: { orders: number; notOrders: number; unreadable: number; lastExtractedAt: string | null };
}
interface CompanyRow {
  symbol: string | null; company: string; industry: string | null; orderCount: number; totalOrderValueCr: number;
  totalAnnualValueCr: number; revenueCr: number | null; revenueBasis: string | null; revenueQuarter: string | null;
  marketCapCr: number | null; ordersPctOfRevenue: number | null; latestOrderAt: string; orders: Order[];
}

/**
 * The periods the dashboard offers, each as a number of days back from today. Choosing one moves the two
 * calendar boxes, and moving a calendar box switches the period to "custom": the control and the dates can
 * never disagree about what is on screen.
 */
const PERIODS: { value: string; label: string; back: number }[] = [
  { value: "today", label: "Today", back: 0 },
  { value: "3d", label: "Last 3 days", back: 2 },
  { value: "7d", label: "This week", back: 6 },
  { value: "1", label: "1 month", back: 30 },
  { value: "3", label: "3 months", back: 91 },
  { value: "6", label: "6 months", back: 182 },
  { value: "12", label: "12 months", back: 365 },
  { value: "24", label: "2 years", back: 730 },
];
const CUSTOM: Option = { value: "custom", label: "Custom dates" };
const periodLabel = (value: string) => PERIODS.find((p) => p.value === value)?.label ?? CUSTOM.label;

/** The first and last day of a preset period, as the calendar writes them. */
function periodDates(value: string): { from: string; to: string } {
  const p = PERIODS.find((x) => x.value === value) ?? PERIODS[0];
  const start = new Date();
  start.setDate(start.getDate() - p.back);
  return { from: isoDay(start), to: isoDay() };
}

/** Which preset a pair of dates is, if any - so picking "today" in the calendar shows "Today". */
function periodOf(from: string, to: string): string {
  const match = PERIODS.find((p) => {
    const d = periodDates(p.value);
    return d.from === from && d.to === to;
  });
  return match?.value ?? "custom";
}

const day = (iso: string) => new Date(iso).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
const months = (m: number | null) => (m === null ? "Not mentioned" : m >= 1 ? `${Number.isInteger(m) ? m : m.toFixed(1)} months` : `${Math.round(m * 30.44)} days`);
const value = (v: number | null) => (v === null ? "Not mentioned" : inrCrore(v));

export default function OrdersPage() {
  const [tab, setTab] = useState<"orders" | "companies">("orders");
  return (
    <>
      <PageTitle title="Order wins"
        subtitle="Contracts and orders companies have told NSE and BSE about, with the value, customer and period read out of the filing itself."
        actions={<Link href="/agents" className="hidden rounded-lg border border-slate-200 px-3 py-1.5 text-sm font-medium text-slate-700 hover:border-indigo-300 hover:text-indigo-700 sm:inline-block dark:border-slate-700 dark:text-slate-200">Analyst agents</Link>} />
      <div className="mb-4 flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-sm text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
        <TriangleAlert size={16} className="mt-0.5 shrink-0" />
        <p>Order details are read out of the PDF by a language model and may contain mistakes. Open the filing beside each row and check it before acting on it. Educational research, not investment advice.</p>
      </div>
      <Segmented value={tab} onChange={setTab} options={[{ value: "orders", label: "All orders" }, { value: "companies", label: "Orders against revenue" }]} />
      <div className="mt-4">{tab === "orders" ? <AllOrders /> : <ByCompany />}</div>
    </>
  );
}

// --- every order ------------------------------------------------------------------------------------

function AllOrders() {
  // Today by default, in both the period and the calendar: an order filed this morning is what a reader comes
  // here for. Either control can be changed to look at another day or a longer stretch.
  const [from, setFrom] = useState(() => isoDay());
  const [to, setTo] = useState(() => isoDay());
  const period = periodOf(from, to);
  const [company, setCompany] = useState("");
  const [customer, setCustomer] = useState("");
  const [minPct, setMinPct] = useState("");
  const [input, setInput] = useState("");
  const [q, setQ] = useState("");
  useEffect(() => { const t = setTimeout(() => setQ(input.trim()), 300); return () => clearTimeout(t); }, [input]);

  const params = new URLSearchParams({ from, to, months: "60", days: period === "today" ? "1" : "", limit: "1000" });
  if (!params.get("days")) params.delete("days");
  if (company) params.set("company", company);
  if (customer) params.set("customer", customer);
  if (minPct) params.set("minOrderPct", minPct);
  if (q) params.set("q", q);
  const { data, error, loading, reload } = useApi<OrdersPage>(`/api/v2/orders?${params}`);

  const totalValue = useMemo(() => (data?.rows ?? []).reduce((s, r) => s + (r.contractValueCr ?? 0), 0), [data]);
  // A customer belongs to a company and a period: changing either would leave a customer selected who placed no
  // order in what is now on screen, so the customer is cleared with it. The lists themselves come back from the
  // server already narrowed by the other filters.
  const chooseCompany = (v: string) => { setCompany(v); setCustomer(""); };
  const choosePeriod = (v: string) => {
    const d = periodDates(v || "today");
    setFrom(d.from);
    setTo(d.to);
    setCustomer("");
  };
  // A first day after the last day would show nothing: the other end follows it instead.
  const chooseFrom = (v: string) => { if (!v) return; setFrom(v); if (v > to) setTo(v); setCustomer(""); };
  const chooseTo = (v: string) => { if (!v) return; setTo(v); if (v < from) setFrom(v); setCustomer(""); };

  return (
    <Card>
      {/* One grid, so the controls keep their columns however narrow the window gets. */}
      <div className="grid grid-cols-2 gap-2.5 px-4 pt-4 md:grid-cols-3 xl:grid-cols-6 sm:px-5">
        <Picker label="Company" value={company} onChange={chooseCompany} options={data?.options.companies ?? []} placeholder="All companies" />
        <Picker label="Customer" value={customer} onChange={setCustomer} options={data?.options.customers ?? []} placeholder="All customers" />
        <Picker label="Period" value={period} onChange={choosePeriod} options={[...PERIODS, CUSTOM]} />
        <DateBox label="From" value={from} onChange={chooseFrom} max={isoDay()} />
        <DateBox label="To" value={to} onChange={chooseTo} max={isoDay()} min={from} />
        <NumberBox label="Min order size %" value={minPct} onChange={setMinPct} suffix="% rev" />
      </div>
      <div className="flex gap-2.5 px-4 pt-2.5 sm:px-5">
        <div className="relative min-w-0 flex-1">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input value={input} onChange={(e) => setInput(e.target.value)} placeholder="Search company, customer or work" aria-label="Search orders"
            className="h-[2.75rem] w-full rounded-xl border border-slate-200 bg-white pl-9 pr-3 text-sm outline-none focus:border-indigo-400 dark:border-slate-700 dark:bg-slate-900" />
        </div>
        <button type="button" onClick={reload} className="inline-flex h-[2.75rem] shrink-0 items-center gap-1.5 rounded-xl border border-emerald-300 px-3.5 text-sm font-semibold text-emerald-700 transition hover:bg-emerald-50 dark:border-emerald-500/40 dark:text-emerald-300 dark:hover:bg-emerald-500/10">
          <RefreshCw size={14} className={loading ? "animate-spin" : ""} /> Refresh
        </button>
      </div>

      <div className="grid gap-3 px-4 pt-4 sm:grid-cols-3 sm:px-5">
        <Stat label="Orders found" value={data ? data.total.toLocaleString("en-IN") : "—"}
          hint={from === to ? `filed on ${day(from)}` : `filed between ${day(from)} and ${day(to)}`} />
        <Stat label="Value of orders" value={data ? inrCrore(totalValue) : "—"} hint="adding only orders whose value the filing states" />
        <Stat label="Filings read" value={data ? data.coverage.orders.toLocaleString("en-IN") : "—"}
          hint={data?.coverage.lastExtractedAt ? `last read ${day(data.coverage.lastExtractedAt)}` : "from the exchanges' own order category"} />
      </div>

      {error && <ErrorNote message={error} onRetry={reload} />}
      <div className={clsx("pt-4 transition-opacity", loading && "opacity-60")}>
        {loading && !data ? <Loading rows={10} /> : (
          <DataTable dense pageSize={25} rows={data?.rows ?? []} rowKey={(r) => r.id}
            empty={from === to ? `No order announcements were filed on ${day(from)}. Pick another date.` : `No orders were filed between ${day(from)} and ${day(to)} that match these filters.`}
            initialSort={{ key: "announcedAt", dir: "desc" }}
            columns={[
              {
                key: "company", label: "Company", sticky: true, sortValue: (r) => r.company, className: "w-[15rem] min-w-[15rem] max-w-[15rem]",
                render: (r) => (
                  <div className="w-[14rem] truncate">
                    {r.symbol
                      ? <Link href={`/company/${encodeURIComponent(r.symbol)}`} className="font-medium text-indigo-700 hover:underline dark:text-indigo-300">{r.company}</Link>
                      : <span className="font-medium">{r.company}</span>}
                    <span className="ml-1.5 text-[11px] text-slate-400">{r.exchange}</span>
                  </div>
                ),
              },
              {
                key: "customer", label: "Customer", sortValue: (r) => r.customer ?? "", className: "w-[14rem] min-w-[14rem] max-w-[14rem]",
                render: (r) => <span className="block w-[13rem] truncate" title={r.customer ?? ""}>{r.customer ?? <span className="text-slate-400">Not mentioned</span>}</span>,
              },
              {
                key: "orderType", label: "Order Type", sortValue: (r) => r.orderType ?? "", className: "w-[10rem] min-w-[10rem]",
                render: (r) => <span className="block truncate" title={r.orderType ?? ""}>{r.orderType ?? <span className="text-slate-400">Not mentioned</span>}</span>,
              },
              { key: "announcedAt", label: "Date", align: "right", sortValue: (r) => r.announcedAt, className: "w-[7.5rem]", render: (r) => <span className="tabular-nums">{day(r.announcedAt)}</span> },
              {
                key: "contractValueCr", label: "Contract Value", align: "right", sortValue: (r) => r.contractValueCr ?? -1, className: "w-[8rem]",
                render: (r) => <span className={clsx("tabular-nums font-medium", r.contractValueCr === null && "text-slate-400")}>{value(r.contractValueCr)}</span>,
              },
              { key: "durationMonths", label: "Duration", align: "right", sortValue: (r) => r.durationMonths ?? -1, className: "w-[7rem]", render: (r) => <span className={clsx("tabular-nums", r.durationMonths === null && "text-slate-400")}>{months(r.durationMonths)}</span> },
              {
                key: "annualValueCr", label: "Annual Value", align: "right", sortValue: (r) => r.annualValueCr ?? -1, className: "w-[8rem]",
                render: (r) => <span className="tabular-nums" title={r.durationMonths && r.durationMonths > 12 ? "the contract value spread over its execution period" : "the contract runs a year or less, so the whole value falls in one year"}>{value(r.annualValueCr)}</span>,
              },
              { key: "orderSizePct", label: "Order Size %", align: "right", sortValue: (r) => r.orderSizePct ?? -1, className: "w-[7.5rem]", render: (r) => <ShareChip pct={r.orderSizePct} /> },
              {
                key: "revenueCr", label: "Company Revenue", align: "right", sortValue: (r) => r.revenueCr ?? -1, className: "w-[9rem]",
                render: (r) => r.revenueCr === null
                  ? <span className="text-xs text-slate-400">not on file</span>
                  : <span className="tabular-nums" title={`twelve months to ${r.revenueQuarter ?? "the latest quarter"}${r.revenueBasis ? `, ${r.revenueBasis}` : ""}`}>{inrCrore(r.revenueCr)}</span>,
              },
              {
                key: "pdf", label: "Filing", sortable: false, align: "right", className: "w-[5.5rem]",
                render: (r) => r.pdfUrl
                  ? <a href={r.pdfUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs text-indigo-600 hover:underline dark:text-indigo-300"><FileText size={13} /> PDF <ExternalLink size={11} /></a>
                  : <span className="text-xs text-slate-400">—</span>,
              },
            ]}
            searchable={false}
          />
        )}
      </div>
      <p className="px-4 pb-4 pt-2 text-xs text-slate-500 sm:px-5">
        Order size % is the order&apos;s annual value against the company&apos;s latest twelve-month revenue. A company with no revenue on file shows no percentage.
      </p>
    </Card>
  );
}

// --- by company -------------------------------------------------------------------------------------

function ByCompany() {
  // Six months by default here: a company's order book against its revenue needs more than a single day.
  const [from, setFrom] = useState(() => periodDates("6").from);
  const [to, setTo] = useState(() => isoDay());
  const period = periodOf(from, to);
  const [minRevenuePct, setMinRevenuePct] = useState("0");
  const [cap, setCap] = useState<[number, number]>([500, Number.POSITIVE_INFINITY]);
  const [input, setInput] = useState("");
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<Record<string, boolean>>({});
  useEffect(() => { const t = setTimeout(() => setQ(input.trim()), 300); return () => clearTimeout(t); }, [input]);

  const params = new URLSearchParams({ from, to, months: "60", limit: "300" });
  if (minRevenuePct) params.set("minRevenuePct", minRevenuePct);
  if (cap[0] > 0) params.set("minMarketCap", String(cap[0]));
  if (Number.isFinite(cap[1])) params.set("maxMarketCap", String(cap[1]));
  if (q) params.set("q", q);
  const { data, error, loading, reload } = useApi<{ months: number; count: number; rows: CompanyRow[] }>(`/api/v2/orders/companies?${params}`);

  return (
    <Card>
      <p className="px-4 pt-4 text-sm text-slate-600 sm:px-5 dark:text-slate-300">
        Orders won between {day(from)} and {day(to)} for each company, as a percentage of its revenue. A figure above 100% means the orders it won are worth more than a year of sales.
      </p>
      <div className="grid grid-cols-2 gap-2.5 px-4 pt-3 md:grid-cols-3 xl:grid-cols-5 sm:px-5">
        <Picker label="Timeframe" value={period} onChange={(v) => { const d = periodDates(v || "6"); setFrom(d.from); setTo(d.to); }} options={[...PERIODS, CUSTOM]} />
        <DateBox label="From" value={from} onChange={(v) => { if (v) { setFrom(v); if (v > to) setTo(v); } }} max={isoDay()} />
        <DateBox label="To" value={to} onChange={(v) => { if (v) { setTo(v); if (v < from) setFrom(v); } }} max={isoDay()} min={from} />
        <NumberBox label="Min revenue %" value={minRevenuePct} onChange={setMinRevenuePct} suffix="%" />
        <CapSlider min={cap[0]} max={cap[1]} onChange={(lo, hi) => setCap([lo, hi])} />
      </div>
      <div className="flex gap-2.5 px-4 pt-2.5 sm:px-5">
        <div className="relative min-w-0 flex-1">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input value={input} onChange={(e) => setInput(e.target.value)} placeholder="Search company" aria-label="Search companies"
            className="h-[2.75rem] w-full rounded-xl border border-slate-200 bg-white pl-9 pr-3 text-sm outline-none focus:border-indigo-400 dark:border-slate-700 dark:bg-slate-900" />
        </div>
        <button type="button" onClick={reload} className="inline-flex h-[2.75rem] shrink-0 items-center gap-1.5 rounded-xl border border-emerald-300 px-3.5 text-sm font-semibold text-emerald-700 transition hover:bg-emerald-50 dark:border-emerald-500/40 dark:text-emerald-300 dark:hover:bg-emerald-500/10">
          <RefreshCw size={14} className={loading ? "animate-spin" : ""} /> Refresh
        </button>
      </div>

      {error && <ErrorNote message={error} onRetry={reload} />}
      <div className={clsx("pt-4 transition-opacity", loading && "opacity-60")}>
        {loading && !data ? <Loading rows={10} /> : (
          <DataTable dense pageSize={25} rows={data?.rows ?? []} rowKey={(r) => r.symbol ?? r.company}
            empty="No company matches these filters. Widen the market cap range or the timeframe."
            initialSort={{ key: "ordersPctOfRevenue", dir: "desc" }}
            columns={[
              {
                key: "company", label: "Company Name", sticky: true, sortValue: (r) => r.company, className: "w-[17rem] min-w-[17rem] max-w-[17rem]",
                render: (r) => {
                  const key = r.symbol ?? r.company;
                  return (
                    <div className="flex w-[16rem] items-center gap-1.5">
                      <button type="button" onClick={() => setOpen((o) => ({ ...o, [key]: !o[key] }))}
                        aria-label={open[key] ? `Hide the orders of ${r.company}` : `Show the orders of ${r.company}`}
                        className="rounded p-0.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800">
                        {open[key] ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                      </button>
                      {r.symbol
                        ? <Link href={`/company/${encodeURIComponent(r.symbol)}`} className="font-medium text-indigo-700 hover:underline dark:text-indigo-300">{r.company}</Link>
                        : <span className="font-medium">{r.company}</span>}
                    </div>
                  );
                },
              },
              { key: "ordersPctOfRevenue", label: "Orders as % of Revenue", align: "right", sortValue: (r) => r.ordersPctOfRevenue ?? -1, className: "w-[11rem]", render: (r) => <ShareChip pct={r.ordersPctOfRevenue} /> },
              { key: "orderCount", label: "Order Count", align: "right", sortValue: (r) => r.orderCount, className: "w-[7.5rem]", render: (r) => <span className="tabular-nums">{r.orderCount} {r.orderCount === 1 ? "order" : "orders"}</span> },
              { key: "totalOrderValueCr", label: "Total Order Value", align: "right", sortValue: (r) => r.totalOrderValueCr, className: "w-[9.5rem]", render: (r) => <span className="font-medium tabular-nums text-emerald-700 dark:text-emerald-400">{inrCrore(r.totalOrderValueCr)}</span> },
              {
                key: "revenueCr", label: "Company Revenue", align: "right", sortValue: (r) => r.revenueCr ?? -1, className: "w-[9rem]",
                render: (r) => r.revenueCr === null
                  ? <span className="text-slate-400">Not on file</span>
                  : <span className="tabular-nums" title={`twelve months to ${r.revenueQuarter ?? "the latest quarter"}${r.revenueBasis ? `, ${r.revenueBasis}` : ""}`}>{inrCrore(r.revenueCr)}</span>,
              },
              { key: "marketCapCr", label: "Market Cap", align: "right", sortValue: (r) => r.marketCapCr ?? -1, className: "w-[8rem]", render: (r) => <span className="tabular-nums">{r.marketCapCr === null ? "—" : inrCrore(r.marketCapCr)}</span> },
              { key: "latestOrderAt", label: "Latest Order", align: "right", sortValue: (r) => r.latestOrderAt, className: "w-[8rem]", render: (r) => <span className="tabular-nums">{day(r.latestOrderAt)}</span> },
            ]}
            searchable={false}
            highlight={(r) => Boolean(open[r.symbol ?? r.company])}
            footer={undefined}
          />
        )}
      </div>

      {/* The orders behind an expanded company, in the same order as the table above. */}
      {(data?.rows ?? []).filter((r) => open[r.symbol ?? r.company]).map((r) => (
        <div key={r.symbol ?? r.company} className="mx-4 mb-4 rounded-xl border border-slate-200 bg-slate-50 p-3 sm:mx-5 dark:border-slate-800 dark:bg-slate-900/60">
          <p className="mb-2 flex items-center gap-2 text-sm font-semibold">
            {r.company} <Badge tone="brand">{r.orderCount} {r.orderCount === 1 ? "order" : "orders"}</Badge>
            <span className="text-xs font-normal text-slate-500">{inrCrore(r.totalOrderValueCr)} {from === to ? `on ${day(from)}` : `between ${day(from)} and ${day(to)}`}</span>
          </p>
          <ul className="space-y-1.5">
            {r.orders.map((o) => (
              <li key={o.id} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-sm">
                <span className="tabular-nums text-slate-500">{day(o.announcedAt)}</span>
                <span className="font-medium tabular-nums">{value(o.contractValueCr)}</span>
                <span className="text-slate-600 dark:text-slate-300">{o.customer ?? "customer not mentioned"}</span>
                {o.orderType && <Badge>{o.orderType}</Badge>}
                {o.summary && <span className="w-full text-xs text-slate-500">{o.summary}</span>}
                {o.pdfUrl && <a href={o.pdfUrl} target="_blank" rel="noopener noreferrer" className="text-xs text-indigo-600 hover:underline dark:text-indigo-300">filing</a>}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </Card>
  );
}
