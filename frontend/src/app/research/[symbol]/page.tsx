"use client";

import clsx from "clsx";
import { AlertTriangle, CheckCircle2, ExternalLink, Info } from "lucide-react";
import Link from "next/link";
import { use } from "react";
import { PageLoader } from "@/components/PageLoader";
import { Ask } from "@/components/research/Ask";
import { RiskFlags } from "@/components/research/RiskFlags";
import { VerdictPanel } from "@/components/research/VerdictPanel";
import { WhyMoving } from "@/components/research/WhyMoving";
import { Card, CardBody, CardHeader, ErrorNote, Stat } from "@/components/ui";
import { useApi } from "@/lib/api";
import { dateOnly, num, pct } from "@/lib/format";

interface Model { key: string; label: string; fairValue: number | null; weight: number; basis: string; unavailable?: string }
interface Zone { key: string; label: string; from: number | null; to: number | null; meaning: string }
interface Source { label: string; origin: string; period?: string | null; asOf?: string | null; url?: string | null }
interface Condition { key: string; label: string; met: boolean | null; detail: string }
interface ScoreRow { key: string; label: string; score: number | null; weight: number; detail: string }
interface Decision {
  verdict: string; score: number | null; confidence: string;
  risk: { level: string; score: number | null; factors: { label: string; level: string; detail: string }[] };
  scores: ScoreRow[]; conditions: Condition[]; conditionsMet: string;
  whyInvest: string[]; whyWait: string[]; whatCouldGoWrong: string[]; whatToWatch: string[];
}

interface Valuation {
  symbol: string; company: string | null; kind: "bank" | "corporate";
  price: { close: number | null; session: string | null };
  inputs: Record<string, number | string | null>;
  models: Model[];
  fairValue: number | null;
  range: { bear: number | null; base: number | null; bull: number | null };
  confidence: "high" | "medium" | "low" | "none"; confidenceWhy: string;
  upsidePct: number | null; marginOfSafety: number | null; status: string;
  zones: Zone[];
  history: { years: number; medianPe: number | null; minPe: number | null; maxPe: number | null; percentile: number | null; points: { date: string; pe: number }[] };
  peers: { count: number; medianPe: number | null; medianPb: number | null; industry: string | null };
  reasons: string[]; cautions: string[]; sources: Source[]; generatedAt: string;
}

const TONE: Record<string, string> = {
  "DEEPLY UNDERVALUED": "bg-emerald-600", UNDERVALUED: "bg-emerald-500", "FAIRLY VALUED": "bg-slate-500",
  "MODERATELY OVERVALUED": "bg-amber-500", OVERVALUED: "bg-rose-500", "EXTREMELY OVERVALUED": "bg-rose-600",
  "DATA UNAVAILABLE": "bg-slate-400",
};


const VERDICT_TONE: Record<string, string> = {
  "SCREENS UNDERVALUED": "bg-emerald-600", "SCREENS FAIRLY VALUED": "bg-slate-500", "SCREENS EXPENSIVE": "bg-rose-600",
  "MIXED SIGNALS": "bg-amber-500", "DATA UNAVAILABLE": "bg-slate-400",
};

const rupee = (v: number | null | undefined) => (v === null || v === undefined ? "Data unavailable" : `₹${num(v)}`);

