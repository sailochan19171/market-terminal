"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { CandleLoader } from "@/components/PageLoader";

const START_EVENT = "route-progress:start";
const SAFETY_MS = 15_000;

/** Tell the progress bar a navigation is starting (for router.push callers; links are detected automatically). */
export function startRouteProgress(href: string) {
  window.dispatchEvent(new CustomEvent(START_EVENT, { detail: href }));
}

const LABELS: [RegExp, (m: RegExpMatchArray, search: URLSearchParams) => string][] = [
  [/^\/$/, () => "Market overview"],
  [/^\/markets\/?$/, (_, s) => (s.get("tab") === "watch" ? "Market watch" : "Market summary")],
  [/^\/company\/([^/]+)/, (m) => `${decodeURIComponent(m[1])} dashboard`],
  [/^\/indices\/([^/]+)/, (m) => decodeURIComponent(m[1])],
  [/^\/indices/, () => "Indices"],
  [/^\/heatmap/, () => "Heatmap"],
  [/^\/market-data\/([^/]+)/, (m) => `${decodeURIComponent(m[1]).replaceAll("-", " ")} feed`],
  [/^\/market-data/, () => "Exchange feeds"],
  [/^\/filings/, () => "Announcements"],
  [/^\/results/, () => "Financial results"],
  [/^\/board-meetings/, () => "Board meetings"],
  [/^\/corporate-actions/, () => "Corporate actions"],
  [/^\/shareholding/, () => "Shareholding changes"],
  [/^\/insider/, () => "Insider trading"],
  [/^\/screens\/([^/]+)/, (m) => `${decodeURIComponent(m[1]).replaceAll("-", " ")} screen`],
  [/^\/screens/, () => "Stock screens"],
  [/^\/analyses/, () => "Completed analyses"],
  [/^\/portfolio/, () => "Portfolio"],
  [/^\/watchlist/, () => "Watchlist"],
  [/^\/alerts/, () => "Alerts"],
];

function labelFor(href: string): string {
  const url = new URL(href, window.location.origin);
  for (const [re, fn] of LABELS) {
    const m = url.pathname.match(re);
    if (m) return fn(m, url.searchParams);
  }
  return "page";
}

/** Top progress bar plus a "Loading <page>" chip while the router moves to another page. */
export function RouteProgress() {
  const pathname = usePathname();
  const search = useSearchParams();
  const [state, setState] = useState<{ phase: "idle" | "loading" | "done"; label: string; width: number }>({ phase: "idle", label: "", width: 0 });
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const current = `${pathname}?${search.toString()}`;
  const startedAt = useRef<string | null>(null);

  const clear = () => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
  };

  const finish = () => {
    clear();
    startedAt.current = null;
    setState((s) => (s.phase === "loading" ? { ...s, phase: "done", width: 100 } : s));
    timers.current.push(setTimeout(() => setState({ phase: "idle", label: "", width: 0 }), 380));
  };

  useEffect(() => {
    const start = (href: string) => {
      const target = new URL(href, window.location.origin);
      if (target.origin !== window.location.origin) return;
      if (`${target.pathname}${target.search}` === `${window.location.pathname}${window.location.search}`) return;
      clear();
      startedAt.current = `${window.location.pathname}?${window.location.search.slice(1)}`;
      setState({ phase: "loading", label: labelFor(href), width: 12 });
      // Creep towards 85% so a slow page still shows movement, then wait for the route to land.
      [[120, 38], [450, 62], [1100, 76], [2400, 85]].forEach(([ms, w]) =>
        timers.current.push(setTimeout(() => setState((s) => (s.phase === "loading" ? { ...s, width: w } : s)), ms)));
      timers.current.push(setTimeout(finish, SAFETY_MS));
    };

    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as Element | null)?.closest?.("a");
      if (!a || !a.href || a.target === "_blank" || a.hasAttribute("download")) return;
      start(a.href);
    };
    const onStart = (e: Event) => start(String((e as CustomEvent).detail ?? ""));
    document.addEventListener("click", onClick, true);
    window.addEventListener(START_EVENT, onStart);
    return () => {
      document.removeEventListener("click", onClick, true);
      window.removeEventListener(START_EVENT, onStart);
      clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The new route rendered: complete the bar.
  useEffect(() => {
    if (startedAt.current !== null && startedAt.current !== current) finish();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current]);

  if (state.phase === "idle") return null;
  return (
    <>
      <div className="pointer-events-none fixed inset-x-0 top-0 z-[100] h-[3px]" aria-hidden>
        <div className="route-bar h-full bg-gradient-to-r from-indigo-500 via-sky-400 to-emerald-400 shadow-[0_0_10px_rgba(99,102,241,0.7)]"
          style={{ width: `${state.width}%`, opacity: state.phase === "done" ? 0 : 1 }} />
      </div>
      <div role="status" aria-live="polite"
        className="motion-rise pointer-events-none fixed bottom-6 left-1/2 z-[100] flex -translate-x-1/2 items-center gap-2 rounded-full border border-slate-200 bg-white/95 px-3 py-1.5 text-xs font-medium text-slate-700 shadow-lg backdrop-blur dark:border-slate-700 dark:bg-slate-900/95 dark:text-slate-200"
        style={{ opacity: state.phase === "done" ? 0 : 1, transition: "opacity 300ms ease" }}>
        <CandleLoader size={16} />
        <span className="max-w-[60vw] truncate">Loading {state.label}…</span>
      </div>
    </>
  );
}
