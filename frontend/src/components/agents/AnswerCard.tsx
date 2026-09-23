"use client";

// One analysis as the reader sees it in the chat (spec §3.10): summary, score cards, strengths, concerns, key
// numbers with sources, what was missing, and the disclaimer - plus the states that are not an analysis.
import clsx from "clsx";
import { AlertTriangle, ChevronDown, ExternalLink, Layers } from "lucide-react";
import { useState } from "react";
import { AiDisclosure } from "@/components/Disclosure";
import { marketLabel, money, type Analysis } from "./client";
import { ComparisonTable, ScoreCard } from "./Reports";

/** The question again, with the ambiguous name replaced by the listing chosen (INFY.NS, INFY.US). */
function pickQuestion(a: Analysis, symbol: string, market: "IN" | "US") {
  const marker = `${symbol}.${market === "IN" ? "NS" : "US"}`;
  const name = a.message?.match(/"([^"]+)"/)?.[1];
  if (name) {
    const re = new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    if (re.test(a.question)) return a.question.replace(re, marker);
  }
  return `${a.question} (${marker})`;
}

/** The long-form analysis, one collapsible section per theme. */
function Sections({ sections }: { sections: { title: string; body: string }[] }) {
  const [closed, setClosed] = useState<Record<number, boolean>>({});
  if (!sections.length) return null;
  const setAll = (value: boolean) => setClosed(Object.fromEntries(sections.map((_, i) => [i, value])));
  return (
    <div>
      <div className="mb-2 flex items-center gap-2">
        <h3 className="text-sm font-semibold">Full analysis</h3>
        <span className="text-[11px] text-slate-500">{sections.length} sections</span>
        <span className="ml-auto flex gap-1">
          <button type="button" onClick={() => setAll(false)} className="rounded-md border border-slate-200 px-2 py-0.5 text-[11px] font-medium text-slate-600 hover:border-indigo-300 dark:border-slate-700 dark:text-slate-300">Expand all</button>
          <button type="button" onClick={() => setAll(true)} className="rounded-md border border-slate-200 px-2 py-0.5 text-[11px] font-medium text-slate-600 hover:border-indigo-300 dark:border-slate-700 dark:text-slate-300">Collapse all</button>
        </span>
      </div>
      <div className="space-y-2">
        {sections.map((sec, i) => (
          <div key={i} className="rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
            <button type="button" onClick={() => setClosed((c) => ({ ...c, [i]: !c[i] }))} aria-expanded={!closed[i]}
              className="flex w-full items-center gap-2 px-3.5 py-2.5 text-left">
              <span className="text-[13px] font-semibold text-slate-800 dark:text-slate-100">{sec.title}</span>
              <ChevronDown size={15} className={clsx("ml-auto text-slate-400 transition", closed[i] ? "" : "rotate-180")} />
            </button>
            {!closed[i] && <p className="border-t border-slate-100 px-3.5 py-3 text-[14px] leading-relaxed text-slate-700 dark:border-slate-800 dark:text-slate-300">{sec.body}</p>}
          </div>
        ))}
      </div>
    </div>
  );
}

