"use client";

// Observability (spec §7.1 "trace every agent step", §10.3 "every request has a full trace"): recent requests with
// their latency, model calls, loops and validation, and for any one of them every agent's input and output.
import clsx from "clsx";
import { AlertTriangle, CheckCircle2, ChevronDown, Workflow } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { useApi } from "@/lib/api";

interface RequestRow { request_id: string; at: string; persona_id: string; symbol: string | null; intent: string | null; question: string; llm_calls: number; loops: number; passed: number | null; duration_ms: number | null; errors: string | null }
interface Summary { requests: number; avg_ms: number | null; p95_ms: number | null; avg_llm_calls: number | null; with_loops: number; failed_validation: number; with_errors: number }
interface GraphShape { engine: string; nodes: string[]; edges: { source: string; target: string; conditional: boolean }[] }
interface TraceStep { seq: number; at: string; agent: string; stage: string; duration_ms: number | null; input: unknown; output: unknown }

function StepRow({ s }: { s: TraceStep }) {
  const [open, setOpen] = useState(false);
  const tone = s.stage === "error" || s.stage === "contract_failed" ? "text-rose-600" : s.stage === "llm" ? "text-violet-600 dark:text-violet-300" : s.stage === "done" ? "text-emerald-600" : "text-slate-500";
  return (
    <li className="border-t border-slate-100 dark:border-slate-800">
      <button type="button" onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-3 px-3 py-1.5 text-left text-sm hover:bg-slate-50 dark:hover:bg-slate-800/40">
        <span className="w-6 text-right text-xs tabular-nums text-slate-400">{s.seq}</span>
        <span className="w-40 truncate font-medium">{s.agent.replace(/_/g, " ")}</span>
        <span className={clsx("w-28 text-xs font-semibold uppercase", tone)}>{s.stage.replace(/_/g, " ")}</span>
        <span className="text-xs tabular-nums text-slate-500">{s.duration_ms != null ? `${s.duration_ms} ms` : ""}</span>
        <ChevronDown size={13} className={clsx("ml-auto text-slate-400 transition", open ? "" : "-rotate-90")} />
      </button>
      {open && (
        <div className="grid gap-2 px-3 pb-3 lg:grid-cols-2">
          {(["input", "output"] as const).map((k) => (
            <div key={k}>
              <p className="text-[11px] font-semibold uppercase text-slate-500">{k}</p>
              <pre className="mt-1 max-h-80 overflow-auto rounded-lg bg-slate-950 p-2.5 text-[11px] leading-relaxed text-slate-200">{s[k] == null ? "—" : typeof s[k] === "string" ? String(s[k]) : JSON.stringify(s[k], null, 2)}</pre>
            </div>
          ))}
        </div>
      )}
    </li>
  );
}

