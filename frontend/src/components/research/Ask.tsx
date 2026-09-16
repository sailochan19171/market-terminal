"use client";

import clsx from "clsx";
import { ExternalLink, Send, ThumbsDown, ThumbsUp } from "lucide-react";
import { useRef, useState } from "react";
import { AiDisclosure } from "@/components/Disclosure";
import { BrandMark } from "@/components/BrandMark";
import { Card, CardHeader } from "@/components/ui";
import { api } from "@/lib/api";
import { dateOnly, inr, inrCrore, num } from "@/lib/format";

interface Citation { n: number; label: string; period?: string | null; url?: string | null; source: string }
interface ScreenFilter { field: string; op: string; value: number; label: string }
interface ScreenRow { symbol: string; company: string; close: number | null; pe: number | null; roe: number | null; market_cap_cr: number | null }
interface ScreenOut { plan: { filters: ScreenFilter[]; sector: string | null; readBy: string; sort: string }; total: number; items: ScreenRow[]; columns: Record<string, string> }
interface Answer { question: string; headline: string; points: string[]; citations: Citation[]; suggestions: string[]; writtenBy: "data" | "model"; note?: string; id?: string; screen?: ScreenOut }

const STARTERS = [
  "Should I invest in this company?",
  "When should I buy, and when should I avoid it?",
  "Is it undervalued right now?",
  "What are the biggest risks?",
  "How was the last quarter?",
  "How much debt does it carry?",
  "What changed recently?",
];


/**
 * The result of a screen, with the filters that produced it shown above the list.
 *
 * The filters are the point: a reader can see exactly what was asked on their behalf, and follow the link to
 * the screener to change any of it. No query the reader cannot read is ever run.
 */
