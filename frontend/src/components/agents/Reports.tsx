"use client";

// Every report behind an analysis, rendered (spec §3.10): the live agent graph, score cards, and one panel per
// worker - so any number in the written answer can be followed back to the calculation and the filing.
import clsx from "clsx";
import {
  AlertTriangle, BookOpen, Building2, CheckCircle2, ChevronDown, CircleDashed, ExternalLink, Gauge, Layers, LineChart, Loader2,
  Newspaper, Scale, Search, ShieldCheck, Sparkles, Workflow, XCircle,
} from "lucide-react";
import { Fragment, useState } from "react";
import {
  big, CATEGORY_LABEL, fmt, marketLabel, money, pct, times,
  type Analysis, type Company, type Currency, type QItem, type Qualitative, type RatioPoint, type RatioReport, type Step, type Technical, type Valuation,
} from "./client";

// --- the live graph -------------------------------------------------------------------------------

const NODES: { key: string; label: string; icon: typeof Search; hint: string; llm: boolean }[] = [
  { key: "input_layer", label: "Input layer", icon: Search, hint: "ticker, intent, guardrails", llm: true },
  { key: "orchestrator", label: "Persona orchestrator", icon: Sparkles, hint: "research plan", llm: true },
  { key: "data_agent", label: "Data agent", icon: BookOpen, hint: "10 years, IN + US providers", llm: false },
  { key: "ratio_engine", label: "Ratio engine", icon: Layers, hint: "40+ ratios, trends, scores", llm: false },
  { key: "valuation_agent", label: "Valuation agent", icon: Scale, hint: "DCF + multiples", llm: true },
  { key: "technical_agent", label: "Technical agent", icon: LineChart, hint: "price trends", llm: false },
  { key: "news_moat_agent", label: "News and moat agent", icon: Newspaper, hint: "filings + news", llm: true },
  { key: "validator", label: "Validator agent", icon: ShieldCheck, hint: "rule checks", llm: false },
  { key: "synthesis", label: "Persona synthesis", icon: Sparkles, hint: "applies philosophy", llm: true },
];

type NodeState = "idle" | "running" | "done" | "error" | "skipped";

function nodeStates(steps: Step[], finished: boolean) {
  const out: Record<string, { state: NodeState; ms: number; runs: number; llm: number }> = {};
  for (const n of NODES) out[n.key] = { state: "idle", ms: 0, runs: 0, llm: 0 };
  for (const s of steps) {
    const o = out[s.agent];
    if (!o) continue;
    if (s.stage === "start") { o.state = "running"; o.runs++; }
    if (s.stage === "done") { o.state = "done"; o.ms += s.durationMs ?? 0; }
    if (s.stage === "error" || s.stage === "contract_failed") o.state = "error";
    if (s.stage === "llm") o.llm++;
  }
  if (finished) for (const o of Object.values(out)) if (o.state === "idle" || o.state === "running") o.state = o.state === "running" ? "error" : "skipped";
  return out;
}

