"use client";

import clsx from "clsx";
import { useEffect, useRef, useState, type ReactNode } from "react";

/*
 * Original, lightweight SVG artwork for page banners and empty states.
 * Motion comes from CSS classes in globals.css (anim-draw, anim-grow,
 * anim-float), which reduced-motion preferences switch off.
 */

const CANDLES = [
  [18, 62, 48, 70, 40], [36, 55, 40, 64, 34], [54, 50, 58, 66, 44], [72, 58, 46, 62, 38],
  [90, 46, 36, 52, 30], [108, 38, 50, 58, 32], [126, 50, 34, 56, 28], [144, 34, 26, 40, 20],
  [162, 28, 38, 44, 22], [180, 36, 22, 40, 16], [198, 24, 16, 30, 10],
] as const; // x, open, close, low(y of high wick bottom), high(y of wick top) - y grows downward

export function MarketIllustration({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 240 120" className={clsx("h-auto w-full", className)} role="img" aria-label="Rising candlestick chart">
      <defs>
        <linearGradient id="mi-area" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor="#6366f1" stopOpacity="0.35" />
          <stop offset="100%" stopColor="#6366f1" stopOpacity="0" />
        </linearGradient>
        <linearGradient id="mi-line" x1="0" x2="1">
          <stop offset="0%" stopColor="#818cf8" />
          <stop offset="100%" stopColor="#22d3ee" />
        </linearGradient>
      </defs>
      {[20, 45, 70, 95].map((y) => <line key={y} x1="6" x2="234" y1={y} y2={y} stroke="currentColor" strokeOpacity="0.08" />)}
      <path d="M10 92 L40 84 L70 88 L100 70 L130 66 L160 48 L190 40 L226 18 L226 112 L10 112 Z" fill="url(#mi-area)" className="anim-fade" />
      {CANDLES.map(([x, open, close, low, high], i) => {
        const up = close < open;
        const top = Math.min(open, close);
        return (
          <g key={x} className="anim-grow" style={{ animationDelay: `${i * 60}ms`, transformOrigin: `${x}px 112px` }}>
            <line x1={x} x2={x} y1={high} y2={low + 16} stroke={up ? "#10b981" : "#f43f5e"} strokeWidth="1.5" />
            <rect x={x - 5} y={top} width="10" height={Math.max(4, Math.abs(open - close))} rx="2" fill={up ? "#10b981" : "#f43f5e"} />
          </g>
        );
      })}
      <path d="M10 92 L40 84 L70 88 L100 70 L130 66 L160 48 L190 40 L226 18" fill="none" stroke="url(#mi-line)" strokeWidth="3"
        strokeLinecap="round" strokeLinejoin="round" pathLength="1" className="anim-draw" />
      <circle cx="226" cy="18" r="5" fill="#22d3ee" className="anim-pulse" />
    </svg>
  );
}

export function ResultsIllustration({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 240 120" className={clsx("h-auto w-full", className)} role="img" aria-label="Quarterly results report">
      <rect x="26" y="10" width="120" height="100" rx="10" fill="white" fillOpacity="0.9" stroke="#c7d2fe" />
      <rect x="40" y="24" width="60" height="6" rx="3" fill="#6366f1" fillOpacity="0.8" />
      <rect x="40" y="36" width="90" height="4" rx="2" fill="#94a3b8" fillOpacity="0.5" />
      {[[48, 40], [68, 56], [88, 48], [108, 70], [128, 62]].map(([x, h], i) => (
        <rect key={x} x={x - 6} y={100 - h * 0.7} width="12" height={h * 0.7} rx="3" fill={i === 3 ? "#10b981" : "#818cf8"}
          className="anim-grow" style={{ animationDelay: `${i * 90}ms`, transformOrigin: `${x}px 100px` }} />
      ))}
      <g className="anim-float">
        <circle cx="188" cy="46" r="30" fill="#ecfdf5" stroke="#6ee7b7" />
        <path d="M172 54 L184 42 L192 50 L206 34" fill="none" stroke="#059669" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" pathLength="1" className="anim-draw" />
        <path d="M198 34 H206 V42" fill="none" stroke="#059669" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
      </g>
    </svg>
  );
}

export function OwnershipIllustration({ className }: { className?: string }) {
  const slices = [["#6366f1", 0, 0.42], ["#0ea5e9", 0.42, 0.66], ["#10b981", 0.66, 0.86], ["#f59e0b", 0.86, 1]] as const;
  const arc = (a: number, b: number) => {
    const p = (t: number) => [120 + 44 * Math.cos(2 * Math.PI * t - Math.PI / 2), 60 + 44 * Math.sin(2 * Math.PI * t - Math.PI / 2)];
    const [x1, y1] = p(a), [x2, y2] = p(b);
    return `M120 60 L${x1} ${y1} A44 44 0 ${b - a > 0.5 ? 1 : 0} 1 ${x2} ${y2} Z`;
  };
  return (
    <svg viewBox="0 0 240 120" className={clsx("h-auto w-full", className)} role="img" aria-label="Ownership pie chart">
      <g className="anim-spin-in" style={{ transformOrigin: "120px 60px" }}>
        {slices.map(([color, a, b]) => <path key={color} d={arc(a, b)} fill={color} stroke="white" strokeWidth="2" />)}
        <circle cx="120" cy="60" r="20" fill="white" />
      </g>
      {[[40, 40], [200, 34], [196, 88], [44, 86]].map(([x, y], i) => (
        <g key={i} className="anim-float" style={{ animationDelay: `${i * 400}ms` }}>
          <circle cx={x} cy={y - 8} r="7" fill="#c7d2fe" />
          <path d={`M${x - 11} ${y + 12} Q${x} ${y - 4} ${x + 11} ${y + 12} Z`} fill="#a5b4fc" />
        </g>
      ))}
    </svg>
  );
}

