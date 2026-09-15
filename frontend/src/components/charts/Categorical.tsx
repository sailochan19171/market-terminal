"use client";

import {
  Bar, BarChart, CartesianGrid, Cell, Legend, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import { num } from "@/lib/format";

const SERIES = ["#4f46e5", "#10b981", "#f59e0b", "#0ea5e9", "#e11d48"];

export interface TooltipLine { label: string; value: string; color?: string; tone?: "up" | "down" }

/** Card-style tooltip shared by the bar charts: title, period, then labelled values. */
export function ChartTooltipCard({ title, heading, lines }: { title?: string; heading: string; lines: TooltipLine[] }) {
  return (
    <div className="min-w-[200px] rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs shadow-lg dark:border-slate-700 dark:bg-slate-900">
      {title && <p className="font-semibold text-slate-800 dark:text-slate-100">{title}</p>}
      <p className="mb-1.5 text-slate-500">{heading}</p>
      <dl className="space-y-1">
        {lines.map((l) => (
          <div key={l.label} className="flex items-center justify-between gap-4">
            <dt className="flex items-center gap-1.5 text-slate-500 dark:text-slate-400">
              {l.color && <span className="h-2 w-2 rounded-sm" style={{ background: l.color }} />}{l.label}
            </dt>
            <dd className={`tabular font-semibold ${l.tone === "up" ? "text-up" : l.tone === "down" ? "text-down" : ""}`}>{l.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

export function GroupedBars({
  data, keys, labels, height = 280, unit = "", title, details, colors,
}: {
  data: Record<string, unknown>[]; keys: string[]; labels: Record<string, string>; height?: number; unit?: string;
  /** Company name shown at the top of the tooltip. */
  title?: string;
  /** Extra tooltip lines for a hovered period (margins, EPS, growth). */
  details?: (row: Record<string, unknown>) => TooltipLine[];
  colors?: string[];
}) {
  const palette = colors ?? SERIES;
  const value = (v: unknown) => (v == null || Number.isNaN(Number(v)) ? "—" : `${num(Number(v), 0)}${unit}`);
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }} barGap={2}>
        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="rgba(100,116,139,0.18)" />
        <XAxis dataKey="label" tickLine={false} axisLine={false} tick={{ fontSize: 12, fill: "#64748b" }} />
        <YAxis tickLine={false} axisLine={false} width={64} tick={{ fontSize: 12, fill: "#64748b" }}
          tickFormatter={(v: number) => num(v, 0)} />
        <Tooltip cursor={{ fill: "rgba(99,102,241,0.06)" }}
          content={({ active, payload, label }) => {
            if (!active || !payload?.length) return null;
            const row = payload[0].payload as Record<string, unknown>;
            const lines: TooltipLine[] = keys.map((k, i) => {
              const v = row[k] as number | null | undefined;
              return { label: labels[k] ?? k, value: value(v), color: palette[i % palette.length], tone: v != null && v < 0 ? "down" : undefined };
            });
            return <ChartTooltipCard title={title} heading={String(label)} lines={[...lines, ...(details?.(row) ?? [])]} />;
          }} />
        <Legend formatter={(k) => labels[String(k)] ?? String(k)} wrapperStyle={{ fontSize: 12 }} />
        {keys.map((k, i) => (
          <Bar isAnimationActive={false} key={k} dataKey={k} name={k} fill={palette[i % palette.length]} radius={[4, 4, 0, 0]} maxBarSize={28}>
            {data.map((d, j) => <Cell key={j} fill={Number(d[k]) < 0 ? "#f43f5e" : palette[i % palette.length]} />)}
          </Bar>
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}

export function SignedBars({
  data, labelKey, valueKey, height = 320, suffix = "%",
}: { data: Record<string, unknown>[]; labelKey: string; valueKey: string; height?: number; suffix?: string }) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} layout="vertical" margin={{ top: 4, right: 24, bottom: 4, left: 8 }}>
        <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="rgba(100,116,139,0.18)" />
        <XAxis type="number" tickLine={false} axisLine={false} tick={{ fontSize: 12, fill: "#64748b" }}
          tickFormatter={(v: number) => `${v}${suffix}`} />
        <YAxis type="category" dataKey={labelKey} width={190} tickLine={false} axisLine={false}
          tick={{ fontSize: 12, fill: "#475569" }} />
        <Tooltip cursor={{ fill: "rgba(99,102,241,0.06)" }}
          content={({ active, payload }) => {
            if (!active || !payload?.length) return null;
            const row = payload[0].payload as Record<string, unknown>;
            const v = Number(row[valueKey]);
            return <ChartTooltipCard heading={String(row[labelKey])}
              lines={[{ label: "Change", value: `${v >= 0 ? "+" : ""}${num(v)}${suffix}`, tone: v >= 0 ? "up" : "down" }]} />;
          }} />
        <Bar isAnimationActive={false} dataKey={valueKey} radius={[0, 4, 4, 0]} maxBarSize={18}>
          {data.map((d, i) => <Cell key={i} fill={Number(d[valueKey]) >= 0 ? "#10b981" : "#f43f5e"} />)}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

export function Donut({ slices, height = 240, title }: { slices: { name: string; value: number | null }[]; height?: number; title?: string }) {
  const data = slices.filter((s) => (s.value ?? 0) > 0) as { name: string; value: number }[];
  return (
    <ResponsiveContainer width="100%" height={height}>
      <PieChart>
        <Pie isAnimationActive={false} data={data} dataKey="value" nameKey="name" innerRadius="58%" outerRadius="85%" paddingAngle={2} stroke="none">
          {data.map((_, i) => <Cell key={i} fill={SERIES[i % SERIES.length]} />)}
        </Pie>
        <Tooltip content={({ active, payload }) => {
          if (!active || !payload?.length) return null;
          const p = payload[0];
          return <ChartTooltipCard title={title} heading={String(p.name)} lines={[{ label: "Share", value: `${num(Number(p.value))}%` }]} />;
        }} />
        <Legend verticalAlign="middle" align="right" layout="vertical" wrapperStyle={{ fontSize: 13 }}
          formatter={(name, entry) => `${name}  ${num(Number((entry as { payload?: { value?: number } }).payload?.value))}%`} />
      </PieChart>
    </ResponsiveContainer>
  );
}

export function StackedBreadth({ data, height = 220 }: { data: { trade_date: string; advances: number; declines: number; unchanged?: number }[]; height?: number }) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="rgba(100,116,139,0.18)" />
        <XAxis dataKey="trade_date" tickLine={false} axisLine={false} minTickGap={40}
          tick={{ fontSize: 11, fill: "#64748b" }} tickFormatter={(d: string) => d.slice(5)} />
        <YAxis tickLine={false} axisLine={false} width={44} tick={{ fontSize: 11, fill: "#64748b" }} />
        <Tooltip cursor={{ fill: "rgba(99,102,241,0.06)" }}
          content={({ active, payload }) => {
            if (!active || !payload?.length) return null;
            const r = payload[0].payload as { trade_date: string; advances: number; declines: number; unchanged?: number };
            return <ChartTooltipCard heading={r.trade_date} lines={[
              { label: "Advances", value: r.advances.toLocaleString("en-IN"), color: "#10b981" },
              { label: "Declines", value: r.declines.toLocaleString("en-IN"), color: "#f43f5e" },
              ...(r.unchanged != null ? [{ label: "Unchanged", value: r.unchanged.toLocaleString("en-IN") }] : []),
              { label: "A/D ratio", value: num(r.advances / Math.max(1, r.declines)) },
            ]} />;
          }} />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        <Bar isAnimationActive={false} dataKey="advances" name="Advances" stackId="a" fill="#10b981" />
        <Bar isAnimationActive={false} dataKey="declines" name="Declines" stackId="a" fill="#f43f5e" radius={[3, 3, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}
