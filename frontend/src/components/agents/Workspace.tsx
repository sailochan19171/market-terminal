"use client";

// The analyst workspace: a chat with a persona-led team of agents (spec §1: "a chat-based stock research system").
//
// Left, the conversations and the personas. Centre, the thread: each question shows the agent graph working live,
// then the written analysis. Right, every report behind the selected answer. Follow-up questions carry the company
// forward, so "and its debt?" needs no name. Conversations are kept in this browser; each answer is stored on the
// server under its request id, so reopening one shows exactly what was shown before.
import clsx from "clsx";
import { ChevronDown, Loader2, Maximize2, MessageSquarePlus, Minimize2, PanelRightClose, PanelRightOpen, Send, Sparkles, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useApi } from "@/lib/api";
import { AnswerCard } from "./AnswerCard";
import { followUps, marketLabel, streamAnalysis, type Analysis, type Market, type PersonaInfo, type Step } from "./client";
import { AgentGraph, ReportTabs, type ReportTab } from "./Reports";
import { AgentTimeline, Overlay } from "./Timeline";

interface Turn { id: string; seq: number; question: string; personaId: string; steps: Step[]; result: Analysis | null; error: string | null; busy: boolean }
interface Conversation { id: string; title: string; personaId: string; updatedAt: string; requests: { requestId: string; question: string }[] }

const STORE = "mt-agent-conversations";
const uid = () => Math.random().toString(36).slice(2, 10);
const readStore = (): Conversation[] => {
  try { return JSON.parse(localStorage.getItem(STORE) ?? "[]") as Conversation[]; } catch { return []; }
};
const writeStore = (list: Conversation[]) => {
  try { localStorage.setItem(STORE, JSON.stringify(list.slice(0, 40))); } catch { /* storage blocked */ }
};

const EXAMPLES: { q: string; tag: string }[] = [
  { q: "Should I look at Apple as a long-term investment?", tag: "US · full analysis" },
  { q: "Is Kotak Mahindra Bank's debt a concern?", tag: "India · bank · single metric" },
  { q: "Analyse Infosys", tag: "listed in both markets" },
  { q: "Compare TCS vs Accenture", tag: "cross-market comparison" },
  { q: "How consistent is Asian Paints' return on equity?", tag: "India · single metric" },
  { q: "What is the PEG ratio and why does it matter?", tag: "explain a concept" },
];