export function AgentGraph({ steps, finished, compact = false }: { steps: Step[]; finished: boolean; compact?: boolean }) {
  const states = nodeStates(steps, finished);
  const llmCalls = steps.filter((s) => s.stage === "llm").length;
  const loops = steps.filter((s) => s.stage === "loop").length;
  const node = (key: string) => {
    const n = NODES.find((m) => m.key === key)!;
    const s = states[key];
    const Icon = s.state === "done" ? CheckCircle2 : s.state === "error" ? XCircle : s.state === "running" ? Loader2 : s.state === "skipped" ? CircleDashed : n.icon;
    return (
      <div key={key} className={clsx("min-w-0 rounded-lg border px-2.5 py-1.5 text-left transition",
        s.state === "running" && "border-indigo-400 bg-indigo-50 shadow-sm shadow-indigo-500/10 dark:border-indigo-400/50 dark:bg-indigo-500/15",
        s.state === "done" && "border-emerald-200 bg-emerald-50/70 dark:border-emerald-500/30 dark:bg-emerald-500/10",
        s.state === "error" && "border-rose-200 bg-rose-50 dark:border-rose-500/30 dark:bg-rose-500/10",
        (s.state === "idle" || s.state === "skipped") && "border-slate-200 bg-white dark:border-slate-700/70 dark:bg-slate-900",
        s.state === "skipped" && "opacity-45")}>
        <div className="flex items-center gap-1.5">
          <Icon size={13} className={clsx("shrink-0", s.state === "running" && "animate-spin text-indigo-600", s.state === "done" && "text-emerald-600", s.state === "error" && "text-rose-600")} aria-hidden />
          <span className="truncate text-[12px] font-semibold">{n.label}</span>
          {n.llm && <span className="ml-auto rounded bg-violet-100 px-1 text-[9px] font-semibold uppercase text-violet-700 dark:bg-violet-500/20 dark:text-violet-300">{s.llm ? `${s.llm} LLM` : "LLM"}</span>}
        </div>
        {!compact && (
          <p className="mt-0.5 truncate text-[10.5px] text-slate-500">
            {s.state === "skipped" ? "not needed" : s.state === "done" ? `${s.ms < 1000 ? `${s.ms} ms` : `${(s.ms / 1000).toFixed(1)} s`}${s.runs > 1 ? ` · ${s.runs} runs` : ""}` : s.state === "error" ? "failed - listed as missing" : n.hint}
          </p>
        )}
      </div>
    );
  };
  const arrow = <div className="flex justify-center text-slate-300 dark:text-slate-600" aria-hidden>↓</div>;
  return (
    <div className="space-y-1" aria-live="polite" aria-label="Agent workflow">
      <div className="grid grid-cols-3 gap-1.5">{["input_layer", "orchestrator", "data_agent"].map(node)}</div>
      {arrow}
      <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">{["ratio_engine", "valuation_agent", "technical_agent", "news_moat_agent"].map(node)}</div>
      {arrow}
      <div className="grid grid-cols-2 gap-1.5">{["validator", "synthesis"].map(node)}</div>
      <p className="pt-1 text-[10.5px] text-slate-500">
        LangGraph · {llmCalls} of 12 model calls · {loops} of 2 loop-backs · numbers are computed in code; models only plan, read and write
      </p>
    </div>
  );
}

// --- small pieces -----------------------------------------------------------------------------------

export function ScoreCard({ label, value, weight, hint }: { label: string; value: number | null; weight?: number; hint: string }) {
  const tone = value == null ? "bg-slate-300" : value >= 65 ? "bg-emerald-500" : value >= 45 ? "bg-amber-500" : "bg-rose-500";
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-3 dark:border-slate-800 dark:bg-slate-900">
      <div className="flex flex-wrap items-baseline justify-between gap-x-2">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{label}</span>
        {weight !== undefined && <span className="whitespace-nowrap text-[10px] text-slate-400">weight {Math.round(weight * 100)}%</span>}
      </div>
      <p className="mt-1 text-2xl font-semibold tabular-nums">{value ?? "—"}<span className="text-xs font-normal text-slate-400">{value != null ? " / 100" : ""}</span></p>
      <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800"><div className={clsx("h-full rounded-full", tone)} style={{ width: `${value ?? 0}%` }} /></div>
      <p className="mt-1.5 text-[10.5px] leading-snug text-slate-500">{hint}</p>
    </div>
  );
}

function Spark({ series }: { series: RatioPoint[] }) {
  const pts = series.filter((p) => p.value != null) as { year: number; value: number }[];
  if (pts.length < 2) return <span className="text-[11px] text-slate-400">—</span>;
  const min = Math.min(...pts.map((p) => p.value)), max = Math.max(...pts.map((p) => p.value));
  const w = 64, h = 18;
  const path = pts.map((p, i) => `${i ? "L" : "M"}${(i / (pts.length - 1)) * w},${h - (max === min ? h / 2 : ((p.value - min) / (max - min)) * h)}`).join(" ");
  return <svg width={w} height={h} viewBox={`0 -2 ${w} ${h + 4}`} className="text-indigo-500" aria-label={`FY${pts[0].year} to FY${pts.at(-1)!.year}`}><path d={path} fill="none" stroke="currentColor" strokeWidth={1.5} /></svg>;
}

const TREND: Record<string, string> = { improving: "text-emerald-600", declining: "text-rose-600", stable: "text-slate-500" };
const Empty = ({ children }: { children: React.ReactNode }) => <p className="text-sm text-slate-500">{children}</p>;

// --- panels ------------------------------------------------------------------------------------------

