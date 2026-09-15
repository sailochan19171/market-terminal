import clsx from "clsx";

const CANDLES = [
  { x: 4, body: [14, 16], wick: [8, 34], up: true },
  { x: 16, body: [10, 20], wick: [5, 36], up: false },
  { x: 28, body: [6, 24], wick: [2, 38], up: true },
  { x: 40, body: [12, 14], wick: [7, 32], up: true },
  { x: 52, body: [8, 18], wick: [3, 35], up: false },
];

/** Five candlesticks that breathe in sequence: the site's loading mark. */
export function CandleLoader({ className, size = 40 }: { className?: string; size?: number }) {
  return (
    <svg viewBox="0 0 60 40" width={(size * 60) / 40} height={size} className={className} aria-hidden>
      {CANDLES.map((c, i) => (
        <g key={c.x} className="candle-bob" style={{ animationDelay: `${i * 110}ms` }}>
          <line x1={c.x + 3} x2={c.x + 3} y1={c.wick[0]} y2={c.wick[1]} strokeWidth={1.5} className={c.up ? "stroke-emerald-500" : "stroke-rose-500"} />
          <rect x={c.x} y={c.body[0]} width={6} height={c.body[1]} rx={1.2} className={c.up ? "fill-emerald-500" : "fill-rose-500"} />
        </g>
      ))}
    </svg>
  );
}

/** Full-page loader shown while a page and its first data are on the way. */
export function PageLoader({ label = "Loading market data", detail, className }: { label?: string; detail?: string; className?: string }) {
  return (
    <div role="status" aria-live="polite" aria-label={label} className={clsx("motion-fade space-y-6", className)}>
      <div className="hero-surface relative flex items-center gap-5 overflow-hidden rounded-3xl border border-indigo-100 px-6 py-8 dark:border-indigo-500/20">
        <div className="rounded-2xl bg-white/80 p-3 shadow-sm dark:bg-slate-900/70"><CandleLoader size={44} /></div>
        <div className="relative min-w-0">
          <p className="text-lg font-semibold text-slate-900 dark:text-white">{label}…</p>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{detail ?? "Fetching the latest figures from the database."}</p>
          <div className="mt-3 h-1 w-48 max-w-full overflow-hidden rounded-full bg-indigo-100 dark:bg-indigo-500/20">
            <div className="progress-indeterminate h-full w-1/3 rounded-full bg-indigo-500" />
          </div>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => <div key={i} className="skeleton-shimmer h-24 rounded-2xl" />)}
      </div>
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="skeleton-shimmer h-72 rounded-2xl lg:col-span-2" />
        <div className="skeleton-shimmer h-72 rounded-2xl" />
      </div>
    </div>
  );
}
