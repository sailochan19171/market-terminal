import clsx from "clsx";
import { BrandMark } from "@/components/BrandMark";

/** Full-page loader shown while a page and its first data are on the way. */
export function PageLoader({ label = "Loading market data", detail, className }: { label?: string; detail?: string; className?: string }) {
  return (
    <div role="status" aria-live="polite" aria-label={label} className={clsx("motion-fade space-y-6", className)}>
      <div className="hero-surface relative flex items-center gap-5 overflow-hidden rounded-3xl border border-indigo-100 px-6 py-8 dark:border-indigo-500/20">
        <BrandMark size={60} animated className="drop-shadow-lg" />
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