/** Where the current price sits across the valuation zones. */
function ZoneBar({ v }: { v: Valuation }) {
  const top = v.zones.at(-1)?.from;
  const max = Math.max(top ?? 0, v.price.close ?? 0) * 1.1;
  const at = (x: number | null) => `${Math.min(100, Math.max(0, ((x ?? 0) / max) * 100))}%`;
  const colours = ["bg-emerald-600", "bg-emerald-400", "bg-slate-300 dark:bg-slate-600", "bg-amber-400", "bg-rose-500"];
  return (
    <div>
      <div className="flex h-7 overflow-hidden rounded-lg">
        {v.zones.map((z, i) => (
          <div key={z.key} title={`${z.label}: ${z.meaning}`}
            className={clsx(colours[i], "relative")}
            style={{ width: `${(((z.to ?? max) - (z.from ?? 0)) / max) * 100}%` }} />
        ))}
      </div>
      <div className="relative h-8">
        {v.price.close !== null && (
          <div className="absolute -translate-x-1/2 text-center" style={{ left: at(v.price.close) }}>
            <div className="mx-auto h-3 w-px bg-slate-900 dark:bg-white" />
            <span className="whitespace-nowrap text-xs font-semibold">Price {rupee(v.price.close)}</span>
          </div>
        )}
        {v.fairValue !== null && (
          <div className="absolute -translate-x-1/2 text-center text-indigo-600 dark:text-indigo-300" style={{ left: at(v.fairValue) }}>
            <div className="mx-auto h-3 w-px bg-indigo-500" />
            <span className="whitespace-nowrap text-xs font-semibold">Fair {rupee(v.fairValue)}</span>
          </div>
        )}
      </div>
      <dl className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
        {v.zones.map((z, i) => (
          <div key={z.key} className="rounded-lg border border-slate-200 p-2.5 dark:border-slate-800">
            <div className="flex items-center gap-1.5 text-xs font-semibold"><span className={clsx("h-2 w-2 rounded-full", colours[i])} />{z.label}</div>
            <div className="mt-1 text-sm font-medium tabular-nums">{z.from === null ? `Below ${rupee(z.to)}` : z.to === null ? `Above ${rupee(z.from)}` : `${rupee(z.from)} – ${rupee(z.to)}`}</div>
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{z.meaning}</p>
          </div>
        ))}
      </dl>
    </div>
  );
}

