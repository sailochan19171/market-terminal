"use client";

import clsx from "clsx";
import { Maximize2, Minimize2 } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { Card, CardHeader, Segmented, Skeleton } from "@/components/ui";
import { useApi } from "@/lib/api";
import { dateTime, num, pct } from "@/lib/format";

interface Company { symbol: string; company: string | null; close: number; market_cap_cr: number; change: number | null }
interface Sector { sector: string; market_cap_cr: number; change: number | null; companies: Company[] }
interface HeatmapData { universe: string; metric: string; universes: Record<string, string>; metrics: Record<string, string>; asOf: string; sectors: Sector[] }

interface Rect { x: number; y: number; w: number; h: number }
interface Laid<T> extends Rect { item: T }

/**
 * Squarified treemap (Bruls, Huizing & van Wijk). Lays items out in rows,
 * adding to the current row while doing so improves the worst aspect ratio.
 */
function squarify<T>(items: T[], value: (t: T) => number, box: Rect): Laid<T>[] {
  const sorted = items.filter((i) => value(i) > 0).sort((a, b) => value(b) - value(a));
  const total = sorted.reduce((s, i) => s + value(i), 0);
  if (!total || box.w <= 0 || box.h <= 0) return [];
  const scale = (box.w * box.h) / total;
  const out: Laid<T>[] = [];
  let rect = { ...box };
  let row: T[] = [];

  const worst = (r: T[], side: number) => {
    const areas = r.map((i) => value(i) * scale);
    const sum = areas.reduce((a, b) => a + b, 0);
    const mx = Math.max(...areas), mn = Math.min(...areas);
    return Math.max((side * side * mx) / (sum * sum), (sum * sum) / (side * side * mn));
  };

  const flush = (r: T[]) => {
    const sum = r.reduce((s, i) => s + value(i) * scale, 0);
    const horizontal = rect.w >= rect.h;
    const thickness = horizontal ? sum / rect.h : sum / rect.w;
    let offset = 0;
    for (const i of r) {
      const len = (value(i) * scale) / thickness;
      out.push(horizontal
        ? { item: i, x: rect.x, y: rect.y + offset, w: thickness, h: len }
        : { item: i, x: rect.x + offset, y: rect.y, w: len, h: thickness });
      offset += len;
    }
    rect = horizontal
      ? { x: rect.x + thickness, y: rect.y, w: rect.w - thickness, h: rect.h }
      : { x: rect.x, y: rect.y + thickness, w: rect.w, h: rect.h - thickness };
  };

  for (const item of sorted) {
    const side = Math.min(rect.w, rect.h);
    if (row.length === 0 || worst([...row, item], side) <= worst(row, side)) {
      row.push(item);
    } else {
      flush(row);
      row = [item];
    }
  }
  if (row.length) flush(row);
  return out;
}