export function AnswerCard({ a, onPick, onReports }: { a: Analysis; onPick: (question: string) => void; onReports?: () => void }) {
  const final = a.final;
  const primary = a.companies[0];

  if (a.status !== "answered" || !final || !primary) {
    return (
      <div className="space-y-3">
        {(a.status === "blocked" || a.status === "no_data" || (a.status === "answered" && !final)) && (
          <p className="flex gap-2 text-sm"><AlertTriangle size={16} className="mt-0.5 shrink-0 text-amber-500" />{a.message ?? "The analysis could not be completed."}</p>
        )}
        {a.status === "ambiguous" && (
          <>
            <p className="text-sm font-medium">{a.message}</p>
            <div className="grid gap-2 sm:grid-cols-2">
              {a.options.map((o) => (
                <button key={`${o.market}-${o.symbol}`} type="button" onClick={() => onPick(pickQuestion(a, o.symbol, o.market))}
                  className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-left transition hover:border-indigo-300 dark:border-slate-700 dark:bg-slate-900">
                  <span className="block text-sm font-semibold">{o.company}</span>
                  <span className="text-xs text-slate-500">{o.symbol} · {o.market === "US" ? "US-listed" : "NSE / BSE"}{o.industry ? ` · ${o.industry}` : ""}</span>
                </button>
              ))}
            </div>
          </>
        )}
        {a.status === "concept" && a.concept && (
          <>
            {a.concept.concept && <p className="text-sm font-semibold">{a.concept.concept.name} <span className="font-normal text-slate-500">= {a.concept.concept.formula}</span></p>}
            <p className="text-sm leading-relaxed text-slate-700 dark:text-slate-300">{a.concept.text}</p>
            <AiDisclosure kind={a.concept.writtenBy === "model" ? "ai" : "computed"} />
          </>
        )}
        <p className="text-xs text-slate-500">{a.disclaimer}</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {a.companies.map((c) => (
          <span key={c.symbol} className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-2.5 py-1 text-xs dark:border-slate-700 dark:bg-slate-900">
            <span className="font-semibold">{c.company ?? c.symbol}</span>
            <span className="text-slate-500">{marketLabel(c)}</span>
            {c.quote?.lastPrice != null && <span className="tabular-nums text-slate-600 dark:text-slate-300">{money(c.currency, c.quote.lastPrice)}</span>}
          </span>
        ))}
        <span className={clsx("rounded-full px-2 py-0.5 text-[11px] font-medium", final.writtenBy === "model" ? "bg-violet-50 text-violet-700 dark:bg-violet-500/15 dark:text-violet-300" : "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300")}>
          {final.writtenBy === "model" ? "written by the model from the reports" : "written from the data"}
        </span>
      </div>

      {a.message && <p className="rounded-lg bg-sky-50 px-3 py-2 text-xs text-sky-800 dark:bg-sky-500/10 dark:text-sky-200">{a.message}</p>}
      <p className="text-[15px] leading-relaxed text-slate-800 dark:text-slate-100">{final.summary}</p>
      {final.note && <p className="text-xs text-amber-700 dark:text-amber-300">{final.note}</p>}

      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-xl border border-indigo-200 bg-gradient-to-r from-indigo-50 to-white px-4 py-3 dark:border-indigo-500/30 dark:from-indigo-500/15 dark:to-slate-900">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-indigo-700 dark:text-indigo-300">Persona fit</span>
          <span className="text-3xl font-semibold tabular-nums">{final.personaFit ?? "—"}<span className="text-xs font-normal text-slate-400">{final.personaFit != null ? " / 100" : ""}</span></span>
          <div className="h-2 min-w-[8rem] flex-1 overflow-hidden rounded-full bg-indigo-100 dark:bg-slate-800"><div className="h-full rounded-full bg-indigo-500" style={{ width: `${final.personaFit ?? 0}%` }} /></div>
          <span className="basis-full text-[11px] leading-snug text-slate-500">The four scores below weighted by the {a.persona.name} profile: how closely the figures match {a.persona.inspiredBy}-inspired principles. Not a rating or a recommendation.</span>
        </div>
        <div className="grid grid-cols-2 gap-2 2xl:grid-cols-4">
          <ScoreCard label="Fundamental" value={final.categoryScores.fundamental} weight={a.persona.weights.fundamental} hint="Returns, margins, growth, balance sheet" />
          <ScoreCard label="Valuation" value={final.categoryScores.valuation} weight={a.persona.weights.valuation} hint="Multiples and margin of safety" />
          <ScoreCard label="Technical" value={final.categoryScores.technical} weight={a.persona.weights.technical} hint="Trend, 1-year return, RSI" />
          <ScoreCard label="Qualitative" value={final.categoryScores.qualitative} weight={a.persona.weights.qualitative} hint="Sourced moat, management, risk signals" />
        </div>
      </div>

      {/* A comparison gives each company its own scores: one number for two companies says nothing about either. */}
      {(final.companies?.length ?? 0) > 1 && (
        <div className="grid gap-3 lg:grid-cols-2">
          {final.companies!.map((c) => (
            <div key={c.symbol} className="rounded-xl border border-slate-200 p-3 dark:border-slate-800">
              <p className="flex items-baseline gap-2 text-sm font-semibold">
                {c.company}
                <span className="text-xs font-normal text-slate-500">persona fit {c.personaFit ?? "—"}{c.personaFit != null ? " / 100" : ""}</span>
              </p>
              <div className="mt-2 grid grid-cols-2 gap-2">
                <ScoreCard label="Fundamental" value={c.categoryScores.fundamental} weight={a.persona.weights.fundamental} hint="Returns, margins, growth, balance sheet" />
                <ScoreCard label="Valuation" value={c.categoryScores.valuation} weight={a.persona.weights.valuation} hint="Multiples and margin of safety" />
                <ScoreCard label="Technical" value={c.categoryScores.technical} weight={a.persona.weights.technical} hint="Trend, 1-year return, RSI" />
                <ScoreCard label="Qualitative" value={c.categoryScores.qualitative} weight={a.persona.weights.qualitative} hint="Sourced moat, management, risk signals" />
              </div>
              {c.keyNumbers.length > 0 && (
                <table className="mt-2 w-full text-sm">
                  <tbody>
                    {c.keyNumbers.map((k, i) => (
                      <tr key={`${c.symbol}-${i}`} className="border-t border-slate-100 dark:border-slate-800/60">
                        <td className="py-1 pr-2">{k.label}</td>
                        <td className="py-1 text-right font-semibold tabular-nums">{k.value}</td>
                        <td className="py-1 pl-2 text-[11px] text-slate-500">
                          {k.source}
                          {k.url && <a href={k.url} target="_blank" rel="noopener noreferrer" className="ml-1 text-indigo-700 hover:underline dark:text-indigo-300">open</a>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          ))}
        </div>
      )}

      {/* What the code worked out about the two companies, before any of it was written up. */}
      {(final.comparison?.length ?? 0) > 0 && (
        <details className="rounded-xl border border-slate-200 p-3 dark:border-slate-800">
          <summary className="cursor-pointer text-sm font-semibold">Where each company is stronger, measure by measure ({final.comparison!.length})</summary>
          <ul className="mt-2 space-y-1">{final.comparison!.map((line, i) => <li key={i} className="text-sm text-slate-700 dark:text-slate-300">• {line}</li>)}</ul>
        </details>
      )}

      <div className="grid gap-3 lg:grid-cols-2">
        <div className="rounded-xl border border-emerald-200 bg-emerald-50/30 p-3.5 dark:border-emerald-500/25 dark:bg-emerald-500/5">
          <h3 className="text-sm font-semibold text-emerald-700 dark:text-emerald-300">Strengths</h3>
          <ul className="mt-1.5 space-y-1">{final.strengths.map((s, i) => <li key={i} className="text-sm text-slate-700 dark:text-slate-300">• {s}</li>)}</ul>
          {!final.strengths.length && <p className="mt-1.5 text-sm text-slate-500">None stood out in the figures on record.</p>}
        </div>
        <div className="rounded-xl border border-rose-200 bg-rose-50/30 p-3.5 dark:border-rose-500/25 dark:bg-rose-500/5">
          <h3 className="text-sm font-semibold text-rose-700 dark:text-rose-300">Concerns</h3>
          <ul className="mt-1.5 space-y-1">{final.concerns.map((s, i) => <li key={i} className="text-sm text-slate-700 dark:text-slate-300">• {s}</li>)}</ul>
          {!final.concerns.length && <p className="mt-1.5 text-sm text-slate-500">None stood out in the figures on record.</p>}
        </div>
      </div>

      <Sections sections={final.sections ?? []} />

      {final.keyNumbers.length > 0 && !(final.companies?.length ?? 0) && (
        <div className="overflow-x-auto rounded-xl border border-slate-200 dark:border-slate-800">
          <table className="w-full text-sm">
            <thead><tr className="bg-slate-50 text-left text-[11px] uppercase tracking-wide text-slate-500 dark:bg-slate-900/60"><th className="px-3 py-1.5 font-medium">Key ratio</th><th className="px-2 py-1.5 text-right font-medium">Value</th><th className="px-3 py-1.5 font-medium">Source and calculation</th></tr></thead>
            <tbody>
              {final.keyNumbers.map((k, i) => (
                <tr key={`${i}-${k.label}`} className="border-t border-slate-100 dark:border-slate-800/60">
                  <td className="px-3 py-1.5">{k.label}</td>
                  <td className="px-2 py-1.5 text-right font-semibold tabular-nums">{k.value}</td>
                  <td className="px-3 py-1.5 text-xs text-slate-500">{k.source}{k.url && <a href={k.url} target="_blank" rel="noopener noreferrer" className="ml-1 inline-flex items-center gap-0.5 text-indigo-700 hover:underline dark:text-indigo-300">{/^.*\bfiling\b[^a-z]*$/i.test(k.source) ? "open" : "filing"} <ExternalLink size={10} /></a>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {a.companies.length > 1 && <div><h3 className="mb-1.5 text-sm font-semibold">Side by side</h3><ComparisonTable companies={a.companies} /></div>}

      <div className="flex flex-wrap items-center gap-2">
        {onReports && (
          <button type="button" onClick={onReports} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-700 transition hover:border-indigo-300 hover:text-indigo-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200">
            <Layers size={13} /> Open all reports
          </button>
        )}
        <span className="text-[11px] text-slate-400">{(a.durationMs / 1000).toFixed(1)} s · {a.llmCalls} model calls · {a.loops} loop-backs · {a.validation?.warnings.length ?? 0} validator warnings</span>
      </div>

      {final.missingData.length > 0 && (
        <details className="rounded-xl bg-slate-50 px-3 py-2 text-xs text-slate-600 dark:bg-slate-900/60 dark:text-slate-400">
          <summary className="cursor-pointer font-semibold">What could not be analysed ({final.missingData.length})</summary>
          <ul className="mt-1.5 list-disc space-y-0.5 pl-4">{final.missingData.map((m, i) => <li key={i}>{m}</li>)}</ul>
        </details>
      )}
      <AiDisclosure kind={final.writtenBy === "model" ? "ai" : "computed"} />
      <p className="text-xs font-medium text-slate-600 dark:text-slate-400">{final.disclaimer}</p>
    </div>
  );
}
