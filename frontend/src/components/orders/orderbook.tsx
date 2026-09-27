"use client";

// The order book view: what each company is holding, and which books are growing fastest.
//
// An order win is one day's news. The order book is the whole of what a company has still to deliver, and its
// shape over several quarters says more than any single figure: a book up by half in three months is a company
// whose next two years look different from its last two. Every number here is one a company put in its own
// investor presentation, with the quarter it stated it as on, and the deck is one click away.
import clsx from "clsx";
import { ExternalLink, FileText, TrendingUp } from "lucide-react";
import { useState } from "react";
import { DataTable } from "@/components/DataTable";
import { Badge, Card, ErrorNote, Loading, Segmented } from "@/components/ui";
import { useApi } from "@/lib/api";
import { inrCrore } from "@/lib/format";
import { NumberBox } from "@/components/orders/controls";

interface BookRow {
  symbol: string | null; company: string | null; scripCd: string | null;
  orderBookCr: number; asOf: string; filedAt: string;
  revenueCr: number | null; revenueBasis: string | null; bookToRevenue: number | null;
  growth3m: number | null; growth6m: number | null; growth12m: number | null; asOfStated: boolean;
  history: { asOf: string; valueCr: number }[];
  phrase: string | null; pdfUrl: string | null;
}
interface Payload { window: string; summary: { companies: number; rising: number }; gainers: BookRow[]; rows: BookRow[] }

const WINDOWS = [{ value: "3m", label: "3M" }, { value: "6m", label: "6M" }, { value: "12m", label: "1Y" }];
const day = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });
const growthOf = (r: BookRow, w: string) => (w === "12m" ? r.growth12m : w === "6m" ? r.growth6m : r.growth3m);

/** The growth figure, coloured by direction. An absent one is a gap in the history, not a zero. */
function Growth({ pct }: { pct: number | null }) {
  if (pct === null) return <span className="text-xs text-slate-400" title="only one reading on record, so there is nothing to measure against">no earlier reading</span>;
  return (
    <span className={clsx("font-semibold tabular-nums", pct > 0 ? "text-emerald-600 dark:text-emerald-400" : pct < 0 ? "text-rose-600 dark:text-rose-400" : "text-slate-500")}>
      {pct > 0 ? "+" : ""}{pct.toFixed(0)}%
    </span>
  );
}

/** Every reading as a bar, oldest at the left. Drawn from the readings themselves, so two bars means two decks. */
function Spark({ history, className }: { history: { asOf: string; valueCr: number }[]; className?: string }) {
  if (history.length < 2) return <span className="text-[11px] text-slate-400">one reading</span>;
  const max = Math.max(...history.map((h) => h.valueCr));
  const rising = history[history.length - 1].valueCr >= history[0].valueCr;
  return (
    <span className={clsx("inline-flex h-7 items-end gap-[2px]", className)} title={history.map((h) => `${h.asOf}: ${inrCrore(h.valueCr)}`).join("\n")}>
      {history.map((h) => (
        <span key={h.asOf} className={clsx("w-[6px] rounded-sm", rising ? "bg-emerald-500/70" : "bg-rose-500/70")}
          style={{ height: `${Math.max(8, (h.valueCr / max) * 100)}%` }} />
      ))}
    </span>
  );
}

function GainerCard({ row, rank, window }: { row: BookRow; rank: number; window: string }) {
  return (
    <div className="min-w-[13.5rem] shrink-0 rounded-xl border border-slate-200 bg-white p-3 dark:border-slate-700 dark:bg-slate-900">
      <div className="flex items-baseline justify-between">
        <span className="text-[11px] text-slate-400">#{rank}</span>
        <Growth pct={growthOf(row, window)} />
      </div>
      <p className="mt-1 truncate text-sm font-semibold" title={row.company ?? undefined}>{row.company ?? row.symbol}</p>
      <p className="text-[11px] text-slate-500">{row.symbol ? `NSE: ${row.symbol}` : row.scripCd ? `BSE: ${row.scripCd}` : "not listed on file"}</p>
      <div className="mt-2"><Spark history={row.history} /></div>
      <p className="mt-1.5 text-xs font-medium tabular-nums text-emerald-700 dark:text-emerald-400">{inrCrore(row.orderBookCr)}</p>
    </div>
  );
}

