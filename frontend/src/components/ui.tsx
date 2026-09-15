"use client";

import clsx from "clsx";
import Link from "next/link";
import type { ReactNode } from "react";
import { tone, type Num, pct as fmtPct } from "@/lib/format";

export function Card({ className, children, id }: { className?: string; children: ReactNode; id?: string }) {
  return (
    <section
      id={id}
      className={clsx(
        "scroll-mt-64 rounded-2xl border border-slate-200 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.04)]",
        "dark:border-slate-800 dark:bg-slate-900",
        className,
      )}
    >
      {children}
    </section>
  );
}

export function CardHeader({
  title, subtitle, actions, className,
}: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; className?: string }) {
  return (
    <div className={clsx("flex flex-wrap items-start justify-between gap-3 px-5 pt-5 sm:px-6", className)}>
      <div className="min-w-0">
        <h2 className="text-lg font-semibold tracking-tight text-slate-900 dark:text-white">{title}</h2>
        {subtitle && <p className="mt-0.5 text-sm text-slate-500 dark:text-slate-400">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function CardBody({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={clsx("px-5 py-5 sm:px-6", className)}>{children}</div>;
}

export function PageTitle({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900 sm:text-3xl dark:text-white">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{subtitle}</p>}
      </div>
      {actions}
    </div>
  );
}

export function Pct({ value, digits = 2, className }: { value: Num; digits?: number; className?: string }) {
  return <span className={clsx("tabular", tone(value), className)}>{fmtPct(value, digits)}</span>;
}

export function Badge({ children, tone: t = "slate" }: { children: ReactNode; tone?: "slate" | "brand" | "up" | "down" | "amber" }) {
  const map = {
    slate: "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300",
    brand: "bg-indigo-50 text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300",
    up: "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300",
    down: "bg-rose-50 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300",
    amber: "bg-amber-50 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300",
  } as const;
  return <span className={clsx("inline-flex items-center rounded-md px-1.5 py-0.5 text-[11px] font-semibold", map[t])}>{children}</span>;
}

export function Segmented<T extends string>({
  options, value, onChange, size = "md",
}: { options: { value: T; label: string; disabled?: boolean; title?: string }[]; value: T; onChange: (v: T) => void; size?: "sm" | "md" }) {
  return (
    <div className="inline-flex rounded-xl border border-slate-200 bg-slate-50 p-0.5 dark:border-slate-700 dark:bg-slate-800/60">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          title={o.title}
          disabled={o.disabled}
          onClick={() => onChange(o.value)}
          className={clsx(
            "rounded-[10px] font-medium transition",
            size === "sm" ? "px-2.5 py-1 text-xs" : "px-3.5 py-1.5 text-sm",
            o.value === value
              ? "bg-white text-indigo-700 shadow-sm dark:bg-slate-900 dark:text-indigo-300"
              : "text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white",
            o.disabled && "cursor-not-allowed opacity-40 hover:text-slate-600",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Button({
  children, onClick, variant = "secondary", href, type = "button", disabled, className,
}: {
  children: ReactNode; onClick?: () => void; variant?: "primary" | "secondary" | "ghost";
  href?: string; type?: "button" | "submit"; disabled?: boolean; className?: string;
}) {
  const cls = clsx(
    "inline-flex items-center justify-center gap-2 rounded-xl px-3.5 py-2 text-sm font-medium transition disabled:opacity-50",
    variant === "primary" && "bg-indigo-600 text-white shadow-sm hover:bg-indigo-500",
    variant === "secondary" && "border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800",
    variant === "ghost" && "text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800",
    className,
  );
  if (href) return <Link href={href} className={cls}>{children}</Link>;
  return <button type={type} onClick={onClick} disabled={disabled} className={cls}>{children}</button>;
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-1 px-6 py-12 text-center">
      <p className="text-sm font-medium text-slate-700 dark:text-slate-200">{title}</p>
      {children && <p className="max-w-md text-sm text-slate-500 dark:text-slate-400">{children}</p>}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={clsx("skeleton-shimmer rounded-lg", className)} />;
}

export function Loading({ rows = 6 }: { rows?: number }) {
  return (
    <div className="space-y-3 p-6" role="status" aria-label="Loading">
      {Array.from({ length: rows }).map((_, i) => <Skeleton key={i} className="h-5 w-full" />)}
    </div>
  );
}

export function ErrorNote({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="m-5 flex items-center justify-between gap-4 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-300">
      <span>{message}</span>
      {onRetry && <button onClick={onRetry} className="font-semibold underline underline-offset-2">Retry</button>}
    </div>
  );
}

export function Stat({ label, value, hint, className }: { label: string; value: ReactNode; hint?: ReactNode; className?: string }) {
  return (
    <div className={clsx("flex items-baseline justify-between gap-3 border-b border-slate-100 py-2.5 last:border-0 dark:border-slate-800", className)}>
      <dt className="text-sm text-slate-500 dark:text-slate-400">{label}</dt>
      <dd className="tabular text-right text-sm font-semibold text-slate-900 dark:text-white">
        {value}
        {hint && <span className="ml-1 text-xs font-normal text-slate-400">{hint}</span>}
      </dd>
    </div>
  );
}

export function Unavailable({ title, reason }: { title: string; reason: string }) {
  return (
    <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50/60 px-5 py-8 text-center dark:border-slate-700 dark:bg-slate-800/30">
      <p className="text-sm font-semibold text-slate-700 dark:text-slate-200">{title}</p>
      <p className="mx-auto mt-1 max-w-xl text-sm text-slate-500 dark:text-slate-400">{reason}</p>
    </div>
  );
}
