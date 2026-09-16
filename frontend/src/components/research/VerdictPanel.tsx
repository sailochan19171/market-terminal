"use client";

// The valuation verdict panel: Peter Lynch's rule and four other lenses, with the inputs on show and movable.
//
// Everything here recomputes in the browser from the same formulas the server used (src/lib/valuationMath.ts),
// so dragging the growth slider answers the only question that matters about this method - how much of the
// verdict is the market's price, and how much is the growth you assumed.
import clsx from "clsx";
import { AlertTriangle, Info, RotateCcw } from "lucide-react";
import { useMemo, useState } from "react";
import { QuoteStamp, type PriceQuote } from "@/components/AsOf";
import { AiDisclosure } from "@/components/Disclosure";
import { Card, CardBody, CardHeader, ErrorNote, Skeleton } from "@/components/ui";
import { useApi } from "@/lib/api";
import { num } from "@/lib/format";
import { combine, dcfPerShare, graham, lynch, peg, verdictVsFairValue, type Verdict } from "@/lib/valuationMath";

interface GrowthOption { key: string; label: string; valuePct: number | null; source: string; unavailable?: string }
interface ModelLine { key: string; label: string; verdict: Verdict | null; reading: string; fairValue: number | null; inputs: string; unavailable?: string }
interface Band { upTo: number; verdict: Verdict; meaning: string }

export interface VerdictData {
  symbol: string; company: string | null; kind: "bank" | "corporate";
  price: PriceQuote | null;
  inputs: {
    price: number | null; epsTtm: number | null; bvps: number | null; pe: number | null; pb: number | null;
    dividendYieldPct: number | null; growthPct: number | null; growthBasis: string; growthCapPct: number;
    growthCapped: boolean; sharesCr: number | null; freeCashFlowCr: number | null; netDebtCr: number | null;
    discountRate: number; terminalGrowth: number;
  };
  growthOptions: GrowthOption[];
  lynch: { applicable: boolean; ratio: number | null; pegy: number | null; fairPe: number | null; fairValue: number | null; upsidePct: number | null; verdict: Verdict; meaning: string; why: string; bands: Band[] };
  models: ModelLine[];
  combined: { verdict: Verdict; counts: Record<string, number>; total: number; summary: string };
  peers: { count: number; medianPe: number | null; medianPb: number | null; industry: string | null };
  history: { years: number; medianPe: number | null; percentile: number | null };
  caveats: string[];
  generatedAt: string;
}

export const VERDICT_TONE: Record<string, string> = {
  Undervalued: "bg-emerald-600", "Fair to attractive": "bg-emerald-500", "Fairly valued": "bg-amber-500",
  Overvalued: "bg-rose-600", "Not applicable": "bg-slate-400",
};

const rupee = (v: number | null | undefined) => (v === null || v === undefined ? "Data unavailable" : `₹${num(v)}`);

export function VerdictBadge({ verdict, className }: { verdict: string; className?: string }) {
  return <span className={clsx("inline-flex items-center rounded-full px-3 py-1 text-sm font-semibold text-white", VERDICT_TONE[verdict] ?? "bg-slate-500", className)}>{verdict}</span>;
}

function Slider({ label, value, min, max, step, onChange, format, note }: {
  label: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void; format: (v: number) => string; note?: string;
}) {
  return (
    <label className="block">
      <span className="flex items-baseline justify-between text-xs font-medium text-slate-500">
        {label}<span className="text-sm font-semibold tabular-nums text-slate-900 dark:text-white">{format(value)}</span>
      </span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))}
        className="mt-1.5 w-full accent-indigo-600" aria-label={label} />
      {note && <span className="mt-0.5 block text-[11px] text-slate-400">{note}</span>}
    </label>
  );
}