export function OrderbookView() {
  const [window, setWindow] = useState("3m");
  const [minBook, setMinBook] = useState("");
  // The table sorts what it is given; the server is asked for the newest readings first.
  const sort = "updated";
  const query = new URLSearchParams({ window, sort, ...(Number(minBook) ? { minBookCr: minBook } : {}) });
  const { data, error, loading } = useApi<Payload>(`/api/v2/orderbook?${query}`);

  if (error) return <ErrorNote message={error} />;
  if (loading && !data) return <Loading />;
  const rows = data?.rows ?? [];

  return (
    <>
      <div className="mb-3 flex flex-wrap items-end gap-3">
        <div>
          <p className="mb-1 text-xs font-medium text-slate-500">Growth window</p>
          <Segmented value={window} onChange={setWindow} options={WINDOWS} />
        </div>
        <NumberBox label="Min order book" value={minBook} onChange={setMinBook} suffix="₹ cr" placeholder="any" className="w-[12rem]" />
        <div className="ml-auto flex items-center gap-2 text-xs">
          <Badge tone="slate"><TrendingUp size={12} className="mr-1 inline" />{data?.summary.companies ?? 0} companies</Badge>
          <Badge tone="up">{data?.summary.rising ?? 0} rising</Badge>
        </div>
      </div>

      {(data?.gainers.length ?? 0) > 0 && (
        <div className="mb-4">
          <p className="mb-2 text-sm font-semibold">Fastest-growing order books · last {window === "12m" ? "year" : window === "6m" ? "six months" : "three months"}</p>
          <div className="flex gap-2.5 overflow-x-auto pb-2">
            {data!.gainers.map((r, i) => <GainerCard key={`${r.symbol ?? r.company}`} row={r} rank={i + 1} window={window} />)}
          </div>
        </div>
      )}

      <Card>
        {!rows.length ? (
          <p className="p-6 text-sm text-slate-500">
            No order book has been read yet. They are taken from companies&rsquo; own investor presentations, and only
            construction, capital goods, defence and similar companies report one at all — the rest of the market
            has no order book to state.
          </p>
        ) : (
          <DataTable
            rows={rows}
            rowKey={(r) => `${r.symbol ?? r.company}-${r.asOf}`}
            initialSort={{ key: "filedAt", dir: "desc" }}
            columns={[
              {
                key: "company", label: "Company", sticky: true, sortValue: (r) => r.company ?? "",
                className: "w-[9.5rem] min-w-[9.5rem] max-w-[9.5rem] sm:w-[16rem] sm:min-w-[16rem] sm:max-w-[16rem]",
                render: (r) => (
                  <div className="min-w-0">
                    <p className="truncate font-medium" title={r.company ?? undefined}>{r.company ?? r.symbol}</p>
                    <p className="truncate text-[11px] text-slate-500">{r.symbol ? `NSE: ${r.symbol}` : r.scripCd ? `BSE: ${r.scripCd}` : ""}</p>
                  </div>
                ),
              },
              {
                key: "growth", label: `Order book growth (${window.toUpperCase()})`, align: "right", className: "w-[11rem]",
                sortValue: (r) => growthOf(r, window) ?? -Infinity, render: (r) => <Growth pct={growthOf(r, window)} />,
              },
              {
                key: "orderBookCr", label: "Order book", align: "right", className: "w-[9rem]",
                sortValue: (r) => r.orderBookCr,
                render: (r) => <span className="font-medium tabular-nums text-emerald-700 dark:text-emerald-400">{inrCrore(r.orderBookCr)}</span>,
              },
              {
                key: "revenueCr", label: "Revenue", align: "right", className: "w-[10rem]", sortValue: (r) => r.revenueCr ?? -1,
                render: (r) => r.revenueCr === null
                  ? <span className="text-xs text-slate-400">not on file</span>
                  : <div><span className="tabular-nums">{inrCrore(r.revenueCr)}</span><p className="text-[11px] text-slate-500">{r.revenueBasis ?? "twelve months"}</p></div>,
              },
              {
                key: "bookToRevenue", label: "Order book / revenue", align: "right", className: "w-[10rem]", sortValue: (r) => r.bookToRevenue ?? -1,
                render: (r) => r.bookToRevenue === null
                  ? <span className="text-xs text-slate-400">—</span>
                  : <span className="tabular-nums" title={`${r.bookToRevenue.toFixed(2)} years of sales on the books`}>{r.bookToRevenue.toFixed(2)}x</span>,
              },
              {
                key: "asOf", label: "As on", align: "right", className: "w-[8rem]", sortValue: (r) => r.asOf,
                // A date the deck did not give is the filing date standing in, and is said to be so rather than
                // shown as if the company had stated it.
                render: (r) => r.asOfStated
                  ? <span className="tabular-nums text-sm">{day(r.asOf)}</span>
                  : <span className="tabular-nums text-sm text-slate-400" title="the deck gave no date; this is when it was filed">{day(r.asOf)}*</span>,
              },
              { key: "filedAt", label: "Filed", align: "right", className: "w-[8rem]", sortValue: (r) => r.filedAt, render: (r) => <span className="tabular-nums text-sm text-slate-500">{day(r.filedAt)}</span> },
              {
                key: "history", label: "Order book history", sortable: false, className: "w-[9rem]",
                render: (r) => <Spark history={r.history} />,
              },
              {
                key: "pdf", label: "Deck", sortable: false, align: "right", className: "w-[5.5rem]",
                render: (r) => r.pdfUrl
                  ? <a href={r.pdfUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs text-indigo-600 hover:underline dark:text-indigo-300" title={r.phrase ?? undefined}><FileText size={13} /> PDF <ExternalLink size={11} /></a>
                  : <span className="text-xs text-slate-400">—</span>,
              },
            ]}
            searchable
          />
        )}
      </Card>
      <p className="px-4 pb-4 pt-2 text-xs text-slate-500 sm:px-5">
        Order books are read out of companies&rsquo; own investor presentations, and are stated as on the quarter the
        company gave, not the day the deck was filed. A date marked * is the day the deck was filed, because the
        deck gave none; those readings are left out of the growth figures rather than dated by guesswork. Growth compares the newest reading with the newest one at
        least that far back; where there is no earlier reading, no growth is shown rather than a zero.
      </p>
    </>
  );
}
