"use client";

import {
  Bar, BarChart, CartesianGrid, Cell, Legend, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import { ChartTooltipCard, type TooltipLine } from "@/components/charts/Categorical";
import { isNum, type Num } from "@/lib/format";

export interface Series { key: string; label: string; color: string }

const GRID = "rgba(100,116,139,0.18)";
const TICK = { fontSize: 11, fill: "#64748b" };

/** Axis ticks for amounts in crore: 1.2L, 45K, 900. The unit is in the chart subtitle. */
export function axisCrore(v: number): string {
  const a = Math.abs(v);
  if (a >= 1e5) return `${(v / 1e5).toFixed(a >= 1e6 ? 0 : 1)}L`;
  if (a >= 1e3) return `${(v / 1e3).toFixed(a >= 1e4 ? 0 : 1)}K`;
  return `${Math.round(v)}`;
}

function countPoints(data: Record<string, unknown>[], series: Series[]) {
  return data.filter((d) => series.some((s) => isNum(d[s.key] as Num))).length;
}

export function pointsIn(data: Record<string, unknown>[], series: Series[]) {
  return countPoints(data, series);
}

/**
 * Grouped bars over periods (quarters or years). Missing values leave a gap
 * rather than a zero bar; negative values are drawn in red.
 */
export function PeriodBars({ data, series, format, axis = axisCrore, title, details, height = 280 }: {
  data: Record<string, unknown>[]; series: Series[]; format: (v: number) => string; axis?: (v: number) => string;
  title?: string; details?: (row: Record<string, unknown>) => TooltipLine[]; height?: number;
}) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }} barGap={2}>
        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke={GRID} />
        <XAxis dataKey="label" tickLine={false} axisLine={false} tick={TICK} minTickGap={8} />
        <YAxis tickLine={false} axisLine={false} width={52} tick={TICK} tickFormatter={axis} />
        <ReferenceLine y={0} stroke="#94a3b8" />
        <Tooltip cursor={{ fill: "rgba(99,102,241,0.06)" }} content={({ active, payload, label }) => {
          if (!active || !payload?.length) return null;
          const row = payload[0].payload as Record<string, unknown>;
          const lines: TooltipLine[] = series.map((s) => {
            const v = row[s.key] as Num;
            return { label: s.label, value: isNum(v) ? format(v) : "Not available", color: s.color, tone: isNum(v) && v < 0 ? "down" : undefined };
          });
          return <ChartTooltipCard title={title} heading={String(label)} lines={[...lines, ...(details?.(row) ?? [])]} />;
        }} />
        {series.length > 1 && <Legend wrapperStyle={{ fontSize: 12 }} />}
        {series.map((s) => (
          <Bar key={s.key} dataKey={s.key} name={s.label} fill={s.color} radius={[4, 4, 0, 0]} maxBarSize={30} isAnimationActive={false}>
            {data.map((d, i) => <Cell key={i} fill={isNum(d[s.key] as Num) && (d[s.key] as number) < 0 ? "#f43f5e" : s.color} />)}
          </Bar>
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}

/** Lines over time or periods; gaps where a value is missing. */
export function TrendLines({ data, series, format, axis, title, height = 260, xKey = "label", details }: {
  data: Record<string, unknown>[]; series: Series[]; format: (v: number) => string; axis?: (v: number) => string;
  title?: string; height?: number; xKey?: string; details?: (row: Record<string, unknown>) => TooltipLine[];
}) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke={GRID} />
        <XAxis dataKey={xKey} tickLine={false} axisLine={false} tick={TICK} minTickGap={16} />
        <YAxis tickLine={false} axisLine={false} width={52} tick={TICK} tickFormatter={axis ?? format} domain={["auto", "auto"]} />
        <Tooltip content={({ active, payload, label }) => {
          if (!active || !payload?.length) return null;
          const row = payload[0].payload as Record<string, unknown>;
          return <ChartTooltipCard title={title} heading={String(label)} lines={[
            ...series.map((s) => {
              const v = row[s.key] as Num;
              return { label: s.label, value: isNum(v) ? format(v) : "Not available", color: s.color };
            }),
            ...(details?.(row) ?? []),
          ]} />;
        }} />
        {series.length > 1 && <Legend wrapperStyle={{ fontSize: 12 }} />}
        {series.map((s) => (
          <Line key={s.key} type="monotone" dataKey={s.key} name={s.label} stroke={s.color} strokeWidth={2}
            dot={data.length <= 16 ? { r: 3 } : false} activeDot={{ r: 4 }} connectNulls={false} isAnimationActive={false} />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}
