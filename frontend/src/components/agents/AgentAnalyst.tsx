"use client";

// The analyst agents inside a company dashboard: the same graph and reports as the workspace, with the company
// already in view, and a way through to the full workspace for a longer conversation.
import clsx from "clsx";
import { ArrowUpRight, Loader2, Send, Sparkles } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Card, CardBody, CardHeader } from "@/components/ui";
import { useApi } from "@/lib/api";
import { AnswerCard } from "./AnswerCard";
import { streamAnalysis, type Analysis, type PersonaInfo, type Step } from "./client";
import { ReportTabs, type ReportTab } from "./Reports";
import { AgentTimeline } from "./Timeline";

export function AgentAnalyst({ symbol, company }: { symbol?: string | null; company?: string | null }) {
  const { data: personaData } = useApi<{ personas: PersonaInfo[] }>("/api/v2/agents/personas");
  const personas = personaData?.personas ?? [];
  const [personaId, setPersonaId] = useState("buffett");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [steps, setSteps] = useState<Step[]>([]);
  const [result, setResult] = useState<Analysis | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<ReportTab>("overview");
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);

  const name = company ?? symbol ?? "this company";
  const examples = [`Analyse ${name}`, `Is ${name}'s debt a concern?`, `How consistent is ${name}'s return on equity?`, "What is the margin of safety?"];

  const run = async (text: string) => {
    const q = text.trim();
    if (!q || busy) return;
    abort.current?.abort();
    const ctrl = new AbortController();
    abort.current = ctrl;
    setBusy(true);
    setError(null);
    setResult(null);
    setSteps([]);
    setMessage(q);
    try {
      const r = await streamAnalysis({ message: q, persona: personaId, symbol: symbol ?? null, market: "IN" }, (s) => setSteps((all) => [...all, s]), ctrl.signal);
      setResult(r);
      setSteps(r.steps);
      setTab("overview");
    } catch (e) {
      if ((e as Error).name !== "AbortError") setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader
          title={<span className="inline-flex items-center gap-2"><Sparkles size={18} className="text-indigo-600" /> AI analyst agents</span>}
          subtitle="A persona agent plans the research; specialist agents compute ratios, value the company, read price trends and filings; a validator checks the numbers; the persona writes the analysis."
          actions={<Link href={`/agents${symbol ? `?company=${encodeURIComponent(symbol)}` : ""}`} className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2.5 py-1.5 text-sm font-medium text-slate-700 transition hover:border-indigo-300 hover:text-indigo-700 dark:border-slate-700 dark:text-slate-200">Open the workspace <ArrowUpRight size={14} /></Link>}
        />
        <CardBody className="space-y-3">
          <div className="flex flex-wrap gap-1.5">
            {personas.map((p) => (
              <button key={p.id} type="button" onClick={() => setPersonaId(p.id)} disabled={busy}
                className={clsx("rounded-lg border px-2.5 py-1.5 text-left text-sm transition", personaId === p.id ? "border-indigo-400 bg-indigo-50 font-semibold dark:border-indigo-500/50 dark:bg-indigo-500/10" : "border-slate-200 hover:border-indigo-200 dark:border-slate-700")}>
                {p.name}
              </button>
            ))}
          </div>
          <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); void run(message); }}>
            <input value={message} onChange={(e) => setMessage(e.target.value)} disabled={busy} aria-label="Question for the analyst agents"
              placeholder={`Ask about ${name}, or name any company in India or the US…`}
              className="min-w-0 flex-1 rounded-xl border border-slate-200 bg-white px-3.5 py-2.5 text-sm outline-none focus:border-indigo-400 dark:border-slate-700 dark:bg-slate-950" />
            <button type="submit" disabled={busy || !message.trim()}
              className={clsx("inline-flex items-center gap-1.5 rounded-xl px-4 py-2.5 text-sm font-semibold text-white transition", busy || !message.trim() ? "bg-slate-300 dark:bg-slate-700" : "bg-indigo-600 hover:bg-indigo-700")}>
              {busy ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />} Analyse
            </button>
          </form>
          <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1">
            {examples.map((e) => (
              <button key={e} type="button" onClick={() => run(e)} disabled={busy}
                className="shrink-0 rounded-full border border-slate-200 px-2.5 py-1 text-xs text-slate-600 transition hover:border-indigo-300 hover:text-indigo-700 disabled:opacity-50 dark:border-slate-700 dark:text-slate-300">{e}</button>
            ))}
          </div>
          {(busy || result) && <AgentTimeline steps={steps} finished={!busy} title={busy ? "Agent run (live)" : "Agent run"} />}
          {error && <p role="alert" className="text-sm text-rose-600">{error}</p>}
        </CardBody>
      </Card>

      {result && (
        <Card className="motion-rise">
          <CardBody><AnswerCard a={result} onPick={(q) => run(q)} /></CardBody>
        </Card>
      )}
      {result?.status === "answered" && result.companies[0] && (
        <Card><CardBody><ReportTabs analysis={result} tab={tab} onTab={setTab} /></CardBody></Card>
      )}
    </div>
  );
}
