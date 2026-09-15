"use client";

import {
  AreaSeries, CandlestickSeries, ColorType, CrosshairMode, HistogramSeries, LineSeries,
  createChart, type IChartApi, type MouseEventParams, type Time,
} from "lightweight-charts";
import { useEffect, useMemo, useRef, useState } from "react";

export interface Bar { t: string; o?: number | null; h?: number | null; l?: number | null; c: number | null; v?: number | null }
export interface LinePoint { t: string; value: number | null }

interface Props {
  mode: "candles" | "area" | "line";
  bars?: Bar[];
  line?: LinePoint[];
  overlays?: { name: string; color: string; points: LinePoint[] }[];
  showVolume?: boolean;
  height?: number;
  valueFormat?: (v: number) => string;
  /** Shown at the top of the hover legend, e.g. the company or index name. */
  title?: string;
  /** Label for the main value in line mode, e.g. "P/E". */
  valueLabel?: string;
}

function palette() {
  const dark = typeof document !== "undefined" && document.documentElement.classList.contains("dark");
  return dark
    ? { text: "#94a3b8", grid: "rgba(148,163,184,0.10)", border: "rgba(148,163,184,0.18)", up: "#10b981", down: "#f43f5e", line: "#818cf8" }
    : { text: "#64748b", grid: "rgba(15,23,42,0.06)", border: "rgba(15,23,42,0.10)", up: "#059669", down: "#e11d48", line: "#4f46e5" };
}

const inr = (v: number, d = 2) => v.toLocaleString("en-IN", { minimumFractionDigits: d, maximumFractionDigits: d });
function volumeText(v: number) {
  if (v >= 1e7) return `${inr(v / 1e7)} Cr`;
  if (v >= 1e5) return `${inr(v / 1e5)} L`;
  return v.toLocaleString("en-IN");
}
function dayLabel(t: string) {
  const d = new Date(`${t}T00:00:00`);
  return Number.isNaN(d.getTime()) ? t : d.toLocaleDateString("en-IN", { weekday: "short", day: "2-digit", month: "short", year: "numeric" });
}

/** Resolve the hovered session (or the latest one when the cursor leaves). */
function useLegend(bars: Bar[], line: LinePoint[], overlays: NonNullable<Props["overlays"]>) {
  return useMemo(() => {
    const barIdx = new Map(bars.map((b, i) => [b.t, i]));
    const lineIdx = new Map(line.map((p) => [p.t, p.value]));
    const ov = overlays.map((o) => ({ name: o.name, color: o.color, at: new Map(o.points.map((p) => [p.t, p.value])) }));
    const last = bars.length ? bars[bars.length - 1].t : line.length ? line[line.length - 1].t : null;
    return { barIdx, lineIdx, ov, last };
  }, [bars, line, overlays]);
}