export function VerdictPanel({ symbol }: { symbol: string }) {
  const { data, error, reload } = useApi<VerdictData>(`/api/v2/company/${encodeURIComponent(symbol)}/verdict`);
  const [growthPct, setGrowth] = useState<number | null>(null);
  const [rate, setRate] = useState<number | null>(null);
  const [open, setOpen] = useState(false);

  const view = useMemo(() => {
    if (!data) return null;
    const i = data.inputs;
    const touched = growthPct !== null || rate !== null;
    const g = growthPct ?? i.growthPct;
    const capped = g !== null && g > i.growthCapPct;
    const gUsed = g === null ? null : Math.min(g, i.growthCapPct);
    const discount = rate ?? i.discountRate;

    const l = lynch({ price: i.price, epsTtm: i.epsTtm, pe: i.pe, growthPct: gUsed, dividendYieldPct: i.dividendYieldPct });
    const pegValue = peg(i.pe, gUsed);
    const grahamValue = graham(i.epsTtm, i.bvps);
    const dcf = touched && gUsed !== null
      ? dcfPerShare(i.freeCashFlowCr, gUsed / 100, i.sharesCr, i.netDebtCr ?? 0, { discountRate: discount })
      : data.models.find((m) => m.key === "dcf")?.fairValue ?? null;

    // Recompute only what the sliders move; the rest is exactly what the server published.
    const models: ModelLine[] = data.models.map((m) => {
      if (m.key === "lynch") {
        return { ...m, verdict: l.applicable ? l.verdict : null, fairValue: l.fairValue, inputs: l.why,
          reading: l.applicable ? `Ratio ${l.ratio} (textbook PEGY ${l.pegy}) · fair P/E ${l.fairPe}` : "Not applicable", unavailable: l.applicable ? undefined : l.why };
      }
      if (m.key === "peg") {
        return { ...m, verdict: pegValue === null ? null : pegValue < 1 ? "Undervalued" : pegValue > 2 ? "Overvalued" : "Fairly valued",
          reading: pegValue === null ? "Not applicable" : `PEG ${pegValue}`,
          inputs: i.pe !== null && gUsed !== null ? `P/E ${i.pe} / growth ${gUsed}%` : m.inputs,
          unavailable: pegValue === null ? m.unavailable ?? "Growth is not positive, so PEG has no meaning." : undefined };
      }
      if (m.key === "dcf" && touched) {
        return { ...m, verdict: verdictVsFairValue(i.price, dcf), fairValue: dcf,
          reading: dcf === null ? "Not applicable" : `₹${dcf} per share at a ${(discount * 100).toFixed(0)}% discount rate and ${gUsed}% growth`,
          unavailable: dcf === null ? m.unavailable : undefined };
      }
      return m;
    });
    return { models, lynch: l, combined: combine(models.map((m) => m.verdict)), grahamValue, gUsed, capped, discount, touched };
  }, [data, growthPct, rate]);

  if (error && !data) return <Card><ErrorNote message={`The valuation verdict could not load: ${error}`} onRetry={reload} /></Card>;
  if (!data || !view) return <Card><CardBody className="space-y-3"><Skeleton className="h-6 w-56" /><Skeleton className="h-24 w-full" /></CardBody></Card>;

  const i = data.inputs;
  const basis = data.growthOptions.find((o) => o.key === i.growthBasis);

  return (
    <Card>
      <CardHeader
        title="Valuation verdict"
        subtitle="Peter Lynch's dividend-adjusted rule alongside four other published methods. Educational, one lens of several - not a recommendation."
        actions={<button type="button" onClick={() => setOpen((o) => !o)} className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-medium text-slate-600 dark:border-slate-700 dark:text-slate-300">{open ? "Hide the workings" : "Show the workings"}</button>}
      />
      <CardBody className="space-y-5">
        <div className="flex flex-wrap items-center gap-3">
          <VerdictBadge verdict={view.combined.verdict} />
          <span className="text-sm font-medium">{view.combined.summary}</span>
          {view.touched && <span className="rounded-md bg-indigo-50 px-2 py-0.5 text-[11px] font-semibold text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300">your inputs</span>}
          <QuoteStamp quote={data.price} className="ml-auto" />
        </div>

        {/* The Lynch reading, front and centre. */}
        <div className="grid gap-px overflow-hidden rounded-2xl bg-slate-200 sm:grid-cols-2 lg:grid-cols-4 dark:bg-slate-800">
          {[
            ["Lynch ratio", view.lynch.applicable ? num(view.lynch.ratio) : "Not applicable", "higher is cheaper · (growth + yield) ÷ P/E"],
            ["Textbook PEGY", view.lynch.applicable ? num(view.lynch.pegy) : "—", "the reciprocal · below 1 is cheap"],
            ["Fair P/E on this rule", view.lynch.applicable ? num(view.lynch.fairPe) : "—", `against a current P/E of ${i.pe === null ? "—" : num(i.pe)}`],
            ["Fair value per share", rupee(view.lynch.fairValue), view.lynch.upsidePct === null ? "" : `${view.lynch.upsidePct > 0 ? "+" : ""}${num(view.lynch.upsidePct, 1)}% against the price`],
          ].map(([label, value, hint]) => (
            <div key={label} className="bg-white p-4 dark:bg-slate-900">
              <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</p>
              <p className="mt-1 text-xl font-semibold tabular-nums">{value}</p>
              {hint && <p className="mt-0.5 text-xs text-slate-400">{hint}</p>}
            </div>
          ))}
        </div>

        {/* The inputs, adjustable. */}
        <div className="rounded-2xl border border-slate-200 p-4 dark:border-slate-800">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-semibold">The growth you assume decides this verdict</p>
            {view.touched && (
              <button type="button" onClick={() => { setGrowth(null); setRate(null); }} className="inline-flex items-center gap-1 text-xs font-medium text-indigo-700 dark:text-indigo-300">
                <RotateCcw size={12} /> back to the measured default
              </button>
            )}
          </div>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {data.growthOptions.map((o) => (
              <button key={o.key} type="button" disabled={o.valuePct === null}
                onClick={() => setGrowth(o.valuePct)}
                title={o.unavailable ?? o.source}
                className={clsx("rounded-lg border px-2.5 py-1.5 text-xs font-medium transition",
                  o.valuePct === null ? "cursor-not-allowed border-slate-200 text-slate-400 dark:border-slate-800" : "border-slate-200 hover:border-indigo-300 dark:border-slate-700",
                  (growthPct ?? i.growthPct) === o.valuePct && o.valuePct !== null && "border-indigo-500 bg-indigo-50 text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300")}>
                {o.label}: {o.valuePct === null ? "unavailable" : `${num(o.valuePct, 1)}%`}
              </button>
            ))}
          </div>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <Slider label="Expected EPS growth" value={view.gUsed ?? 0} min={-20} max={i.growthCapPct} step={0.5}
              onChange={setGrowth} format={(v) => `${v.toFixed(1)}%`}
              note={`Capped at ${i.growthCapPct}% a year${i.growthCapped ? ` — the measured rate was higher` : ""}. ${basis?.source ?? ""}`} />
            <Slider label="Discount rate (cash-flow model)" value={view.discount} min={0.06} max={0.2} step={0.005}
              onChange={setRate} format={(v) => `${(v * 100).toFixed(1)}%`}
              note={`Terminal growth ${(i.terminalGrowth * 100).toFixed(0)}%. Only the discounted cash flow uses this.`} />
          </div>
          <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-1 text-xs sm:grid-cols-4">
            {[["Price", rupee(i.price)], ["EPS (TTM)", i.epsTtm === null ? "Data unavailable" : `₹${num(i.epsTtm)}`],
            ["P/E", i.pe === null ? "Data unavailable" : num(i.pe)], ["Dividend yield", `${num(i.dividendYieldPct ?? 0, 2)}%`],
            ["Book value / share", i.bvps === null ? "Data unavailable" : `₹${num(i.bvps)}`], ["P/B", i.pb === null ? "Data unavailable" : num(i.pb)],
            ["Sector median P/E", data.peers.medianPe === null ? "Data unavailable" : `${num(data.peers.medianPe)} (${data.peers.count})`],
            ["Own 5-year median P/E", data.history.medianPe === null ? "Data unavailable" : num(data.history.medianPe)]].map(([k, v]) => (
              <div key={k}><dt className="text-slate-500">{k}</dt><dd className="font-semibold tabular-nums">{v}</dd></div>
            ))}
          </dl>
        </div>

        {/* Every model. */}
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-100 text-left text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800">
                <th className="py-2 pr-3 font-medium">Model</th>
                <th className="py-2 pr-3 font-medium">Verdict</th>
                <th className="py-2 pr-3 text-right font-medium">Fair value</th>
                <th className="py-2 font-medium">What it reads</th>
              </tr>
            </thead>
            <tbody>
              {view.models.map((m) => (
                <tr key={m.key} className={clsx("border-b border-slate-50 last:border-0 dark:border-slate-800/60", !m.verdict && "text-slate-400")}>
                  <td className="py-2.5 pr-3 font-medium">{m.label}</td>
                  <td className="py-2.5 pr-3">{m.verdict ? <VerdictBadge verdict={m.verdict} className="px-2 py-0.5 text-xs" /> : "Not applicable"}</td>
                  <td className="py-2.5 pr-3 text-right font-semibold tabular-nums">{m.fairValue === null ? "—" : rupee(m.fairValue)}</td>
                  <td className="py-2.5">
                    {m.unavailable ?? m.reading}
                    {open && m.inputs && !m.unavailable && <span className="mt-0.5 block text-xs text-slate-500">{m.inputs}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {open && (
          <div className="rounded-xl bg-slate-50 p-4 text-xs text-slate-600 dark:bg-slate-900/60 dark:text-slate-300">
            <p className="font-semibold text-slate-700 dark:text-slate-200">How the Lynch bands read</p>
            <ul className="mt-1.5 space-y-1">
              {data.lynch.bands.map((b, n) => (
                <li key={b.verdict}>
                  <span className="font-medium">{n === 0 ? `below ${b.upTo}` : b.upTo === null || !Number.isFinite(b.upTo) ? `above ${data.lynch.bands[n - 1].upTo}` : `${data.lynch.bands[n - 1].upTo} – ${b.upTo}`}</span>: {b.verdict} — {b.meaning}
                </li>
              ))}
            </ul>
            <p className="mt-2">Fair value = EPS (TTM) × (growth % + dividend yield %). The same figure equals the price multiplied by the Lynch ratio.</p>
          </div>
        )}

        {data.caveats.map((c) => (
          <p key={c} className="flex gap-2 text-sm text-slate-600 dark:text-slate-300"><AlertTriangle size={15} className="mt-0.5 shrink-0 text-amber-600" />{c}</p>
        ))}

        <p className="flex gap-2 border-t border-slate-100 pt-3 text-xs text-slate-500 dark:border-slate-800">
          <Info size={14} className="mt-0.5 shrink-0" />
          Valuation models are education, not advice. They use past filings and assumptions you can change above; they do
          not predict prices, and nothing here is a recommendation to buy, sell or hold any security.
        </p>
        <AiDisclosure kind="computed" />
      </CardBody>
    </Card>
  );
}