/** Red -> neutral -> green, saturating at the given magnitude. */
function heatColor(change: number | null, span: number): string {
  if (change == null) return "rgb(71,85,105)";
  const t = Math.max(-1, Math.min(1, change / span));
  const neutral = [55, 65, 81];
  const target = t >= 0 ? [5, 150, 105] : [225, 29, 72];
  const k = Math.pow(Math.abs(t), 0.75);
  const c = neutral.map((n, i) => Math.round(n + (target[i] - n) * k));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

// Explicit order: the API serialises objects with sorted keys.
const METRICS: [string, string][] = [["pct_1d", "1D"], ["ret_1m", "1M"], ["ret_3m", "3M"], ["ret_1y", "1Y"]];
const UNIVERSES: [string, string][] = [["nifty50", "Nifty 50"], ["nifty100", "Nifty 100"], ["nifty200", "Nifty 200"], ["nifty500", "Nifty 500"], ["niftytotalmarket", "Total market"]];

const HEADER = 18;
const GAP = 2;

export function Heatmap({ height = 560, compact = false }: { height?: number; compact?: boolean }) {
  const [universe, setUniverse] = useState("nifty100");
  const [metric, setMetric] = useState("pct_1d");
  const [expanded, setExpanded] = useState(false);
  const [hover, setHover] = useState<{ c: Company; sector: string; x: number; y: number } | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const { data, loading } = useApi<HeatmapData>(`/api/v2/heatmap?universe=${universe}&metric=${metric}`);

  useEffect(() => {
    if (!box.current) return;
    const ro = new ResizeObserver((e) => setWidth(e[0].contentRect.width));
    ro.observe(box.current);
    return () => ro.disconnect();
  }, []);

  const h = expanded ? Math.max(height, typeof window !== "undefined" ? window.innerHeight - 180 : height) : height;
  // A day's move saturates at 3%; longer windows move further.
  const span = metric === "pct_1d" ? 3 : metric === "ret_1m" ? 10 : metric === "ret_3m" ? 20 : 40;

  const layout = useMemo(() => {
    if (!data || !width) return [];
    return squarify(data.sectors, (s) => s.market_cap_cr, { x: 0, y: 0, w: width, h }).map((s) => {
      const inner = { x: s.x + GAP, y: s.y + HEADER, w: Math.max(0, s.w - GAP * 2), h: Math.max(0, s.h - HEADER - GAP) };
      return { ...s, cells: squarify(s.item.companies, (c) => c.market_cap_cr, inner) };
    });
  }, [data, width, h]);

  return (
    <Card className={clsx(expanded && "fixed inset-4 z-50 overflow-auto shadow-2xl")}>
      <CardHeader title="Stock heatmap"
        subtitle={data ? `${data.universes[universe] ?? "All sectors"} · sized by market cap · ${dateTime(data.asOf)}` : undefined}
        actions={<>
          {!compact && data && (
            <Segmented size="sm" value={universe} onChange={setUniverse}
              options={UNIVERSES.filter(([v]) => v in data.universes).map(([value, label]) => ({ value, label, title: data.universes[value] }))} />
          )}
          {data && (
            <Segmented size="sm" value={metric} onChange={setMetric}
              options={METRICS.filter(([v]) => v in data.metrics).map(([value, label]) => ({ value, label, title: data.metrics[value] }))} />
          )}
          <button onClick={() => setExpanded((e) => !e)} aria-label={expanded ? "Collapse" : "Expand"}
            className="rounded-lg p-2 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800">
            {expanded ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
          </button>
        </>} />
      <div className="px-5 pb-5 pt-4 sm:px-6">
        <div ref={box} className="relative w-full overflow-hidden rounded-xl bg-slate-900" style={{ height: h }}
          onMouseLeave={() => setHover(null)}>
          {(loading && !data) && <Skeleton className="absolute inset-0 rounded-xl" />}
          {layout.map((s) => (
            <div key={s.item.sector}>
              <div className="absolute truncate px-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-300"
                style={{ left: s.x, top: s.y, width: s.w, height: HEADER, lineHeight: `${HEADER}px` }} title={s.item.sector}>
                {s.w > 70 ? `${s.item.sector} ${s.item.change != null ? pct(s.item.change, 1) : ""}` : ""}
              </div>
              {s.cells.map((c) => {
                const big = c.w > 90 && c.h > 56;
                const mid = c.w > 44 && c.h > 30;
                return (
                  <Link key={c.item.symbol} href={`/company/${c.item.symbol}`}
                    className="absolute flex flex-col items-center justify-center overflow-hidden text-center text-white outline outline-1 outline-slate-900 transition-[filter] hover:z-10 hover:brightness-125"
                    style={{ left: c.x, top: c.y, width: c.w, height: c.h, background: heatColor(c.item.change, span) }}
                    onMouseMove={(e) => {
                      const r = box.current!.getBoundingClientRect();
                      setHover({ c: c.item, sector: s.item.sector, x: e.clientX - r.left, y: e.clientY - r.top });
                    }}>
                    {mid && (
                      <>
                        <span className={clsx("block max-w-full truncate px-1 font-semibold leading-tight", big ? "text-base" : "text-[11px]")}>{c.item.symbol}</span>
                        <span className={clsx("tabular leading-tight opacity-90", big ? "text-sm" : "text-[10px]")}>{pct(c.item.change, 2)}</span>
                      </>
                    )}
                  </Link>
                );
              })}
            </div>
          ))}
          {hover && (
            <div className="pointer-events-none absolute z-20 w-56 rounded-xl border border-slate-700 bg-slate-950/95 p-3 text-xs text-slate-200 shadow-xl"
              style={{ left: Math.min(hover.x + 14, width - 236), top: Math.min(hover.y + 14, h - 110) }}>
              <p className="text-sm font-semibold text-white">{hover.c.symbol}</p>
              <p className="truncate text-slate-400">{hover.c.company}</p>
              <p className="mt-2 flex justify-between"><span className="text-slate-400">Price</span><span className="tabular">₹{num(hover.c.close)}</span></p>
              <p className="flex justify-between"><span className="text-slate-400">Change</span>
                <span className={clsx("tabular font-semibold", (hover.c.change ?? 0) >= 0 ? "text-emerald-400" : "text-rose-400")}>{pct(hover.c.change)}</span></p>
              <p className="flex justify-between"><span className="text-slate-400">Market cap</span><span className="tabular">₹{num(hover.c.market_cap_cr, 0)} Cr</span></p>
              <p className="mt-1 truncate text-slate-500">{hover.sector}</p>
            </div>
          )}
        </div>
        <div className="mt-3 flex items-center justify-end gap-2 text-[11px] text-slate-500">
          <span className="tabular">−{span}%</span>
          <div className="h-2 w-40 rounded-full" style={{ background: `linear-gradient(90deg, ${heatColor(-span, span)}, ${heatColor(0, span)}, ${heatColor(span, span)})` }} />
          <span className="tabular">+{span}%</span>
        </div>
      </div>
    </Card>
  );
}