export function TimeChart({ mode, bars = [], line = [], overlays = [], showVolume = true, height = 380, valueFormat, title, valueLabel }: Props) {
  const el = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const lookup = useLegend(bars, line, overlays);

  useEffect(() => {
    if (!el.current) return;
    const p = palette();
    const chart = createChart(el.current, {
      autoSize: true,
      height,
      layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: p.text, fontFamily: "inherit", attributionLogo: false },
      grid: { vertLines: { color: p.grid }, horzLines: { color: p.grid } },
      rightPriceScale: { borderColor: p.border, scaleMargins: { top: 0.18, bottom: showVolume ? 0.22 : 0.08 } },
      timeScale: { borderColor: p.border, timeVisible: false },
      crosshair: { mode: CrosshairMode.Magnet },
      localization: { locale: "en-IN", priceFormatter: valueFormat ?? ((v: number) => inr(v)) },
    });
    chartRef.current = chart;

    const clean = <T extends { t: string }>(xs: T[]) => xs.filter((x) => x.t);

    if (mode === "candles") {
      const s = chart.addSeries(CandlestickSeries, {
        upColor: p.up, downColor: p.down, wickUpColor: p.up, wickDownColor: p.down, borderVisible: false,
      });
      s.setData(clean(bars).filter((b) => b.c != null).map((b) => ({
        time: b.t as Time, open: b.o ?? b.c!, high: b.h ?? b.c!, low: b.l ?? b.c!, close: b.c!,
      })));
    } else if (mode === "area") {
      const s = chart.addSeries(AreaSeries, {
        lineColor: p.line, topColor: "rgba(79,70,229,0.28)", bottomColor: "rgba(79,70,229,0.02)", lineWidth: 2,
      });
      const src = line.length ? line : bars.map((b) => ({ t: b.t, value: b.c }));
      s.setData(clean(src).filter((x) => x.value != null).map((x) => ({ time: x.t as Time, value: x.value! })));
    } else {
      const s = chart.addSeries(LineSeries, { color: p.line, lineWidth: 2 });
      s.setData(clean(line).filter((x) => x.value != null).map((x) => ({ time: x.t as Time, value: x.value! })));
    }

    for (const o of overlays) {
      const s = chart.addSeries(LineSeries, { color: o.color, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
      s.setData(clean(o.points).filter((x) => x.value != null).map((x) => ({ time: x.t as Time, value: x.value! })));
    }

    if (showVolume && bars.some((b) => b.v)) {
      const v = chart.addSeries(HistogramSeries, { priceFormat: { type: "volume" }, priceScaleId: "vol", lastValueVisible: false, priceLineVisible: false });
      v.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
      v.setData(clean(bars).filter((b) => b.v != null).map((b) => ({
        time: b.t as Time, value: b.v!,
        color: (b.c ?? 0) >= (b.o ?? b.c ?? 0) ? "rgba(16,185,129,0.35)" : "rgba(244,63,94,0.35)",
      })));
    }

    const onMove = (param: MouseEventParams) => {
      if (!param.time || !param.point || param.point.x < 0 || param.point.y < 0) { setHover(null); return; }
      setHover(String(param.time));
    };
    chart.subscribeCrosshairMove(onMove);

    // fitContent stretches a handful of sessions into giant blocks, so new
    // listings keep a normal bar width, anchored to the latest session.
    const points = mode === "candles" || !line.length ? bars.length : line.length;
    if (points < 40) {
      chart.timeScale().applyOptions({ barSpacing: 12, rightOffset: 4 });
      chart.timeScale().scrollToRealTime();
    } else {
      chart.timeScale().fitContent();
    }
    return () => { chart.unsubscribeCrosshairMove(onMove); chart.remove(); chartRef.current = null; };
  }, [mode, bars, line, overlays, showVolume, height, valueFormat]);

  const t = hover ?? lookup.last;
  const fmt = valueFormat ?? ((v: number) => inr(v));
  let body: React.ReactNode = null;
  if (t) {
    const i = lookup.barIdx.get(t);
    const bar = i != null ? bars[i] : undefined;
    const prev = i != null && i > 0 ? bars[i - 1] : undefined;
    const lineValue = lookup.lineIdx.get(t);
    const change = bar?.c != null && prev?.c ? bar.c - prev.c : null;
    const changePct = change != null && prev?.c ? (change / prev.c) * 100 : null;
    const cls = change == null ? "" : change >= 0 ? "text-up" : "text-down";
    const item = (label: string, value: React.ReactNode, className?: string) => (
      <span className="whitespace-nowrap"><span className="text-slate-400">{label} </span><span className={`tabular font-semibold ${className ?? ""}`}>{value}</span></span>
    );

    body = (
      <>
        <div className="flex flex-wrap items-baseline gap-x-2">
          {title && <span className="font-semibold text-slate-800 dark:text-slate-100">{title}</span>}
          <span className="text-slate-500">{dayLabel(t)}</span>
        </div>
        <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5">
          {mode === "line" || (mode === "area" && line.length) ? (
            lineValue != null && item(valueLabel ?? "Value", fmt(lineValue))
          ) : bar ? (
            <>
              {mode === "candles" && bar.o != null && item("O", fmt(bar.o))}
              {mode === "candles" && bar.h != null && item("H", fmt(bar.h))}
              {mode === "candles" && bar.l != null && item("L", fmt(bar.l))}
              {bar.c != null && item(mode === "candles" ? "C" : "Close", fmt(bar.c), cls)}
              {change != null && item("Chg", `${change >= 0 ? "+" : ""}${fmt(change)} (${changePct! >= 0 ? "+" : ""}${changePct!.toFixed(2)}%)`, cls)}
              {showVolume && bar.v != null && item("Vol", volumeText(bar.v))}
            </>
          ) : null}
          {lookup.ov.map((o) => {
            const v = o.at.get(t);
            return v == null ? null : (
              <span key={o.name} className="whitespace-nowrap">
                <span style={{ color: o.color }}>{o.name} </span><span className="tabular font-semibold">{fmt(v)}</span>
              </span>
            );
          })}
        </div>
      </>
    );
  }

  return (
    <div className="relative w-full" style={{ height }}>
      <div ref={el} style={{ height }} className="w-full" />
      {body && (
        <div className="pointer-events-none absolute left-2 top-1 z-10 max-w-[calc(100%-5rem)] rounded-lg bg-white/85 px-2 py-1 text-xs backdrop-blur-sm dark:bg-slate-900/80">
          {body}
        </div>
      )}
    </div>
  );
}

/** Simple moving average over closing prices. */
export function sma(bars: Bar[], period: number): LinePoint[] {
  const out: LinePoint[] = [];
  let sum = 0;
  const q: number[] = [];
  for (const b of bars) {
    if (b.c == null) continue;
    q.push(b.c);
    sum += b.c;
    if (q.length > period) sum -= q.shift()!;
    out.push({ t: b.t, value: q.length === period ? sum / period : null });
  }
  return out;
}