export function Workspace({ initialQuestion, initialSymbol }: { initialQuestion?: string | null; initialSymbol?: string | null }) {
  const { data: personaData } = useApi<{ personas: PersonaInfo[] }>("/api/v2/agents/personas");
  const personas = personaData?.personas ?? [];
  const [personaId, setPersonaId] = useState("buffett");
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [conversationId, setConversationId] = useState<string>(() => uid());
  const [turns, setTurns] = useState<Turn[]>([]);
  const [message, setMessage] = useState("");
  const [selected, setSelected] = useState<{ turn: string; company: number } | null>(null);
  const [tab, setTab] = useState<ReportTab>("overview");
  const [panelOpen, setPanelOpen] = useState(true);
  const [panelMax, setPanelMax] = useState(false);
  const [minimized, setMinimized] = useState<Record<string, boolean>>({});
  const [maxTurn, setMaxTurn] = useState<string | null>(null);
  const [context, setContext] = useState<{ symbol: string; market: Market; company: string; exchange: string } | null>(null);
  const thread = useRef<HTMLDivElement>(null);
  const aborts = useRef(new Map<string, AbortController>());
  const started = useRef(false);
  // Jobs run side by side. Each is numbered when asked, so a slow early job finishing late never moves the company
  // in view away from a question asked after it.
  const seq = useRef(0);
  const contextSeq = useRef(-1);

  // Browser storage is read after mount (it does not exist during the server render).
  useEffect(() => {
    const t = setTimeout(() => setConversations(readStore()), 0);
    return () => clearTimeout(t);
  }, []);
  useEffect(() => () => aborts.current.forEach((c) => c.abort()), []);

  const running = turns.filter((t) => t.busy).length;
  const busy = running > 0;
  const persona = personas.find((p) => p.id === personaId);
  const selectedTurn = turns.find((t) => t.id === selected?.turn) ?? [...turns].reverse().find((t) => t.result?.status === "answered");
  const selectedAnalysis = selectedTurn?.result?.status === "answered" ? selectedTurn.result : null;

  const remember = useCallback((question: string, result: Analysis) => {
    setConversations((prev) => {
      const existing = prev.find((c) => c.id === conversationId);
      const entry = { requestId: result.requestId, question };
      const next: Conversation = existing
        ? { ...existing, updatedAt: new Date().toISOString(), requests: [...existing.requests, entry] }
        : { id: conversationId, title: question.slice(0, 80), personaId, updatedAt: new Date().toISOString(), requests: [entry] };
      const list = [next, ...prev.filter((c) => c.id !== conversationId)];
      writeStore(list);
      return list;
    });
  }, [conversationId, personaId]);

  const ask = useCallback(async (text: string) => {
    const q = text.trim();
    if (!q) return;
    const id = uid();
    const mySeq = seq.current++;
    const ctrl = new AbortController();
    aborts.current.set(id, ctrl);
    // The persona and the company in view are fixed when the job is asked; later changes affect later jobs only.
    const jobPersona = personaId;
    setTurns((t) => [...t, { id, seq: mySeq, question: q, personaId: jobPersona, steps: [], result: null, error: null, busy: true }]);
    requestAnimationFrame(() => thread.current?.scrollTo({ top: thread.current.scrollHeight, behavior: "smooth" }));
    const target = context ? { symbol: context.symbol, market: context.market } : null;
    try {
      const result = await streamAnalysis(
        { message: q, persona: jobPersona, symbol: target?.symbol ?? initialSymbol ?? null, market: target?.market ?? null },
        (s) => setTurns((all) => all.map((t) => (t.id === id ? { ...t, steps: [...t.steps, s] } : t))), ctrl.signal);
      setTurns((all) => all.map((t) => (t.id === id ? { ...t, result, steps: result.steps, busy: false } : t)));
      if (result.status === "answered" && result.companies[0] && mySeq >= contextSeq.current) {
        contextSeq.current = mySeq;
        const c = result.companies[0];
        setContext({ symbol: c.symbol, market: c.market, company: c.company ?? c.symbol, exchange: c.exchange });
        setSelected({ turn: id, company: 0 });
        setTab("overview");
      }
      remember(q, result);
    } catch (e) {
      const cancelled = (e as Error).name === "AbortError";
      setTurns((all) => all.map((t) => (t.id === id ? { ...t, error: cancelled ? "Cancelled." : (e as Error).message, busy: false } : t)));
    } finally {
      aborts.current.delete(id);
      requestAnimationFrame(() => thread.current?.scrollTo({ top: thread.current.scrollHeight, behavior: "smooth" }));
    }
  }, [context, initialSymbol, personaId, remember]);

  /** Several questions at once: one per line starts one job each (up to five). */
  const submit = (text: string) => {
    const questions = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, 5);
    setMessage("");
    for (const q of questions) void ask(q);
  };
  const cancel = (id: string) => aborts.current.get(id)?.abort();

  // A question passed in the link (from a company page) runs once on arrival.
  useEffect(() => {
    if (started.current || !initialQuestion) return;
    started.current = true;
    const t = setTimeout(() => void ask(initialQuestion), 0);
    return () => clearTimeout(t);
  }, [ask, initialQuestion]);

  const newConversation = () => {
    aborts.current.forEach((c) => c.abort());
    setConversationId(uid());
    setTurns([]);
    setContext(null);
    setSelected(null);
  };

  const open = async (c: Conversation) => {
    newConversation();
    setConversationId(c.id);
    setPersonaId(c.personaId);
    const loaded: Turn[] = c.requests.map((r) => ({ id: r.requestId, seq: seq.current++, question: r.question, personaId: c.personaId, steps: [], result: null, error: null, busy: true }));
    setTurns(loaded);
    for (const r of c.requests) {
      try {
        const res = await fetch(`/api/v2/agents/requests/${r.requestId}`);
        if (!res.ok) throw new Error(res.status === 404 ? "This analysis is no longer on record." : `HTTP ${res.status}`);
        const result = (await res.json()) as Analysis;
        setTurns((all) => all.map((t) => (t.id === r.requestId ? { ...t, result, steps: result.steps, busy: false } : t)));
        if (result.status === "answered" && result.companies[0]) {
          const co = result.companies[0];
          setContext({ symbol: co.symbol, market: co.market, company: co.company ?? co.symbol, exchange: co.exchange });
          setSelected({ turn: r.requestId, company: 0 });
        }
      } catch (e) {
        setTurns((all) => all.map((t) => (t.id === r.requestId ? { ...t, error: (e as Error).message, busy: false } : t)));
      }
    }
  };

  const forget = (id: string) => {
    setConversations((prev) => {
      const list = prev.filter((c) => c.id !== id);
      writeStore(list);
      return list;
    });
  };

  const suggestions = useMemo(() => {
    const last = [...turns].reverse().find((t) => t.result?.status === "answered")?.result;
    return last ? followUps(last) : [];
  }, [turns]);

  return (
    <div className="flex h-full">
      {/* ---- sidebar ---- */}
      <aside className="hidden w-72 shrink-0 flex-col border-r border-slate-200 bg-white lg:flex dark:border-slate-800 dark:bg-[#0e1428]">
        <div className="p-3">
          <button type="button" onClick={newConversation}
            className="flex w-full items-center justify-center gap-2 rounded-xl bg-indigo-600 px-3 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-indigo-700">
            <MessageSquarePlus size={16} /> New analysis
          </button>
        </div>
        <div className="px-3 pb-2">
          <p className="px-1 pb-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-400">Persona</p>
          <div className="space-y-1.5">
            {(personas.length ? personas : [{ id: "buffett", name: "Buffett-style value", inspiredBy: "Warren Buffett", tagline: "", keyMetrics: [], weights: {}, dcfGrowthCap: 0.08, requiredMarginOfSafety: 0.25 }]).map((p) => (
              <button key={p.id} type="button" onClick={() => setPersonaId(p.id)}
                className={clsx("w-full rounded-xl border px-3 py-2 text-left transition disabled:opacity-60",
                  personaId === p.id ? "border-indigo-400 bg-indigo-50 dark:border-indigo-400/50 dark:bg-indigo-500/15" : "border-slate-200 hover:border-indigo-200 dark:border-slate-700 dark:hover:border-indigo-500/40")}>
                <span className="block text-sm font-semibold">{p.name}</span>
                <span className="block text-[11px] text-slate-500">inspired by the principles of {p.inspiredBy}</span>
                {p.weights.fundamental !== undefined && personaId === p.id && (
                  <span className="mt-1 block text-[10.5px] leading-snug text-slate-500">
                    F {Math.round(p.weights.fundamental * 100)} · V {Math.round(p.weights.valuation * 100)} · T {Math.round(p.weights.technical * 100)} · Q {Math.round(p.weights.qualitative * 100)} · MoS {Math.round(p.requiredMarginOfSafety * 100)}% · growth cap {Math.round(p.dcfGrowthCap * 100)}%
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
          <p className="px-1 pb-1.5 pt-2 text-[11px] font-semibold uppercase tracking-wide text-slate-400">Recent analyses</p>
          {!conversations.length && <p className="px-1 text-xs text-slate-500">Your analyses appear here. They are kept in this browser.</p>}
          <ul className="space-y-0.5">
            {conversations.map((c) => (
              <li key={c.id} className="group flex items-center">
                <button type="button" onClick={() => open(c)} disabled={busy}
                  className={clsx("min-w-0 flex-1 rounded-lg px-2 py-1.5 text-left text-sm transition", c.id === conversationId ? "bg-slate-100 dark:bg-slate-800" : "hover:bg-slate-50 dark:hover:bg-slate-800/60")}>
                  <span className="block truncate">{c.title}</span>
                  <span className="block text-[10.5px] text-slate-400">{c.requests.length} question{c.requests.length === 1 ? "" : "s"} · {c.personaId} · {c.updatedAt.slice(0, 10)}</span>
                </button>
                <button type="button" onClick={() => forget(c.id)} aria-label={`Remove ${c.title}`} className="rounded p-1 text-slate-400 opacity-0 transition hover:text-rose-600 group-hover:opacity-100"><Trash2 size={13} /></button>
              </li>
            ))}
          </ul>
        </div>
        <p className="border-t border-slate-200 px-4 py-3 text-[10.5px] leading-snug text-slate-500 dark:border-slate-800">Educational research, not investment advice. Personas are inspired by the investing principles of the investors named; they are not those people.</p>
      </aside>

      {/* ---- thread ---- */}
      <section className="flex min-w-0 flex-1 flex-col">
        <div ref={thread} className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-4xl space-y-6 px-4 py-6 sm:px-6">
            {!turns.length && (
              <div className="motion-rise space-y-6 pt-4">
                <div>
                  <p className="inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-indigo-600 dark:text-indigo-300"><Sparkles size={14} /> Multi-agent research</p>
                  <h1 className="mt-2 text-3xl font-semibold tracking-tight">Ask about any listed company, in India or the US</h1>
                  <p className="mt-2 max-w-2xl text-sm text-slate-600 dark:text-slate-400">
                    A {persona?.name ?? "persona"} agent plans the research. A data agent fetches ten years of filings and prices once;
                    the ratio engine, valuation, technical and news-and-moat agents work in parallel; a validator checks every number;
                    and the persona writes the analysis, with the source of every figure.
                  </p>
                </div>
                <div className="grid gap-2 sm:grid-cols-2">
                  {EXAMPLES.map((e) => (
                    <button key={e.q} type="button" onClick={() => void ask(e.q)}
                      className="rounded-2xl border border-slate-200 bg-white p-4 text-left transition hover:-translate-y-0.5 hover:border-indigo-300 hover:shadow-md dark:border-slate-800 dark:bg-slate-900 dark:hover:border-indigo-500/40">
                      <span className="block text-sm font-medium">{e.q}</span>
                      <span className="mt-1 block text-[11px] text-slate-500">{e.tag}</span>
                    </button>
                  ))}
                </div>
                <div className="rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
                  <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">The agent graph</p>
                  <AgentGraph steps={[]} finished={false} />
                </div>
              </div>
            )}

            {turns.map((t) => (
              <div key={t.id} className="space-y-3">
                <div className="flex justify-end">
                  <p className="max-w-[85%] rounded-2xl rounded-br-sm bg-indigo-600 px-4 py-2.5 text-sm text-white shadow-sm">{t.question}</p>
                </div>
                <div className={clsx("rounded-2xl border bg-white p-4 shadow-sm sm:p-5 dark:bg-slate-900",
                  selected?.turn === t.id ? "border-indigo-300 dark:border-indigo-500/40" : "border-slate-200 dark:border-slate-800")}>
                  <div className="mb-3 flex items-center gap-2 text-xs text-slate-500">
                    <Sparkles size={14} className="text-indigo-600" />
                    <span className="font-semibold text-slate-700 dark:text-slate-200">{personas.find((p) => p.id === t.personaId)?.name ?? t.personaId}</span>
                    {t.busy && <span className="inline-flex items-center gap-1"><Loader2 size={12} className="animate-spin" /> agents working…</span>}
                    <span className="ml-auto flex items-center gap-1">
                      {t.busy && <button type="button" onClick={() => cancel(t.id)} className="rounded-md border border-slate-200 px-2 py-0.5 text-[11px] font-medium text-slate-600 hover:border-rose-300 hover:text-rose-600 dark:border-slate-700 dark:text-slate-300">Cancel</button>}
                      <button type="button" onClick={() => setMaxTurn(t.id)} title="Maximize" aria-label="Maximize this analysis" className="rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800"><Maximize2 size={14} /></button>
                      <button type="button" onClick={() => setMinimized((m) => ({ ...m, [t.id]: !m[t.id] }))} title={minimized[t.id] ? "Expand" : "Minimize"} aria-label={minimized[t.id] ? "Expand this analysis" : "Minimize this analysis"} className="rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800">
                        {minimized[t.id] ? <ChevronDown size={15} /> : <Minimize2 size={14} />}
                      </button>
                    </span>
                  </div>
                  {minimized[t.id] ? (
                    <p className="truncate text-sm text-slate-600 dark:text-slate-300">
                      {t.busy ? "Running…" : t.result?.final ? t.result.final.summary : t.result?.message ?? t.error ?? ""}
                    </p>
                  ) : (
                    <>
                      <div className="mb-4">
                        <AgentTimeline steps={t.steps} finished={!t.busy} title={t.busy ? "Agent run (live)" : "Agent run"} />
                      </div>
                      {t.error && <p role="alert" className="text-sm text-rose-600">{t.error}</p>}
                      {t.result && (
                        <AnswerCard a={t.result}
                          onPick={(question) => ask(question)}
                          onReports={() => { setSelected({ turn: t.id, company: 0 }); setPanelOpen(true); setTab("overview"); }} />
                      )}
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* ---- composer ---- */}
        <div className="shrink-0 border-t border-slate-200 bg-white/90 px-4 py-3 backdrop-blur sm:px-6 dark:border-slate-800 dark:bg-[#0e1428]/90">
          <div className="mx-auto max-w-4xl">
            {suggestions.length > 0 && (
              <div className="-mx-1 mb-2 flex gap-1.5 overflow-x-auto px-1 pb-1">
                {suggestions.map((s) => (
                  <button key={s} type="button" onClick={() => void ask(s)}
                    className="shrink-0 rounded-full border border-slate-200 px-2.5 py-1 text-xs text-slate-600 transition hover:border-indigo-300 hover:text-indigo-700 dark:border-slate-700 dark:text-slate-300">{s}</button>
                ))}
              </div>
            )}
            {context && (
              <p className="mb-1.5 flex items-center gap-1.5 text-[11px] text-slate-500">
                Follow-ups are about <span className="font-semibold text-slate-700 dark:text-slate-200">{context.company}</span> ({marketLabel(context)}) unless you name another company
                <button type="button" onClick={() => setContext(null)} aria-label="Clear the company in view" className="rounded p-0.5 hover:text-rose-600"><X size={12} /></button>
              </p>
            )}
            <form className="flex items-end gap-2" onSubmit={(e) => { e.preventDefault(); submit(message); }}>
              <textarea value={message} onChange={(e) => setMessage(e.target.value)} rows={Math.min(5, Math.max(1, message.split("\n").length))}
                onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(message); } }}
                aria-label="Question for the analyst agents"
                placeholder={context ? `Ask about ${context.company}, or name any company…` : "Analyse Apple · Is HDFC Bank's debt a concern? · Compare TCS vs Accenture"}
                className="max-h-40 min-h-[44px] flex-1 resize-none rounded-xl border border-slate-200 bg-white px-3.5 py-2.5 text-sm outline-none focus:border-indigo-400 dark:border-slate-700 dark:bg-slate-950" />
              <button type="submit" disabled={!message.trim()}
                className={clsx("inline-flex h-11 items-center gap-1.5 rounded-xl px-4 text-sm font-semibold text-white transition", !message.trim() ? "bg-slate-300 dark:bg-slate-700" : "bg-indigo-600 hover:bg-indigo-700")}>
                <Send size={15} /> Analyse
              </button>
            </form>
            <p className="mt-1.5 text-[10.5px] text-slate-400">
              {busy ? <span className="mr-1 inline-flex items-center gap-1 font-medium text-indigo-600 dark:text-indigo-300"><Loader2 size={11} className="animate-spin" /> {running} analysis{running === 1 ? "" : "es"} running ·</span> : null}
              Ask while others run, or put several questions on separate lines (Shift+Enter) to start them together. This is educational research, not investment advice. Consult a registered adviser before investing.
            </p>
          </div>
        </div>
      </section>

      {/* ---- reports ---- */}
      {selectedAnalysis && (
        <>
          <button type="button" onClick={() => setPanelOpen((o) => !o)} aria-label={panelOpen ? "Hide reports" : "Show reports"} title={panelOpen ? "Hide reports" : "Show reports"}
            className="fixed bottom-24 right-4 z-20 rounded-full border border-slate-200 bg-white p-2.5 shadow-lg dark:border-slate-700 dark:bg-slate-900">
            {panelOpen ? <PanelRightClose size={18} /> : <PanelRightOpen size={18} />}
          </button>
          <aside className={clsx("min-h-0 shrink-0 flex-col border-l border-slate-200 bg-white dark:border-slate-800 dark:bg-[#0e1428]",
            panelOpen ? "fixed inset-y-14 right-0 z-10 flex w-full max-w-[44rem] shadow-2xl xl:static xl:inset-auto xl:w-[44%] xl:max-w-none xl:shadow-none" : "hidden")}>
            <div className="flex items-center gap-2 border-b border-slate-200 px-4 py-2.5 dark:border-slate-800">
              <p className="text-sm font-semibold">Reports</p>
              {selectedAnalysis.companies.length > 1 && (
                <div className="ml-2 inline-flex rounded-lg border border-slate-200 p-0.5 dark:border-slate-700">
                  {selectedAnalysis.companies.map((c, i) => (
                    <button key={c.symbol} type="button" onClick={() => setSelected({ turn: selectedTurn!.id, company: i })}
                      className={clsx("rounded-md px-2 py-0.5 text-xs font-medium", (selected?.company ?? 0) === i ? "bg-indigo-600 text-white" : "text-slate-600 dark:text-slate-300")}>{c.symbol}</button>
                  ))}
                </div>
              )}
              <span className="ml-auto truncate text-xs text-slate-500">{selectedAnalysis.question}</span>
              <button type="button" onClick={() => setPanelMax(true)} aria-label="Maximize reports" title="Maximize" className="rounded p-1 text-slate-400 hover:text-slate-700"><Maximize2 size={15} /></button>
              <button type="button" onClick={() => setPanelOpen(false)} aria-label="Minimize reports" title="Minimize" className="rounded p-1 text-slate-400 hover:text-slate-700"><X size={16} /></button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
              <ReportTabs analysis={selectedAnalysis} companyIndex={selected?.company ?? 0} tab={tab} onTab={setTab} />
            </div>
          </aside>
          {panelMax && (
            <Overlay title={<>Reports · {selectedAnalysis.question}</>} onClose={() => setPanelMax(false)}>
              <div className="mx-auto max-w-7xl rounded-2xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900">
                <ReportTabs analysis={selectedAnalysis} companyIndex={selected?.company ?? 0} tab={tab} onTab={setTab} />
              </div>
            </Overlay>
          )}
        </>
      )}
      {maxTurn && (() => {
        const t = turns.find((x) => x.id === maxTurn);
        if (!t) return null;
        return (
          <Overlay title={<>{t.question}</>} onClose={() => setMaxTurn(null)}>
            <div className="mx-auto max-w-6xl space-y-5">
              <AgentTimeline steps={t.steps} finished={!t.busy} title={t.busy ? "Agent run (live)" : "Agent run"} />
              {t.result && (
                <div className="rounded-2xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900">
                  <AnswerCard a={t.result} onPick={(question) => { setMaxTurn(null); void ask(question); }} onReports={() => { setMaxTurn(null); setSelected({ turn: t.id, company: 0 }); setPanelOpen(true); setPanelMax(true); }} />
                </div>
              )}
              {t.result?.status === "answered" && (
                <div className="rounded-2xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900">
                  <ReportTabs analysis={t.result} tab={tab} onTab={setTab} />
                </div>
              )}
            </div>
          </Overlay>
        );
      })()}
    </div>
  );
}