export function OverviewPanel({ c }: { c: Company }) {
  const cur = c.currency;
  return (
    <div className="space-y-4">
      <div className="grid gap-2 sm:grid-cols-4">
        {[
          ["Price", `${money(cur, c.quote?.lastPrice)}${c.quote?.changePct != null ? ` (${c.quote.changePct > 0 ? "+" : ""}${c.quote.changePct.toFixed(2)}%)` : ""}`],
          ["Market cap", big(cur, c.marketCap)],
          ["Fiscal year ends", c.fiscalYearEnd ?? "—"],
          ["History", c.years.length ? `FY${c.years[0]}–FY${c.years.at(-1)} (${c.years.length})` : "—"],
        ].map(([k, v]) => <div key={k} className="rounded-lg border border-slate-200 px-3 py-2 dark:border-slate-800"><p className="text-[11px] text-slate-500">{k}</p><p className="font-semibold tabular-nums">{v}</p></div>)}
      </div>
      <p className="text-xs text-slate-500">{marketLabel(c)} · {c.ticker} · {c.industry ?? "industry not on record"} · {c.sectorSet === "financial" ? "financial-sector ratio set" : "standard ratio set"} · amounts in {cur}{c.quote?.asOfTimestamp ? ` · price as of ${c.quote.asOfTimestamp.slice(0, 10)} (${c.quote.source})` : ""}</p>
      <div>
        <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">Last {c.quarterly.length} quarters{c.ttmPeriodEnd ? ` · trailing twelve months to ${c.ttmPeriodEnd}` : ""}</h4>
        {c.quarterly.length ? (
          <div className="overflow-x-auto rounded-xl border border-slate-200 dark:border-slate-800">
            <table className="w-full min-w-[480px] text-sm tabular-nums">
              <thead><tr className="bg-slate-50 text-left text-[11px] uppercase tracking-wide text-slate-500 dark:bg-slate-900/60"><th className="px-3 py-1.5 font-medium">Quarter ended</th><th className="px-2 py-1.5 text-right font-medium">Revenue</th><th className="px-2 py-1.5 text-right font-medium">Operating profit</th><th className="px-2 py-1.5 text-right font-medium">Net income</th><th className="px-3 py-1.5 text-right font-medium">Diluted EPS</th></tr></thead>
              <tbody>{c.quarterly.map((q) => (
                <tr key={q.periodEnd} className="border-t border-slate-100 dark:border-slate-800/60">
                  <td className="px-3 py-1.5">{q.periodEnd}</td><td className="px-2 py-1.5 text-right">{big(cur, q.revenue)}</td><td className="px-2 py-1.5 text-right">{big(cur, q.operatingIncome)}</td>
                  <td className="px-2 py-1.5 text-right">{big(cur, q.netIncome)}</td><td className="px-3 py-1.5 text-right">{money(cur, q.epsDiluted)}</td>
                </tr>))}
              </tbody>
            </table>
          </div>
        ) : <Empty>No quarterly results on record.</Empty>}
      </div>
      <div>
        <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">Sources</h4>
        <ul className="space-y-0.5 text-xs text-slate-500">
          {c.sources.map((s, i) => <li key={`${i}-${s.dataset}`}><span className="font-medium text-slate-600 dark:text-slate-300">{s.dataset.replace(/_/g, " ")}</span>: {s.source} · fetched {s.fetchedAt.slice(0, 10)}</li>)}
          {c.filingLinks.map((l, i) => <li key={`${i}-${l.label}`}><a href={l.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-0.5 text-indigo-700 hover:underline dark:text-indigo-300">{l.label} <ExternalLink size={10} /></a></li>)}
        </ul>
      </div>
    </div>
  );
}

export function RatioTable({ ratios, currency }: { ratios: RatioReport; currency: Currency }) {
  const [open, setOpen] = useState<string | null>(null);
  const hasTtm = Object.values(ratios.categories).some((c) => Object.values(c).some((s) => s.ttm));
  return (
    <div className="space-y-5">
      <p className="text-xs text-slate-500">
        FY{ratios.years[0]}–FY{ratios.years.at(-1)} ({ratios.years.length} fiscal years){hasTtm ? " plus trailing twelve months" : ""} · sector comparison against {ratios.peers.count} peers in the same market{ratios.peers.count < 5 ? " (fewer than 5, so no sector medians)" : ""} · click a row for every year and its inputs
      </p>
      {Object.entries(ratios.categories).map(([category, entries]) => (
        <div key={category}>
          <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">{CATEGORY_LABEL[category] ?? category}</h4>
          <div className="overflow-x-auto rounded-xl border border-slate-200 dark:border-slate-800">
            <table className="w-full min-w-[640px] text-sm">
              <thead>
                <tr className="bg-slate-50 text-left text-[11px] uppercase tracking-wide text-slate-500 dark:bg-slate-900/60">
                  <th className="px-3 py-1.5 font-medium">Ratio</th><th className="px-2 py-1.5 text-right font-medium">Latest FY</th>
                  {hasTtm && <th className="px-2 py-1.5 text-right font-medium">TTM</th>}
                  <th className="px-2 py-1.5 text-right font-medium">Median</th><th className="px-2 py-1.5 font-medium">History</th>
                  <th className="px-2 py-1.5 font-medium">Trend</th><th className="px-3 py-1.5 text-right font-medium">Sector</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(entries).map(([key, s]) => (
                  <Fragment key={key}>
                    <tr className="cursor-pointer border-t border-slate-100 hover:bg-slate-50 dark:border-slate-800/60 dark:hover:bg-slate-800/40" onClick={() => setOpen(open === key ? null : key)}>
                      <td className="px-3 py-1.5"><span className="inline-flex items-center gap-1 font-medium"><ChevronDown size={12} className={clsx("transition", open === key ? "rotate-0" : "-rotate-90")} />{s.label}</span></td>
                      <td className="px-2 py-1.5 text-right font-semibold tabular-nums">
                        {s.latest == null ? <span className="text-xs font-normal text-slate-400">{(s.series.at(-1)?.reason ?? "n/a").replace(/_/g, " ")}</span> : fmt(s, s.latest, currency)}
                      </td>
                      {hasTtm && <td className="px-2 py-1.5 text-right tabular-nums text-slate-600 dark:text-slate-300">{s.ttm ? fmt(s, s.ttm.value, currency) : "—"}</td>}
                      <td className="px-2 py-1.5 text-right tabular-nums">{s.series.length > 1 ? fmt(s, s.median10y, currency) : "—"}</td>
                      <td className="px-2 py-1.5">{s.series.length > 1 ? <Spark series={s.series} /> : null}</td>
                      <td className={clsx("px-2 py-1.5 text-xs font-medium capitalize", s.trend && TREND[s.trend])}>{s.trend ?? "—"}</td>
                      <td className="px-3 py-1.5 text-right text-xs tabular-nums">{s.sectorMedian != null ? <>{fmt(s, s.sectorMedian, currency)}<span className="ml-1 text-slate-400">p{Math.round(s.percentileInSector ?? 0)}</span></> : "—"}</td>
                    </tr>
                    {open === key && (
                      <tr className="bg-slate-50/60 dark:bg-slate-900/40">
                        <td colSpan={hasTtm ? 7 : 6} className="px-3 py-2">
                          <p className="text-[11px] text-slate-500">formula <code>{s.formulaId}</code>{s.min10y != null && s.series.length > 1 ? ` · range ${fmt(s, s.min10y, currency)} – ${fmt(s, s.max10y, currency)}` : ""}{s.consistency != null ? ` · meets the persona threshold in ${Math.round(s.consistency * 100)}% of years` : ""}</p>
                          <div className="mt-1.5 flex flex-wrap gap-1.5">
                            {s.series.map((p) => (
                              <span key={p.year} title={JSON.stringify(p.inputs)} className="rounded-md border border-slate-200 bg-white px-1.5 py-0.5 text-[11px] tabular-nums dark:border-slate-700 dark:bg-slate-950">
                                FY{p.year}: {p.value == null ? (p.reason ?? "—").replace(/_/g, " ") : fmt(s, p.value, currency)}
                              </span>
                            ))}
                          </div>
                          <p className="mt-1.5 break-words text-[11px] text-slate-500">inputs (latest): {JSON.stringify(s.series.at(-1)?.inputs ?? {})}</p>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </div>
  );
}

export function QualityPanel({ ratios }: { ratios: RatioReport }) {
  const q = ratios.qualityScores;
  const d = q.dupont.filter((r) => r.roe != null).slice(-6);
  const badge = (text: string, tone: "up" | "down" | "amber") => (
    <span className={clsx("ml-1 rounded-md px-1.5 py-0.5 text-[11px] font-semibold", tone === "up" && "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300", tone === "down" && "bg-rose-50 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300", tone === "amber" && "bg-amber-50 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300")}>{text}</span>
  );
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <div className="rounded-xl border border-slate-200 p-4 dark:border-slate-800">
        <p className="text-sm font-semibold">Piotroski F-score: {q.piotroski.score ?? "not available"}{q.piotroski.score != null ? " / 9" : ""}</p>
        <ul className="mt-2 space-y-1">
          {q.piotroski.tests.map((t) => (
            <li key={t.name} className="flex items-center gap-2 text-xs">
              {t.passed === true ? <CheckCircle2 size={13} className="text-emerald-600" /> : t.passed === false ? <XCircle size={13} className="text-rose-500" /> : <CircleDashed size={13} className="text-slate-400" />}
              <span>{t.name}</span><span className="text-slate-400">{t.detail}</span>
            </li>
          ))}
        </ul>
      </div>
      <div className="space-y-3">
        <div className="rounded-xl border border-slate-200 p-4 dark:border-slate-800">
          <p className="text-sm font-semibold">Altman {q.altmanZ.variant}: {q.altmanZ.score != null ? q.altmanZ.score.toFixed(2) : "not available"}{q.altmanZ.zone && badge(q.altmanZ.zone, q.altmanZ.zone === "safe" ? "up" : q.altmanZ.zone === "grey" ? "amber" : "down")}</p>
          <p className="mt-1 text-xs text-slate-500">{q.altmanZ.reason ?? "Above 2.6 safe, 1.1 to 2.6 grey, below 1.1 distress."}</p>
        </div>
        <div className="rounded-xl border border-slate-200 p-4 dark:border-slate-800">
          <p className="text-sm font-semibold">Beneish M-score: {q.beneishM.score != null ? q.beneishM.score.toFixed(2) : "not available"}{q.beneishM.flag != null && badge(q.beneishM.flag ? "flag" : "no flag", q.beneishM.flag ? "down" : "up")}</p>
          <p className="mt-1 text-xs text-slate-500">{q.beneishM.reason ?? "Above -1.78 is associated with earnings manipulation. A flag is a reason to read the accounts, not a finding."}</p>
        </div>
        <div className="overflow-x-auto rounded-xl border border-slate-200 p-4 dark:border-slate-800">
          <p className="text-sm font-semibold">DuPont: ROE = net margin × asset turnover × equity multiplier</p>
          {d.length ? (
            <table className="mt-2 w-full text-xs tabular-nums">
              <thead><tr className="text-left text-slate-500"><th>Year</th><th className="text-right">Margin</th><th className="text-right">Turnover</th><th className="text-right">Multiplier</th><th className="text-right">ROE</th></tr></thead>
              <tbody>{d.map((r) => <tr key={r.year}><td>FY{r.year}</td><td className="text-right">{pct(r.netMargin)}</td><td className="text-right">{times(r.assetTurnover)}</td><td className="text-right">{times(r.equityMultiplier)}</td><td className="text-right font-semibold">{pct(r.roe)}</td></tr>)}</tbody>
            </table>
          ) : <p className="mt-1 text-xs text-slate-500">Not available.</p>}
        </div>
        <div className="rounded-xl border border-slate-200 p-4 dark:border-slate-800">
          <p className="text-sm font-semibold">Category scores (0–100, from config/scoring.yaml)</p>
          <div className="mt-2 grid grid-cols-2 gap-2 text-xs">
            {Object.entries(ratios.categoryScores).map(([k, v]) => <div key={k} className="flex justify-between rounded-md bg-slate-50 px-2 py-1 dark:bg-slate-900"><span className="capitalize">{k.replace(/([A-Z])/g, " $1").toLowerCase()}</span><span className="font-semibold tabular-nums">{v ?? "—"}</span></div>)}
          </div>
        </div>
      </div>
    </div>
  );
}

export function ValuationPanel({ v, persona, currency }: { v: Valuation; persona: Analysis["persona"]; currency: Currency }) {
  const m = v.relativeMultiples;
  const assumption = (k: string, val: number | string | null) => {
    if (typeof val !== "number") return val ?? "—";
    if (/free_cash_flow|net_debt|value_per_share/.test(k)) return /per_share/.test(k) ? money(currency, val) : big(currency, val);
    if (/shares/.test(k)) return val.toLocaleString("en-US", { maximumFractionDigits: 0 });
    if (/growth|rate|roe|equity|capped/.test(k)) return pct(val);
    return val.toLocaleString("en-US", { maximumFractionDigits: 2 });
  };
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        {v.scenarios.map((s) => (
          <div key={s.name} className={clsx("rounded-xl border p-3", s.name === "base" ? "border-indigo-200 bg-indigo-50/50 dark:border-indigo-500/30 dark:bg-indigo-500/10" : "border-slate-200 dark:border-slate-800")}>
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{s.name} case</p>
            <p className="mt-1 text-xl font-semibold tabular-nums">{money(currency, s.intrinsicValuePerShare)}</p>
            <dl className="mt-2 space-y-0.5 text-[11px] text-slate-500">
              {Object.entries(s.assumptions).map(([k, val]) => (
                <div key={k} className="flex justify-between gap-2"><dt>{k.replace(/_/g, " ")}</dt><dd className="text-right tabular-nums text-slate-700 dark:text-slate-300">{assumption(k, val)}</dd></div>
              ))}
            </dl>
          </div>
        ))}
      </div>
      <div className="rounded-xl border border-slate-200 p-3 text-sm dark:border-slate-800">
        Price {money(currency, v.currentPrice)} · margin of safety <strong className="tabular-nums">{pct(v.marginOfSafety)}</strong> against the {pct(persona.requiredMarginOfSafety, 0)} this persona requires
        {v.meetsRequirement != null && <span className={clsx("ml-2 rounded-md px-1.5 py-0.5 text-[11px] font-semibold", v.meetsRequirement ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300" : "bg-amber-50 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300")}>{v.meetsRequirement ? "requirement met" : "requirement not met"}</span>}
        <p className="mt-1 text-xs text-slate-500">Margin of safety = (intrinsic value − price) ÷ intrinsic value. Growth is capped at {pct(persona.dcfGrowthCap, 0)} by the persona. Estimates move with their assumptions; they are not price targets.</p>
        {!!v.assumptionNotes?.length && <ul className="mt-1.5 list-disc space-y-0.5 pl-4 text-xs text-slate-500">{v.assumptionNotes.map((n, i) => <li key={i}>{n}</li>)}</ul>}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm tabular-nums">
          <thead><tr className="text-left text-[11px] uppercase tracking-wide text-slate-500"><th className="py-1">Multiple</th><th className="text-right">Now</th><th className="text-right">Own history (median)</th><th className="text-right">Sector median</th></tr></thead>
          <tbody>
            <tr className="border-t border-slate-100 dark:border-slate-800"><td className="py-1">P/E</td><td className="text-right">{times(m.pe, 1)}</td><td className="text-right">{times(m.peOwnMedian, 1)}</td><td className="text-right">{times(m.peSector, 1)}</td></tr>
            <tr className="border-t border-slate-100 dark:border-slate-800"><td className="py-1">P/B</td><td className="text-right">{times(m.pb, 1)}</td><td className="text-right">—</td><td className="text-right">{times(m.pbSector, 1)}</td></tr>
            <tr className="border-t border-slate-100 dark:border-slate-800"><td className="py-1">EV/EBITDA</td><td className="text-right">{times(m.evEbitda, 1)}</td><td className="text-right">{times(m.evEbitdaReference, 1)}</td><td className="text-right">—</td></tr>
          </tbody>
        </table>
      </div>
      {v.models.length > 0 && <ul className="space-y-1 text-xs text-slate-600 dark:text-slate-300">{v.models.map((mo) => <li key={mo.key}><strong>{mo.label}</strong>: {money(currency, mo.fairValue)} <span className="text-slate-400">({mo.basis})</span></li>)}</ul>}
    </div>
  );
}

export function TechnicalPanel({ t, currency }: { t: Technical; currency: Currency }) {
  const cells: [string, string][] = [
    ["Trend (fixed rules)", t.trendLabel ?? "—"], ["50-day average", money(currency, t.ma50)], ["200-day average", money(currency, t.ma200)],
    ["Price vs 50-day", pct(t.priceVsMa50)], ["Price vs 200-day", pct(t.priceVsMa200)], ["52-week high", money(currency, t.high52w)], ["52-week low", money(currency, t.low52w)],
    ["1-year return", pct(t.returns["1y"])], ["3-year return", pct(t.returns["3y"])], ["5-year return", pct(t.returns["5y"])],
    ["Volatility (annualised)", pct(t.volatility)], ["RSI (14)", t.rsi14 == null ? "—" : t.rsi14.toFixed(0)],
  ];
  return (
    <div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
        {cells.map(([k, v]) => <div key={k} className="rounded-lg border border-slate-200 px-3 py-2 dark:border-slate-800"><p className="text-[11px] text-slate-500">{k}</p><p className="font-semibold capitalize tabular-nums">{v}</p></div>)}
      </div>
      <p className="mt-2 text-[11px] text-slate-500">Split-adjusted daily closes{t.asOf ? ` to ${t.asOf}` : ""}. Uptrend: price above both averages and the 50-day above the 200-day; downtrend: the reverse; otherwise sideways.</p>
    </div>
  );
}

export function QualitativePanel({ q }: { q: Qualitative }) {
  const block = (title: string, items: QItem[]) => (
    <div>
      <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">{title}</h4>
      {items.length ? (
        <ul className="space-y-1.5">
          {items.map((i, n) => (
            <li key={n} className="flex gap-2 text-sm">
              <span className={clsx("mt-1.5 h-2 w-2 shrink-0 rounded-full", i.sentiment === "positive" ? "bg-emerald-500" : i.sentiment === "negative" ? "bg-rose-500" : "bg-slate-400")} aria-label={i.sentiment} />
              <span>{i.summary}{" "}{i.sourceUrl && <a href={i.sourceUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-0.5 text-[11px] text-indigo-700 hover:underline dark:text-indigo-300">{i.sourceLabel.slice(0, 50)}{i.date ? ` · ${i.date}` : ""} <ExternalLink size={10} /></a>}</span>
            </li>
          ))}
        </ul>
      ) : <p className="text-xs text-slate-500">Nothing found in the sources read.</p>}
    </div>
  );
  return (
    <div className="space-y-3">
      <div className="grid gap-5 lg:grid-cols-3">{block("Moat signals", q.moatSignals)}{block("Management signals", q.managementSignals)}{block("Risks", q.risks)}</div>
      {q.unavailable.length > 0 && <p className="text-[11px] text-slate-500">Not read: {q.unavailable.map((u) => u.reason).join("; ")}</p>}
    </div>
  );
}

export function ComparisonTable({ companies }: { companies: Company[] }) {
  const [a, b] = companies;
  if (!a?.ratios || !b?.ratios) return null;
  const keys = ["roe", "roce", "roa", "grossMargin", "operatingMargin", "netMargin", "debtToEquity", "interestCoverage", "currentRatio", "cashConversion", "fcfMargin", "revenueCagr5y", "epsCagr5y", "pe", "pb", "evEbitda", "peg", "dividendYield", "netInterestMargin", "costToIncome"];
  const find = (c: Company, k: string) => (c.ratios ? Object.values(c.ratios.categories).map((cat) => cat[k]).find(Boolean) : undefined);
  const rows = keys.map((k) => [k, find(a, k), find(b, k)] as const).filter(([, s1, s2]) => s1?.latest != null || s2?.latest != null);
  const crossMarket = a.market !== b.market;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm tabular-nums">
        <thead><tr className="text-left text-[11px] uppercase tracking-wide text-slate-500"><th className="py-1">Ratio</th><th className="text-right">{a.company ?? a.symbol} <span className="normal-case text-slate-400">({a.currency})</span></th><th className="text-right">{b.company ?? b.symbol} <span className="normal-case text-slate-400">({b.currency})</span></th></tr></thead>
        <tbody>{rows.map(([k, s1, s2]) => <tr key={k} className="border-t border-slate-100 dark:border-slate-800"><td className="py-1">{(s1 ?? s2)!.label}</td><td className="text-right">{s1 ? fmt(s1, s1.latest, a.currency) : "—"}</td><td className="text-right">{s2 ? fmt(s2, s2.latest, b.currency) : "—"}</td></tr>)}</tbody>
      </table>
      <p className="mt-1 text-[11px] text-slate-500">Ratios are compared, not absolute amounts.{crossMarket ? ` The companies report in ${a.currency} and ${b.currency}; each is set against peers from its own market only.` : ""}</p>
    </div>
  );
}

// --- the tabbed reports ------------------------------------------------------------------------------

const TABS = [
  { key: "overview", label: "Overview", icon: Building2 },
  { key: "ratios", label: "Ratios", icon: Layers },
  { key: "quality", label: "Quality", icon: Gauge },
  { key: "valuation", label: "Valuation", icon: Scale },
  { key: "technical", label: "Technical", icon: LineChart },
  { key: "news", label: "News & moat", icon: Newspaper },
  { key: "checks", label: "Checks", icon: ShieldCheck },
  { key: "trace", label: "Plan & trace", icon: Workflow },
] as const;
export type ReportTab = (typeof TABS)[number]["key"];

export function ReportTabs({ analysis, companyIndex = 0, tab, onTab }: { analysis: Analysis; companyIndex?: number; tab: ReportTab; onTab: (t: ReportTab) => void }) {
  const c = analysis.companies[companyIndex];
  if (!c) return null;
  const final = analysis.final;
  return (
    <div>
      <div role="tablist" aria-label="Agent reports" className="flex gap-0.5 overflow-x-auto border-b border-slate-200 dark:border-slate-800">
        {TABS.map((t) => (
          <button key={t.key} type="button" role="tab" aria-selected={tab === t.key} onClick={() => onTab(t.key)}
            className={clsx("inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap border-b-2 px-2.5 py-2 text-[13px] font-semibold transition",
              tab === t.key ? "border-indigo-600 text-indigo-700 dark:border-indigo-400 dark:text-indigo-300" : "border-transparent text-slate-500 hover:text-slate-900 dark:hover:text-white")}>
            <t.icon size={13} /> {t.label}
          </button>
        ))}
      </div>
      <div className="pt-4" role="tabpanel">
        {tab === "overview" && <OverviewPanel c={c} />}
        {tab === "ratios" && (c.ratios ? <RatioTable ratios={c.ratios} currency={c.currency} /> : <Empty>The ratio engine did not return a report.</Empty>)}
        {tab === "quality" && (c.ratios ? <QualityPanel ratios={c.ratios} /> : <Empty>Not available.</Empty>)}
        {tab === "valuation" && (c.valuation ? <ValuationPanel v={c.valuation} persona={analysis.persona} currency={c.currency} /> : <Empty>The valuation agent was not run for this question.</Empty>)}
        {tab === "technical" && (c.technical ? <TechnicalPanel t={c.technical} currency={c.currency} /> : <Empty>The technical agent was not run for this question.</Empty>)}
        {tab === "news" && (c.qualitative ? <QualitativePanel q={c.qualitative} /> : <Empty>The news and moat agent was not run for this company (it is skipped for the second company of a comparison and for narrow questions, to save model calls).</Empty>)}
        {tab === "checks" && analysis.validation && (
          <div className="space-y-3 text-sm">
            <p className="flex items-center gap-2">{analysis.validation.passed ? <CheckCircle2 size={16} className="text-emerald-600" /> : <XCircle size={16} className="text-rose-600" />}
              {analysis.validation.passed ? "No impossible values found." : "Some values failed validation and were marked unreliable."} {analysis.validation.warnings.length} warning{analysis.validation.warnings.length === 1 ? "" : "s"}.</p>
            <ul className="space-y-1">
              {[...analysis.validation.failedItems, ...analysis.validation.warnings].map((w, i) => <li key={i} className="flex gap-2 text-xs"><AlertTriangle size={13} className="mt-0.5 shrink-0 text-amber-500" /><span><strong>{w.check.replace(/_/g, " ")}</strong>: {w.detail}</span></li>)}
            </ul>
            {!!final?.removed.length && <div><p className="text-xs font-semibold">Removed from the written analysis by the checks</p><ul className="mt-1 list-disc pl-4 text-xs text-slate-500">{final.removed.map((r, i) => <li key={i}>{r}</li>)}</ul></div>}
            {final && <div><p className="text-xs font-semibold">Missing data</p><ul className="mt-1 list-disc pl-4 text-xs text-slate-500">{final.missingData.map((m, i) => <li key={i}>{m}</li>)}</ul></div>}
          </div>
        )}
        {tab === "trace" && (
          <div className="space-y-3 text-sm">
            {analysis.plan && (
              <div>
                <p className="font-semibold">Research plan <span className="ml-1 rounded-md bg-slate-100 px-1.5 py-0.5 text-[11px] font-medium text-slate-600 dark:bg-slate-800 dark:text-slate-300">{analysis.plan.plannedBy === "model" ? "planned by the model" : "default plan"}</span></p>
                <p className="mt-1 text-xs text-slate-500">{analysis.plan.reasoning}</p>
                <pre className="mt-2 overflow-x-auto rounded-lg bg-slate-950 p-3 text-[11px] leading-relaxed text-slate-200">{JSON.stringify({ ticker: c.ticker, tasks: analysis.plan.tasks }, null, 2)}</pre>
              </div>
            )}
            <p className="text-xs text-slate-500">Request {analysis.requestId} · {(analysis.durationMs / 1000).toFixed(1)} s · {analysis.llmCalls} model call{analysis.llmCalls === 1 ? "" : "s"} · {analysis.loops} loop-back{analysis.loops === 1 ? "" : "s"} · <a className="text-indigo-700 hover:underline dark:text-indigo-300" href={`/agents/traces?id=${analysis.requestId}`}>open the full trace</a></p>
            {analysis.errors.length > 0 && <ul className="text-xs text-rose-600">{analysis.errors.map((e, i) => <li key={i}>{e.agent}: {e.message}</li>)}</ul>}
          </div>
        )}
      </div>
    </div>
  );
}