function ScreenTable({ screen }: { screen: ScreenOut }) {
  const href = `/screens/custom?${new URLSearchParams({
    ...(screen.plan.sector ? { sector: screen.plan.sector } : {}),
    sort: screen.plan.sort,
  })}`;
  return (
    <div className="mt-3 rounded-xl border border-slate-200 dark:border-slate-800">
      <div className="flex flex-wrap items-center gap-1.5 border-b border-slate-200 px-3 py-2 dark:border-slate-800">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Filters applied</span>
        {screen.plan.filters.map((f) => (
          <span key={f.label} className="rounded-md bg-indigo-50 px-1.5 py-0.5 text-[11px] font-medium text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300">{f.label}</span>
        ))}
        {screen.plan.sector && <span className="rounded-md bg-slate-100 px-1.5 py-0.5 text-[11px] font-medium text-slate-600 dark:bg-slate-800 dark:text-slate-300">{screen.plan.sector}</span>}
        <span className="ml-auto text-[11px] text-slate-400">{screen.plan.readBy === "model" ? "read by the model" : "read from your words"}</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-wide text-slate-500">
              <th className="px-3 py-1.5 font-medium">Company</th>
              <th className="px-2 py-1.5 text-right font-medium">Price</th>
              <th className="px-2 py-1.5 text-right font-medium">P/E</th>
              <th className="px-2 py-1.5 text-right font-medium">ROE</th>
              <th className="px-3 py-1.5 text-right font-medium">Market cap</th>
            </tr>
          </thead>
          <tbody>
            {screen.items.slice(0, 10).map((r) => (
              <tr key={r.symbol} className="border-t border-slate-100 dark:border-slate-800/60">
                <td className="px-3 py-1.5">
                  <a href={`/company/${encodeURIComponent(r.symbol)}`} className="font-medium text-indigo-700 hover:underline dark:text-indigo-300">{r.company}</a>
                  <span className="ml-1.5 text-[11px] text-slate-400">{r.symbol}</span>
                </td>
                <td className="px-2 py-1.5 text-right tabular-nums">{inr(r.close)}</td>
                <td className="px-2 py-1.5 text-right tabular-nums">{num(r.pe, 1)}</td>
                <td className="px-2 py-1.5 text-right tabular-nums">{num(r.roe, 1)}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">{inrCrore(r.market_cap_cr)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {screen.total > screen.items.length && (
        <p className="border-t border-slate-200 px-3 py-2 text-xs text-slate-500 dark:border-slate-800">
          Showing {Math.min(10, screen.items.length)} of {screen.total.toLocaleString("en-IN")}.{" "}
          <a href={href} className="text-indigo-700 hover:underline dark:text-indigo-300">Open the screener</a> to see them all and change the filters.
        </p>
      )}
    </div>
  );
}

/** "Was this helpful?" - the rating the spec asks to be tracked, stored against the answer's audit record. */
function Helpful({ id }: { id: string }) {
  const [sent, setSent] = useState<"helpful" | "unhelpful" | null>(null);
  const say = async (rating: "helpful" | "unhelpful") => {
    setSent(rating);
    await api("/api/v2/ai/quality", { method: "POST", body: JSON.stringify({ id, rating }) }).catch(() => undefined);
  };
  if (sent) return <span className="text-slate-400">{sent === "helpful" ? "marked helpful" : "marked unhelpful - thank you"}</span>;
  return (
    <span className="inline-flex items-center gap-1">
      helpful?
      <button type="button" onClick={() => say("helpful")} aria-label="This answer was helpful" className="rounded p-0.5 hover:text-emerald-600"><ThumbsUp size={12} /></button>
      <button type="button" onClick={() => say("unhelpful")} aria-label="This answer was not helpful" className="rounded p-0.5 hover:text-rose-600"><ThumbsDown size={12} /></button>
    </span>
  );
}

/** Questions answered from this company's filings and figures, with the source of every number. */
export function Ask({ symbol, company }: { symbol: string; company: string | null }) {
  const [thread, setThread] = useState<Answer[]>([]);
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);

  const send = async (q: string) => {
    const text = q.trim();
    if (!text || busy) return;
    setBusy(true);
    setError(null);
    setQuestion("");
    try {
      // Send the conversation so far, so "and its debt?" is understood as a follow-up rather than a new question.
      const history = thread.slice(-4).map((t) => ({ q: t.question, a: [t.headline, ...t.points].join(" ") }));
      const answer = await api<Answer>(`/api/v2/company/${encodeURIComponent(symbol)}/ask`, {
        method: "POST",
        body: JSON.stringify({ q: text, history }),
      });
      setThread((t) => [...t, answer]);
      requestAnimationFrame(() => box.current?.scrollTo({ top: box.current.scrollHeight, behavior: "smooth" }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader
        title={<span className="inline-flex items-center gap-2"><BrandMark size={22} /> Ask about {company ?? symbol}</span>}
        subtitle="Answered from this company's exchange filings, results and prices. Every figure names its source."
      />
      <div ref={box} className="max-h-[32rem] space-y-4 overflow-y-auto px-5 py-4 sm:px-6">
        {!thread.length && (
          <p className="text-sm text-slate-500 dark:text-slate-400">
            Ask anything about the business, its results, debt, ownership, filings or valuation. Answers stay short and
            point at the filing they came from; where the record has nothing, they say so rather than guess.
            <span className="mt-1.5 block">
              Any of the 3,500 companies listed on NSE and BSE can be asked about &mdash; name one in your question
              (&ldquo;how is Infosys doing?&rdquo;) and the answer moves to it, or change the company in view above.
            </span>
          </p>
        )}
        {thread.map((a, i) => (
          <div key={i} className="motion-rise space-y-2">
            <p className="ml-auto w-fit max-w-[85%] rounded-2xl rounded-br-sm bg-indigo-600 px-3.5 py-2 text-sm text-white">{a.question}</p>
            <div className="max-w-[92%] rounded-2xl rounded-bl-sm border border-slate-200 bg-slate-50 px-4 py-3 dark:border-slate-800 dark:bg-slate-900">
              <p className="text-sm font-semibold">{a.headline}</p>
              <ul className="mt-2 space-y-1.5">
                {a.points.map((p, j) => <li key={j} className="text-sm text-slate-700 dark:text-slate-300">• {p}</li>)}
              </ul>
              {a.screen && <ScreenTable screen={a.screen} />}
              {a.citations.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-1.5 border-t border-slate-200 pt-2.5 dark:border-slate-800">
                  {a.citations.map((c) => (
                    c.url
                      ? <a key={c.n} href={c.url} target="_blank" rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-white px-2 py-0.5 text-[11px] text-slate-600 hover:border-indigo-300 hover:text-indigo-700 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-300">
                          [{c.n}] {c.label.slice(0, 44)}{c.period ? ` · ${dateOnly(c.period)}` : ""} <ExternalLink size={10} />
                        </a>
                      : <span key={c.n} className="rounded-full border border-slate-200 px-2 py-0.5 text-[11px] text-slate-500 dark:border-slate-700">
                          [{c.n}] {c.label.slice(0, 44)}{c.period ? ` · ${dateOnly(c.period)}` : ""}
                        </span>
                  ))}
                  <span className="ml-auto flex items-center gap-2 text-[11px] text-slate-400">
                    <span title={a.note ?? ""}>{a.writtenBy === "model" ? "phrased by the configured model from these sources" : a.note ? "the model was busy - written from the data" : "written from the data"}</span>
                    {a.id && <Helpful id={a.id} />}
                  </span>
                </div>
              )}
            </div>
          </div>
        ))}
        {busy && <p className="flex items-center gap-2 text-sm text-slate-500"><BrandMark size={18} animated /> Reading the filings…</p>}
        {error && <p role="alert" className="text-sm text-rose-600">{error}</p>}
        <AiDisclosure kind={thread.some((t) => t.writtenBy === "model") ? "ai" : "retrieval"} />
      </div>

      <div className="border-t border-slate-100 px-5 py-3 sm:px-6 dark:border-slate-800">
        <div className="-mx-1 mb-2 flex gap-1.5 overflow-x-auto px-1 pb-1">
          {(thread.at(-1)?.suggestions ?? STARTERS).map((s) => (
            <button key={s} type="button" onClick={() => send(s)} disabled={busy}
              className="shrink-0 rounded-full border border-slate-200 px-2.5 py-1 text-xs text-slate-600 transition hover:border-indigo-300 hover:text-indigo-700 disabled:opacity-50 dark:border-slate-700 dark:text-slate-300">
              {s}
            </button>
          ))}
        </div>
        <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); void send(question); }}>
          <input value={question} onChange={(e) => setQuestion(e.target.value)} disabled={busy}
            placeholder={`Ask about ${company ?? symbol}…`} aria-label="Ask a question about this company"
            className="flex-1 rounded-xl border border-slate-200 bg-white px-3.5 py-2.5 text-sm outline-none focus:border-indigo-400 dark:border-slate-700 dark:bg-slate-950" />
          <button type="submit" disabled={busy || !question.trim()}
            className={clsx("inline-flex items-center gap-1.5 rounded-xl px-4 py-2.5 text-sm font-semibold text-white transition", busy || !question.trim() ? "bg-slate-300 dark:bg-slate-700" : "bg-indigo-600 hover:bg-indigo-700")}>
            <Send size={15} /> Ask
          </button>
        </form>
      </div>
    </Card>
  );
}