export function CalendarIllustration({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 240 120" className={clsx("h-auto w-full", className)} role="img" aria-label="Board meeting calendar">
      <rect x="56" y="14" width="128" height="96" rx="12" fill="white" fillOpacity="0.92" stroke="#c7d2fe" />
      <rect x="56" y="14" width="128" height="24" rx="12" fill="#6366f1" />
      <rect x="56" y="30" width="128" height="8" fill="#6366f1" />
      {[80, 104, 128, 152].map((x) => <rect key={x} x={x - 2} y="8" width="4" height="14" rx="2" fill="#312e81" />)}
      {Array.from({ length: 15 }).map((_, i) => {
        const x = 72 + (i % 5) * 24, y = 50 + Math.floor(i / 5) * 20;
        return <rect key={i} x={x} y={y} width="14" height="12" rx="3" fill={i === 7 ? "#10b981" : "#e0e7ff"}
          className={i === 7 ? "anim-pulse" : undefined} />;
      })}
      <g className="anim-float"><circle cx="206" cy="30" r="14" fill="#fef3c7" stroke="#fbbf24" /><path d="M206 22 V31 L212 35" stroke="#b45309" strokeWidth="2.5" strokeLinecap="round" fill="none" /></g>
    </svg>
  );
}

export function AnalysisIllustration({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 240 120" className={clsx("h-auto w-full", className)} role="img" aria-label="Analysis with magnifier">
      <rect x="20" y="18" width="150" height="86" rx="12" fill="white" fillOpacity="0.9" stroke="#c7d2fe" />
      <path d="M34 88 L60 70 L84 78 L110 50 L136 58 L156 34" fill="none" stroke="#6366f1" strokeWidth="3" strokeLinecap="round" pathLength="1" className="anim-draw" />
      {[34, 60, 84, 110, 136, 156].map((x, i) => <circle key={x} cx={x} cy={[88, 70, 78, 50, 58, 34][i]} r="3.5" fill="#6366f1" />)}
      <g className="anim-float">
        <circle cx="178" cy="62" r="26" fill="#eef2ff" fillOpacity="0.8" stroke="#4f46e5" strokeWidth="5" />
        <line x1="197" y1="81" x2="220" y2="104" stroke="#4f46e5" strokeWidth="8" strokeLinecap="round" />
      </g>
    </svg>
  );
}

/** Gradient banner with title, facts and an illustration. */
export function PageHero({ eyebrow, title, subtitle, art, children }: {
  eyebrow?: string; title: string; subtitle?: ReactNode; art?: ReactNode; children?: ReactNode;
}) {
  return (
    <section className="motion-rise hero-surface relative mb-6 overflow-hidden rounded-3xl border border-indigo-100 px-5 py-6 sm:px-8 sm:py-8 dark:border-indigo-500/20">
      <div className="relative z-10 grid items-center gap-6 md:grid-cols-[1fr_minmax(0,300px)]">
        <div className="min-w-0">
          {eyebrow && <p className="text-xs font-semibold uppercase tracking-[0.18em] text-indigo-600 dark:text-indigo-300">{eyebrow}</p>}
          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-slate-900 sm:text-3xl dark:text-white">{title}</h1>
          {subtitle && <p className="mt-2 max-w-2xl text-sm text-slate-600 dark:text-slate-300">{subtitle}</p>}
          {children && <div className="mt-4">{children}</div>}
        </div>
        {art && <div className="hidden text-slate-400 md:block">{art}</div>}
      </div>
    </section>
  );
}

/** Small fact chip for heroes. */
export function HeroStat({ label, value, tone }: { label: string; value: ReactNode; tone?: "up" | "down" }) {
  return (
    <div className="rounded-2xl border border-white/70 bg-white/70 px-3.5 py-2 shadow-sm backdrop-blur dark:border-slate-700 dark:bg-slate-900/60">
      <p className="text-[11px] font-medium uppercase tracking-wide text-slate-500">{label}</p>
      <p className={clsx("tabular text-base font-semibold", tone === "up" && "text-up", tone === "down" && "text-down")}>{value}</p>
    </div>
  );
}

/** Animates a number into place once; shows the final value immediately for reduced motion. */
export function CountUp({ value, format, duration = 700 }: { value: number | null | undefined; format: (v: number) => string; duration?: number }) {
  const [shown, setShown] = useState<number | null>(value ?? null);
  const from = useRef<number>(0);
  useEffect(() => {
    if (value == null || !Number.isFinite(value)) { setShown(null); return; }
    const reduce = typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce) { setShown(value); from.current = value; return; }
    const start = performance.now();
    const origin = from.current;
    let raf = 0;
    const step = (t: number) => {
      const k = Math.min(1, (t - start) / duration);
      const eased = 1 - Math.pow(1 - k, 3);
      setShown(origin + (value - origin) * eased);
      if (k < 1) raf = requestAnimationFrame(step);
      else from.current = value;
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value, duration]);
  return <>{shown == null ? "—" : format(shown)}</>;
}
