"use client";

// The agent run, phase by phase (in the manner of a research-agent run view): all eleven agents in order, each with
// its role, status, time and model calls, and - as soon as it finishes - what it was given and what it produced:
// the plan, the data fetched, every ratio, the valuation and its assumptions, the signals and their sources, the
// checks and the written answer. Every card minimizes and maximizes; so does the whole run.
import clsx from "clsx";
import {
  BookOpen, CheckCircle2, ChevronDown, CircleDashed, FileText, Layers, LineChart, Loader2, Maximize2, Minimize2, Newspaper, Swords,
  Scale, Search, ShieldCheck, Sparkles, Workflow, X, XCircle,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import type { Step, StepDetail } from "./client";

export const AGENTS: { key: string; label: string; role: string; icon: typeof Search; llm: string }[] = [
  { key: "input_layer", label: "Input layer", role: "Finds the company in India or the US, reads the intent, applies the guardrails", icon: Search, llm: "small model only if no name is found" },
  { key: "orchestrator", label: "Persona orchestrator", role: "Turns the question into a research plan for the workers; takes loop-back requests", icon: Workflow, llm: "strong model" },
  { key: "data_agent", label: "Data agent", role: "Fetches ten years of statements, quarters, prices, filings and peers - once", icon: BookOpen, llm: "code" },
  { key: "ratio_engine", label: "Ratio engine", role: "40+ ratios in 8 categories, trends, sector comparison, quality scores", icon: Layers, llm: "code" },
  { key: "valuation_agent", label: "Valuation agent", role: "DCF bear/base/bull, multiples against history and sector, margin of safety", icon: Scale, llm: "small model suggests, code calculates" },
  { key: "technical_agent", label: "Technical agent", role: "Moving averages, 52-week range, returns, volatility, RSI, trend label", icon: LineChart, llm: "code" },
  { key: "news_moat_agent", label: "News and moat agent", role: "Reads filings for moat, management and risk signals, each with its source", icon: Newspaper, llm: "small model" },
  { key: "validator", label: "Validator agent", role: "Rule checks on every report; impossible values go back to their worker", icon: ShieldCheck, llm: "code" },
  { key: "debate_agent", label: "Bull and bear debate", role: "Two analysts argue the case for and the case against from the same figures", icon: Swords, llm: "small model, twice" },
  { key: "synthesis", label: "Persona synthesis", role: "Weights the reports by the persona and writes the analysis; checks every number", icon: Sparkles, llm: "strong model" },
  { key: "response_layer", label: "Response layer", role: "Formats the answer, attaches sources and the disclaimer", icon: FileText, llm: "code" },
];

type Status = "waiting" | "running" | "done" | "failed" | "skipped";

function statusOf(steps: Step[], agent: string, finished: boolean): { status: Status; ms: number; runs: number; llm: number } {
  const mine = steps.filter((s) => s.agent === agent || (agent === "orchestrator" && s.agent === "loop_back"));
  const starts = mine.filter((s) => s.stage === "start").length;
  const dones = mine.filter((s) => s.stage === "done").length;
  const failed = mine.some((s) => s.stage === "error" || s.stage === "contract_failed");
  const ms = mine.filter((s) => s.stage === "done").reduce((t, s) => t + (s.durationMs ?? 0), 0);
  const llm = mine.filter((s) => s.stage === "llm").length;
  let status: Status = "waiting";
  if (starts > dones) status = finished ? "failed" : "running";
  else if (dones > 0) status = failed ? "failed" : "done";
  else if (failed) status = "failed";
  else if (finished) status = "skipped";
  return { status, ms, runs: Math.max(starts, dones), llm };
}

function DetailView({ d, large }: { d: StepDetail; large: boolean }) {
  return (
    <div className="space-y-3">
      <p className={clsx("font-medium text-slate-800 dark:text-slate-100", large ? "text-base" : "text-sm")}>{d.headline}</p>
      {!!d.items?.length && (
        <dl className={clsx("grid gap-x-4 gap-y-1.5", large ? "sm:grid-cols-2 xl:grid-cols-3" : "sm:grid-cols-2")}>
          {d.items.map((it, i) => (
            <div key={i} className={clsx("min-w-0 rounded-lg bg-slate-50 px-2.5 py-1.5 dark:bg-slate-900/70", it.value.length > 90 && "col-span-full")}>
              <dt className="text-[10.5px] font-semibold uppercase tracking-wide text-slate-500">{it.label}</dt>
              <dd className="break-words text-[13px] text-slate-800 dark:text-slate-200">{it.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {d.tables?.map((t, i) => (
        <div key={i}>
          <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">{t.title}</p>
          <div className={clsx("overflow-auto rounded-lg border border-slate-200 dark:border-slate-800", !large && "max-h-80")}>
            <table className="w-full min-w-[520px] text-[12.5px]">
              <thead className="sticky top-0 bg-slate-50 dark:bg-slate-900">
                <tr>{t.columns.map((c) => <th key={c} className="px-2.5 py-1.5 text-left text-[10.5px] font-semibold uppercase tracking-wide text-slate-500">{c}</th>)}</tr>
              </thead>
              <tbody>
                {t.rows.map((r, j) => (
                  <tr key={j} className="border-t border-slate-100 dark:border-slate-800/70">
                    {r.map((cell, k) => <td key={k} className={clsx("px-2.5 py-1 align-top", k === 0 ? "font-medium" : "tabular-nums text-slate-700 dark:text-slate-300")}>{cell}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}
      {d.lists?.filter((l) => l.rows.length).map((l, i) => (
        <div key={i}>
          <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">{l.title} ({l.rows.length})</p>
          <ul className={clsx("space-y-1 overflow-auto pr-1", !large && "max-h-64")}>
            {l.rows.map((row, j) => <li key={j} className="flex gap-2 text-[13px] text-slate-700 dark:text-slate-300"><span className="mt-2 h-1 w-1 shrink-0 rounded-full bg-slate-400" />{row}</li>)}
          </ul>
        </div>
      ))}
    </div>
  );
}

/** Everything one agent reported during the run: each completed pass (one per company), model calls, loops, errors. */
function AgentBody({ steps, agent, large }: { steps: Step[]; agent: string; large: boolean }) {
  const mine = steps.filter((s) => (s.agent === agent || (agent === "orchestrator" && s.agent === "loop_back")) && s.detail);
  if (!mine.length) return <p className="text-sm text-slate-500">No output yet.</p>;
  const main = mine.filter((s) => s.stage === "done" || s.stage === "error" || s.stage === "contract_failed");
  const side = mine.filter((s) => s.stage !== "done" && s.stage !== "error" && s.stage !== "contract_failed");
  return (
    <div className="space-y-4">
      {main.map((s, i) => (
        <div key={i} className={clsx(main.length > 1 && "rounded-xl border border-slate-200 p-3 dark:border-slate-800")}>
          {main.length > 1 && <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-indigo-600 dark:text-indigo-300">Pass {i + 1}</p>}
          <DetailView d={s.detail!} large={large} />
        </div>
      ))}
      {side.length > 0 && (
        <div className="rounded-lg bg-violet-50/60 px-3 py-2 dark:bg-violet-500/10">
          <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-violet-700 dark:text-violet-300">Model calls and decisions</p>
          <ul className="space-y-1">
            {side.map((s, i) => (
              <li key={i} className="text-[12.5px] text-slate-700 dark:text-slate-300">
                {s.detail!.headline}{s.detail!.items?.length ? ` · ${s.detail!.items.map((it) => `${it.label}: ${it.value}`).join(" · ")}` : ""}{s.durationMs != null ? ` · ${(s.durationMs / 1000).toFixed(1)} s` : ""}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export function Overlay({ title, onClose, children }: { title: ReactNode; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-[70] flex flex-col bg-slate-100/95 backdrop-blur dark:bg-[#0b1020]/95" role="dialog" aria-modal="true">
      <div className="flex items-center gap-2 border-b border-slate-200 bg-white px-4 py-2.5 dark:border-slate-800 dark:bg-[#0e1428]">
        <div className="min-w-0 flex-1 truncate text-sm font-semibold">{title}</div>
        <button type="button" onClick={onClose} className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2.5 py-1 text-xs font-medium hover:border-indigo-300 dark:border-slate-700">
          <Minimize2 size={13} /> Restore
        </button>
        <button type="button" onClick={onClose} aria-label="Close" className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"><X size={16} /></button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">{children}</div>
    </div>
  );
}

function AgentCard({ steps, agent, index, finished, open, onToggle, onMaximize, large }: {
  steps: Step[]; agent: (typeof AGENTS)[number]; index: number; finished: boolean; open: boolean; onToggle: () => void; onMaximize: () => void; large?: boolean;
}) {
  const st = statusOf(steps, agent.key, finished);
  const Icon = st.status === "done" ? CheckCircle2 : st.status === "failed" ? XCircle : st.status === "running" ? Loader2 : st.status === "skipped" ? CircleDashed : agent.icon;
  const headline = [...steps].reverse().find((s) => s.agent === agent.key && s.stage === "done" && s.detail)?.detail?.headline;
  return (
    <li className={clsx("relative rounded-xl border bg-white transition dark:bg-slate-900",
      st.status === "running" ? "border-indigo-400 shadow-md shadow-indigo-500/10 dark:border-indigo-400/60"
        : st.status === "failed" ? "border-rose-300 dark:border-rose-500/40"
          : st.status === "skipped" ? "border-slate-200 opacity-60 dark:border-slate-800" : "border-slate-200 dark:border-slate-800")}>
      <div className="flex items-start gap-3 px-3 py-2.5">
        <span className={clsx("mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold",
          st.status === "done" ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300"
            : st.status === "running" ? "bg-indigo-100 text-indigo-700 dark:bg-indigo-500/20 dark:text-indigo-300"
              : st.status === "failed" ? "bg-rose-100 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300" : "bg-slate-100 text-slate-500 dark:bg-slate-800")}>
          {index + 1}
        </span>
        <button type="button" onClick={onToggle} className="min-w-0 flex-1 text-left" aria-expanded={open}>
          <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <Icon size={14} className={clsx(st.status === "running" && "animate-spin text-indigo-600", st.status === "done" && "text-emerald-600", st.status === "failed" && "text-rose-600", (st.status === "waiting" || st.status === "skipped") && "text-slate-400")} />
            <span className="text-sm font-semibold">{agent.label}</span>
            <span className={clsx("rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase",
              st.status === "done" ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300"
                : st.status === "running" ? "bg-indigo-50 text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300"
                  : st.status === "failed" ? "bg-rose-50 text-rose-700 dark:bg-rose-500/10 dark:text-rose-300" : "bg-slate-100 text-slate-500 dark:bg-slate-800")}>
              {st.status === "skipped" ? "not needed" : st.status}
            </span>
            {st.status !== "waiting" && st.status !== "skipped" && (
              <span className="text-[11px] tabular-nums text-slate-500">
                {st.ms ? `${st.ms < 1000 ? `${st.ms} ms` : `${(st.ms / 1000).toFixed(1)} s`}` : ""}{st.runs > 1 ? ` · ${st.runs} passes` : ""}{st.llm ? ` · ${st.llm} model call${st.llm > 1 ? "s" : ""}` : ""}
              </span>
            )}
          </span>
          <span className="mt-0.5 block text-[12px] text-slate-500">{agent.role} <span className="text-slate-400">({agent.llm})</span></span>
          {headline && !open && <span className="mt-1 block truncate text-[12.5px] text-slate-700 dark:text-slate-300">{headline}</span>}
        </button>
        <div className="flex shrink-0 items-center gap-0.5">
          <button type="button" onClick={onMaximize} aria-label={`Maximize ${agent.label}`} title="Maximize" className="rounded-md p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800"><Maximize2 size={14} /></button>
          <button type="button" onClick={onToggle} aria-label={open ? `Minimize ${agent.label}` : `Expand ${agent.label}`} title={open ? "Minimize" : "Expand"} className="rounded-md p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800">
            <ChevronDown size={15} className={clsx("transition", open ? "rotate-180" : "")} />
          </button>
        </div>
      </div>
      {open && (
        <div className="border-t border-slate-100 px-3 pb-3 pt-3 sm:pl-[3.25rem] dark:border-slate-800">
          {st.status === "running" && !steps.some((s) => s.agent === agent.key && s.detail) ? (
            <p className="flex items-center gap-2 text-sm text-slate-500"><Loader2 size={14} className="animate-spin" /> Working…</p>
          ) : st.status === "waiting" ? (
            <p className="text-sm text-slate-500">Waiting for the agents before it.</p>
          ) : st.status === "skipped" ? (
            <p className="text-sm text-slate-500">Not needed for this question.</p>
          ) : (
            <AgentBody steps={steps} agent={agent.key} large={Boolean(large)} />
          )}
        </div>
      )}
    </li>
  );
}

/** The eleven agents of one run. `defaultOpen` controls whether finished phases start expanded. */
export function AgentTimeline({ steps, finished, title }: { steps: Step[]; finished: boolean; title?: string }) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [minimized, setMinimized] = useState(false);
  const [maxAll, setMaxAll] = useState(false);
  const [maxOne, setMaxOne] = useState<string | null>(null);
  const done = AGENTS.filter((a) => statusOf(steps, a.key, finished).status === "done").length;
  const running = AGENTS.find((a) => statusOf(steps, a.key, finished).status === "running");
  // A phase is open when the reader opened it, or - by default - while it runs and once it has something to show.
  const isOpen = (key: string) => open[key] ?? (statusOf(steps, key, finished).status === "running" || statusOf(steps, key, finished).status === "done" || statusOf(steps, key, finished).status === "failed");
  const setAll = (value: boolean) => setOpen(Object.fromEntries(AGENTS.map((a) => [a.key, value])));
  const llm = steps.filter((s) => s.stage === "llm").length;
  const loops = steps.filter((s) => s.stage === "loop").length;

  const header = (
    <div className="flex flex-wrap items-center gap-2">
      <span className="inline-flex items-center gap-1.5 text-sm font-semibold">
        {finished ? <CheckCircle2 size={15} className="text-emerald-600" /> : <Loader2 size={15} className="animate-spin text-indigo-600" />}
        {title ?? "Agent run"} · {done} of {AGENTS.length} phases{running && !finished ? ` · ${running.label} working` : ""}
      </span>
      <span className="text-[11px] text-slate-500">LangGraph · {llm} of 12 model calls · {loops} of 2 loop-backs</span>
      <span className="ml-auto flex items-center gap-1">
        {!minimized && (
          <>
            <button type="button" onClick={() => setAll(true)} className="rounded-md border border-slate-200 px-2 py-0.5 text-[11px] font-medium text-slate-600 hover:border-indigo-300 dark:border-slate-700 dark:text-slate-300">Expand all</button>
            <button type="button" onClick={() => setAll(false)} className="rounded-md border border-slate-200 px-2 py-0.5 text-[11px] font-medium text-slate-600 hover:border-indigo-300 dark:border-slate-700 dark:text-slate-300">Collapse all</button>
          </>
        )}
        <button type="button" onClick={() => setMaxAll(true)} title="Maximize the run" aria-label="Maximize the agent run" className="rounded-md p-1 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"><Maximize2 size={14} /></button>
        <button type="button" onClick={() => setMinimized((m) => !m)} title={minimized ? "Show the agents" : "Minimize the run"} aria-label={minimized ? "Show the agent run" : "Minimize the agent run"} className="rounded-md p-1 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800">
          {minimized ? <ChevronDown size={15} /> : <Minimize2 size={14} />}
        </button>
      </span>
    </div>
  );

  const list = (large: boolean) => (
    <ol className="space-y-2">
      {AGENTS.map((a, i) => (
        <AgentCard key={a.key} steps={steps} agent={a} index={i} finished={finished} open={large ? (open[a.key] ?? true) : isOpen(a.key)} large={large}
          onToggle={() => setOpen((o) => ({ ...o, [a.key]: !(large ? (o[a.key] ?? true) : isOpen(a.key)) }))} onMaximize={() => setMaxOne(a.key)} />
      ))}
    </ol>
  );

  const one = AGENTS.find((a) => a.key === maxOne);
  return (
    <div className="rounded-2xl border border-slate-200 bg-slate-50/70 p-3 dark:border-slate-800 dark:bg-slate-950/40">
      {header}
      {minimized ? (
        <div className="mt-2 flex flex-wrap gap-1">
          {AGENTS.map((a) => {
            const st = statusOf(steps, a.key, finished).status;
            return <span key={a.key} className={clsx("rounded-full px-2 py-0.5 text-[10.5px] font-medium", st === "done" ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300" : st === "running" ? "bg-indigo-100 text-indigo-700 dark:bg-indigo-500/20" : st === "failed" ? "bg-rose-100 text-rose-700" : "bg-slate-200/70 text-slate-500 dark:bg-slate-800")}>{a.label}</span>;
          })}
        </div>
      ) : <div className="mt-3">{list(false)}</div>}
      {maxAll && <Overlay title={<>{title ?? "Agent run"} · all phases</>} onClose={() => setMaxAll(false)}><div className="mx-auto max-w-6xl">{list(true)}</div></Overlay>}
      {one && (
        <Overlay title={<>{one.label} · {one.role}</>} onClose={() => setMaxOne(null)}>
          <div className="mx-auto max-w-6xl rounded-2xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900">
            <AgentBody steps={steps} agent={one.key} large />
          </div>
        </Overlay>
      )}
    </div>
  );
}