export default function ResearchPage({ params }: { params: Promise<{ symbol: string }> }) {
  const { symbol } = use(params);
  const key = decodeURIComponent(symbol);
  const { data, error, reload } = useApi<Valuation>(`/api/v2/company/${encodeURIComponent(key)}/valuation`);
  const call = useApi<Decision>(`/api/v2/company/${encodeURIComponent(key)}/decision`);

  if (error && !data) return <Card><ErrorNote message={`Valuation could not load: ${error}`} onRetry={reload} /></Card>;
  if (!data) return <PageLoader label={`Valuing ${key}`} detail="Reading filings, prices and peer valuations, then running each model." />;

  const used = data.models.filter((m) => m.fairValue !== null);
  const missing = data.models.filter((m) => m.fairValue === null);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-400">Valuation research</p>
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{data.company ?? data.symbol}</h1>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            {data.symbol} · {data.kind === "bank" ? "valued on book value and earnings, as a lender" : "valued on cash flow, earnings and enterprise value"}
            {data.price.session && ` · priced at the ${dateOnly(data.price.session)} close`}
          </p>
        </div>
        <Link href={`/company/${encodeURIComponent(data.symbol)}`} className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-medium transition hover:border-indigo-300 dark:border-slate-700 dark:bg-slate-900">
          Company dashboard →
        </Link>
      </div>

      <Card>
        <div className="grid gap-px overflow-hidden rounded-2xl bg-slate-200 sm:grid-cols-2 lg:grid-cols-5 dark:bg-slate-800">
          {[
            ["Current price", rupee(data.price.close), data.price.session ? dateOnly(data.price.session) : ""],
            ["Estimated fair value", rupee(data.fairValue), `${used.length} of ${data.models.length} models`],
            ["Upside to fair value", data.upsidePct === null ? "Data unavailable" : pct(data.upsidePct), "if the estimate is right"],
            ["Margin of safety", data.marginOfSafety === null ? "Data unavailable" : pct(data.marginOfSafety), "discount to fair value"],
            ["Confidence", data.confidence.toUpperCase(), `${data.range.bear === null ? "" : `range ${rupee(data.range.bear)} – ${rupee(data.range.bull)}`}`],
          ].map(([label, value, hint]) => (
            <div key={label} className="bg-white p-4 dark:bg-slate-900">
              <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</p>
              <p className="mt-1 text-xl font-semibold tabular-nums">{value}</p>
              {hint && <p className="mt-0.5 text-xs text-slate-400">{hint}</p>}
            </div>
          ))}
        </div>
        <CardBody className="border-t border-slate-100 dark:border-slate-800">
          <div className="flex flex-wrap items-center gap-3">
            <span className={clsx("rounded-full px-3 py-1 text-sm font-semibold text-white", TONE[data.status] ?? "bg-slate-500")}>{data.status}</span>
            <span className="text-sm text-slate-500 dark:text-slate-400">{data.confidenceWhy}</span>
          </div>
        </CardBody>
      </Card>

      <WhyMoving symbol={data.symbol} />

      <VerdictPanel symbol={data.symbol} />

      <RiskFlags symbol={data.symbol} />

      <Card>
        <CardHeader title="Where the price sits" subtitle="Zones follow from the weighted fair value; they are not price targets." />
        <CardBody><ZoneBar v={data} /></CardBody>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title="What supports the valuation" subtitle="Read together with the cautions; neither is advice." />
          <CardBody className="space-y-2">
            {data.reasons.length ? data.reasons.map((r) => (
              <p key={r} className="flex gap-2 text-sm"><CheckCircle2 size={16} className="mt-0.5 shrink-0 text-emerald-600" />{r}</p>
            )) : <p className="text-sm text-slate-500">Nothing in the data stands out in the company&apos;s favour at this price.</p>}
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Cautions" subtitle="What would make this estimate wrong." />
          <CardBody className="space-y-2">
            {data.cautions.length ? data.cautions.map((c) => (
              <p key={c} className="flex gap-2 text-sm"><AlertTriangle size={16} className="mt-0.5 shrink-0 text-amber-600" />{c}</p>
            )) : <p className="text-sm text-slate-500">No cautions were raised by the checks that ran.</p>}
          </CardBody>
        </Card>
      </div>

      <Card>
        <CardHeader title="Every model, and how it was calculated" subtitle="Each value comes from reported figures; the weight decides its share of the estimate." />
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-100 text-left text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800">
                <th className="px-5 py-2 font-medium sm:px-6">Model</th>
                <th className="px-3 py-2 text-right font-medium">Fair value</th>
                <th className="px-3 py-2 text-right font-medium">Weight</th>
                <th className="px-5 py-2 font-medium sm:px-6">Basis</th>
              </tr>
            </thead>
            <tbody>
              {used.map((m) => (
                <tr key={m.key} className="border-b border-slate-50 last:border-0 dark:border-slate-800/60">
                  <td className="px-5 py-2.5 font-medium sm:px-6">{m.label}</td>
                  <td className="px-3 py-2.5 text-right font-semibold tabular-nums">{rupee(m.fairValue)}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums text-slate-500">{Math.round(m.weight * 100)}%</td>
                  <td className="px-5 py-2.5 text-slate-600 sm:px-6 dark:text-slate-300">{m.basis}</td>
                </tr>
              ))}
              {missing.map((m) => (
                <tr key={m.key} className="border-b border-slate-50 last:border-0 text-slate-400 dark:border-slate-800/60">
                  <td className="px-5 py-2.5 sm:px-6">{m.label}</td>
                  <td className="px-3 py-2.5 text-right">Data unavailable</td>
                  <td className="px-3 py-2.5 text-right">—</td>
                  <td className="px-5 py-2.5 sm:px-6">{m.unavailable}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader title="Figures the models used" subtitle="Straight from the filings and the last session, nothing estimated." />
          <CardBody>
            <div className="grid gap-x-8 sm:grid-cols-2">
              {Object.entries(data.inputs).map(([k, v]) => (
                <Stat key={k} label={k.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase()).replace(/ Cr$/, " (₹ Cr)").replace("Ttm", "(TTM)")}
                  value={v === null ? <span className="text-slate-400">Data unavailable</span> : typeof v === "number" ? num(v) : String(v)} />
              ))}
            </div>
          </CardBody>
        </Card>
        <Card>
          <CardHeader title={`Its own ${data.history.years}-year valuation`} subtitle="Month-end price against earnings reported by then." />
          <CardBody>
            <Stat label="Current P/E" value={data.inputs.currentPe === null ? "Data unavailable" : num(data.inputs.currentPe as number)} />
            <Stat label="Median P/E" value={data.history.medianPe === null ? "Data unavailable" : num(data.history.medianPe)} />
            <Stat label="Lowest / highest" value={data.history.minPe === null ? "Data unavailable" : `${num(data.history.minPe)} – ${num(data.history.maxPe)}`} />
            <Stat label="Percentile now" value={data.history.percentile === null ? "Data unavailable" : `${data.history.percentile}th`} hint={`${data.history.points.length} month-ends`} />
            <Stat label={`Peer median P/E (${data.peers.industry ?? "—"})`} value={data.peers.medianPe === null ? "Data unavailable" : `${num(data.peers.medianPe)} · ${data.peers.count} companies`} />
            <Stat label="Peer median P/B" value={data.peers.medianPb === null ? "Data unavailable" : num(data.peers.medianPb)} />
          </CardBody>
        </Card>
      </div>


      {call.data && (
        <Card>
          <CardHeader title="How it screens on these checks" subtitle={`Score ${call.data.score ?? "unavailable"}/100 · risk ${call.data.risk.level} · confidence ${call.data.confidence} · ${call.data.conditionsMet}`} />
          <CardBody className="space-y-5">
            <div className="flex flex-wrap items-center gap-3">
              <span className={clsx("rounded-full px-3 py-1 text-sm font-semibold text-white", VERDICT_TONE[call.data.verdict] ?? "bg-slate-500")}>{call.data.verdict}</span>
              <span className="text-sm text-slate-500 dark:text-slate-400">Educational analysis of published figures. No buy, sell, hold or target-price recommendation is given.</span>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              {call.data.conditions.map((c) => (
                <div key={c.key} className="flex gap-2 rounded-lg border border-slate-200 p-2.5 text-sm dark:border-slate-800">
                  <span className={clsx("mt-0.5 shrink-0", c.met === null ? "text-slate-400" : c.met ? "text-emerald-600" : "text-rose-600")}>{c.met === null ? "—" : c.met ? "✓" : "✗"}</span>
                  <span><span className="font-medium">{c.label}</span><span className="block text-xs text-slate-500 dark:text-slate-400">{c.detail}</span></span>
                </div>
              ))}
            </div>
            <div className="grid gap-6 lg:grid-cols-2">
              <div>
                <p className="text-sm font-semibold">What supports the case</p>
                {call.data.whyInvest.length ? call.data.whyInvest.map((x) => <p key={x} className="mt-1 text-sm text-slate-600 dark:text-slate-300">• {x}</p>) : <p className="mt-1 text-sm text-slate-500">Nothing in the data stands in the company&apos;s favour at this price.</p>}
              </div>
              <div>
                <p className="text-sm font-semibold">What weighs against it</p>
                {call.data.whyWait.length ? call.data.whyWait.map((x) => <p key={x} className="mt-1 text-sm text-slate-600 dark:text-slate-300">• {x}</p>) : <p className="mt-1 text-sm text-slate-500">No concerns were raised by the checks that ran.</p>}
              </div>
              <div>
                <p className="text-sm font-semibold">What could go wrong</p>
                {call.data.whatCouldGoWrong.map((x) => <p key={x} className="mt-1 text-sm text-slate-600 dark:text-slate-300">• {x}</p>)}
              </div>
              <div>
                <p className="text-sm font-semibold">What to watch</p>
                {call.data.whatToWatch.map((x) => <p key={x} className="mt-1 text-sm text-slate-600 dark:text-slate-300">• {x}</p>)}
              </div>
            </div>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
              {call.data.scores.map((s) => (
                <div key={s.key} className="rounded-lg border border-slate-200 p-2.5 dark:border-slate-800">
                  <div className="flex items-baseline justify-between"><span className="text-xs font-semibold uppercase tracking-wide text-slate-500">{s.label}</span><span className="text-sm font-semibold tabular-nums">{s.score ?? "—"}</span></div>
                  <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{s.detail}</p>
                </div>
              ))}
            </div>
          </CardBody>
        </Card>
      )}

      <Ask symbol={data.symbol} company={data.company} />

      <Card>
        <CardHeader title="Where each number came from" subtitle="Open the filing to check any figure yourself." />
        <CardBody className="space-y-2">
          {data.sources.map((s) => (
            <p key={s.label} className="flex flex-wrap items-center gap-2 text-sm">
              <span className="font-medium">{s.label}:</span>
              <span className="text-slate-600 dark:text-slate-300">{s.origin}</span>
              {s.period && <span className="text-slate-500">· period {s.period}</span>}
              {s.asOf && <span className="text-slate-500">· as of {dateOnly(s.asOf)}</span>}
              {s.url && <a href={s.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-indigo-700 hover:underline dark:text-indigo-300">filing <ExternalLink size={12} /></a>}
            </p>
          ))}
          <p className="flex gap-2 pt-2 text-xs text-slate-500">
            <Info size={14} className="mt-0.5 shrink-0" />
            Estimates from published figures and stated assumptions, not advice or a forecast. Models can be wrong, and the
            assumptions behind them (growth, discount rate, multiples) are visible above so you can judge them.
          </p>
        </CardBody>
      </Card>
    </div>
  );
}
