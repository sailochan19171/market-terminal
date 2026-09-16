// The universal "as of" stamp.
//
// Every surface that shows a price, a return or a market figure carries one of these, so a reader can always
// tell what moment they are looking at and where the number came from. Without it two panels built from
// different sessions look like a contradiction rather than two honest timestamps.
import clsx from "clsx";
import { dateTime } from "@/lib/format";

/** The price-service shape (server: src/server/core/price.ts). */
export interface PriceQuote {
  symbol: string;
  exchange: "NSE" | "BSE";
  lastPrice: number | null;
  previousClose: number | null;
  changeAbs: number | null;
  changePct: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  volume: number | null;
  asOfTimestamp: string | null;
  session: string | null;
  source: string;
  kind: "eod" | "live" | "snapshot";
  isLive: boolean;
  stale: boolean;
  currency: "INR";
}

export function LiveDot() {
  return <span className="relative flex h-1.5 w-1.5"><span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" /><span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-500" /></span>;
}

/** LIVE / END OF DAY / DELAYED marker. */
export function FeedBadge({ live, label }: { live: boolean; label?: string }) {
  return (
    <span className={clsx("inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
      live ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300" : "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300")}>
      {live && <LiveDot />}{label ?? (live ? "Live" : "End of day")}
    </span>
  );
}

/**
 * "End of day · as of 15 Sep 2026, 15:30 IST · NSE bhavcopy"
 * `at` is an ISO timestamp (an IST offset is respected); `source` names the feed.
 */
export function AsOf({ at, source, live = false, stale = false, staleNote, className, badge = true }: {
  at?: string | null;
  source?: string | null;
  live?: boolean;
  stale?: boolean;
  staleNote?: string;
  className?: string;
  badge?: boolean;
}) {
  if (!at) return <p className={clsx("text-xs text-slate-500", className)}>Timing not available{source ? ` · ${source}` : ""}</p>;
  return (
    <p className={clsx("flex flex-wrap items-center gap-1.5 text-xs text-slate-500", className)}>
      {badge && <FeedBadge live={live} />}
      <span>as of {dateTime(at)} IST</span>
      {source && <span className="truncate">· {source}</span>}
      {stale && (
        <span className="text-amber-600 dark:text-amber-400" title={staleNote ?? "This scrip has not traded in the most recent session."}>
          · no trade since
        </span>
      )}
    </p>
  );
}

/** The same stamp taken straight from a quote. */
export function QuoteStamp({ quote, className }: { quote: PriceQuote | null | undefined; className?: string }) {
  if (!quote) return null;
  return <AsOf at={quote.asOfTimestamp} source={quote.source} live={quote.isLive} stale={quote.stale} className={className} />;
}