/** The compiled LangGraph: every node, its outgoing edges (dashed = conditional), and the selected request's path. */
function GraphCard({ graph, path }: { graph: GraphShape; path: string[] }) {
  const visited = new Set(path);
  const order = graph.nodes.filter((n) => n !== "__start__" && n !== "__end__");
  return (
    <div className="mb-4 rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
      <p className="text-sm font-semibold">Agent graph <span className="ml-1 rounded-md bg-violet-50 px-1.5 py-0.5 text-[11px] font-medium text-violet-700 dark:bg-violet-500/15 dark:text-violet-300">{graph.engine}</span></p>
      <p className="mt-0.5 text-xs text-slate-500">{order.length} nodes, {graph.edges.length} edges. Solid arrows always run; dashed ones are decided at run time.{path.length ? " Highlighted: the path this request took." : ""}</p>
      {path.length > 0 && (
        <p className="mt-2 flex flex-wrap items-center gap-1 text-[11px]">
          {path.map((n, i) => (
            <span key={`${i}-${n}`} className="inline-flex items-center gap-1">
              <span className="rounded-md bg-indigo-600 px-1.5 py-0.5 font-medium text-white">{n}</span>
              {i < path.length - 1 && <span className="text-slate-400">→</span>}
            </span>
          ))}
        </p>
      )}
      <div className="mt-3 grid gap-1.5 sm:grid-cols-2 xl:grid-cols-3">
        {order.map((n) => (
          <div key={n} className={clsx("rounded-lg border px-2.5 py-1.5 text-xs", visited.has(n) ? "border-indigo-300 bg-indigo-50 dark:border-indigo-500/40 dark:bg-indigo-500/10" : "border-slate-200 dark:border-slate-700")}>
            <p className="font-semibold">{n}</p>
            <p className="mt-0.5 text-[11px] text-slate-500">
              {graph.edges.filter((e) => e.source === n).map((e, i) => (
                <span key={i} className={clsx("mr-1.5 inline-block", e.conditional && "italic")}>{e.conditional ? "⇢" : "→"} {e.target.replace("__end__", "end")}</span>
              ))}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}

function Traces() {
  const search = useSearchParams();
  const router = useRouter();
  const id = search.get("id");
  const { data } = useApi<{ requests: RequestRow[]; summary: Summary | null }>("/api/v2/agents/requests?limit=100");
  const { data: trace, error } = useApi<{ request: RequestRow; path: string[]; steps: TraceStep[] }>(id ? `/api/v2/agents/trace/${id}` : null);
  const { data: graph } = useApi<GraphShape>("/api/v2/agents/graph");
  const s = data?.summary;

  return (
    <div className="flex h-full">
      <aside className="w-full max-w-md shrink-0 overflow-y-auto border-r border-slate-200 bg-white dark:border-slate-800 dark:bg-[#0e1428]">
        <div className="border-b border-slate-200 p-4 dark:border-slate-800">
          <h1 className="flex items-center gap-2 text-lg font-semibold"><Workflow size={18} className="text-indigo-600" /> Request traces</h1>
          <p className="mt-1 text-xs text-slate-500">Every request, with each agent&apos;s input and output. Questions are stored without personal data.</p>
          {s && (
            <div className="mt-3 grid grid-cols-3 gap-2 text-center">
              {[
                ["Requests (7d)", s.requests],
                ["p95 latency", s.p95_ms != null ? `${(s.p95_ms / 1000).toFixed(1)} s` : "—"],
                ["Avg model calls", s.avg_llm_calls != null ? s.avg_llm_calls.toFixed(1) : "—"],
                ["Loop-backs", s.with_loops],
                ["Failed validation", s.failed_validation],
                ["With errors", s.with_errors],
              ].map(([k, v]) => <div key={k} className="rounded-lg bg-slate-50 px-2 py-1.5 dark:bg-slate-900"><p className="text-[10px] text-slate-500">{k}</p><p className="text-sm font-semibold tabular-nums">{v}</p></div>)}
            </div>
          )}
        </div>
        <ul>
          {(data?.requests ?? []).map((r) => (
            <li key={r.request_id}>
              <button type="button" onClick={() => router.replace(`/agents/traces?id=${r.request_id}`, { scroll: false })}
                className={clsx("w-full border-b border-slate-100 px-4 py-2.5 text-left transition hover:bg-slate-50 dark:border-slate-800 dark:hover:bg-slate-800/50", id === r.request_id && "bg-indigo-50 dark:bg-indigo-500/10")}>
                <span className="block truncate text-sm font-medium">{r.question}</span>
                <span className="mt-0.5 flex items-center gap-2 text-[11px] text-slate-500">
                  {r.passed === 0 || (r.errors && r.errors !== "[]") ? <AlertTriangle size={11} className="text-amber-500" /> : <CheckCircle2 size={11} className="text-emerald-500" />}
                  {r.symbol ?? "—"} · {r.intent ?? "—"} · {r.persona_id} · {r.llm_calls} calls · {r.duration_ms != null ? `${(r.duration_ms / 1000).toFixed(1)} s` : "—"} · {r.at.slice(0, 16).replace("T", " ")}
                </span>
              </button>
            </li>
          ))}
          {data && !data.requests.length && <li className="p-4 text-sm text-slate-500">No requests recorded yet.</li>}
        </ul>
      </aside>
      <section className="min-w-0 flex-1 overflow-y-auto p-4 sm:p-6">
        {graph && <GraphCard graph={graph} path={trace?.path ?? []} />}
        {!id && <p className="mt-4 text-sm text-slate-500">Choose a request to see the path it took through the graph and every agent step.</p>}
        {error && <p className="text-sm text-rose-600">{error}</p>}
        {trace && (
          <div className="rounded-2xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
            <div className="p-4">
              <p className="text-base font-semibold">{trace.request.question}</p>
              <p className="mt-1 text-xs text-slate-500">
                {trace.request.request_id} · {trace.request.persona_id} · {trace.request.symbol ?? "no company"} · {trace.request.intent} · {trace.request.llm_calls} model calls · {trace.request.loops} loop-backs · {trace.request.duration_ms != null ? `${(trace.request.duration_ms / 1000).toFixed(1)} s` : ""}
              </p>
            </div>
            <ul>{trace.steps.map((st) => <StepRow key={st.seq} s={st} />)}</ul>
          </div>
        )}
      </section>
    </div>
  );
}

export default function Page() {
  return <Suspense fallback={null}><Traces /></Suspense>;
}
