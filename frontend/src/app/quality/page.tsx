"use client";

// The quality page: what the platform generated, how well it held up, and what it cost.
//
// The spec asks to be held to a grounding rate, a helpfulness rating and a daily human check of a random
// sample. None of that means anything as a claim, so it is measured here from the record of every generation -
// and the sample below is the daily read-through, with somewhere to mark what was wrong.
import clsx from "clsx";
import { CheckCircle2, CircleHelp, XCircle } from "lucide-react";
import { useCallback, useState } from "react";
import { Card, CardBody, CardHeader, ErrorNote, Skeleton } from "@/components/ui";
import { api, useApi } from "@/lib/api";
import { dateTime, int, percent } from "@/lib/format";

interface Quality {
  since: string; generated: number; byModel: number; figures: number; ungrounded: number;
  groundingRate: number | null; helpful: number; unhelpful: number; reviewed: number; wrong: number;
  promptTokens: number; completionTokens: number; failures: number;
}
interface Sampled {
  id: string; at: string; kind: string; symbol: string | null; question: string | null; answer: string;
  written_by: string; model: string | null; figures: number; ungrounded: number; rating: string | null; review: string | null;
}

export default function QualityPage() {
  const { data, error, reload } = useApi<{ quality: Quality; sample: Sampled[] }>("/api/v2/ai/quality?sample=8");
  const [marked, setMarked] = useState<Record<string, string>>({});

  const mark = useCallback(async (id: string, verdict: "ok" | "wrong" | "unclear") => {
    setMarked((m) => ({ ...m, [id]: verdict }));
    await api("/api/v2/ai/quality", { method: "POST", body: JSON.stringify({ id, review: verdict }) }).catch(() => undefined);
  }, []);

  if (error && !data) return <Card><ErrorNote message={`The quality record could not load: ${error}`} onRetry={reload} /></Card>;
  if (!data) return <Skeleton className="h-96 w-full" />;

  const q = data.quality;
  const rated = q.helpful + q.unhelpful;
  const figures = [
    ["Answers generated", int(q.generated), `since ${dateTime(q.since)}`],
    ["Phrased by a model", int(q.byModel), q.generated ? `${percent((q.byModel / q.generated) * 100)} of them` : ""],
    ["Figures printed", int(q.figures), "rupee amounts, percentages and ratios"],
    ["Traceable to a source", q.groundingRate === null ? "—" : `${q.groundingRate}%`, `${int(q.ungrounded)} could not be traced`],
    ["Marked helpful", rated ? percent((q.helpful / rated) * 100) : "—", `${int(rated)} rating${rated === 1 ? "" : "s"}`],
    ["Read through by a person", int(q.reviewed), `${int(q.wrong)} marked wrong`],
    ["Model tokens used", int(q.promptTokens + q.completionTokens), `${int(q.promptTokens)} in, ${int(q.completionTokens)} out`],
    ["Model calls that failed", int(q.failures), "the written answer stood in"],
  ];

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-400">Quality</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight sm:text-3xl">What was generated, and how well it held up</h1>
        <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
          Every answer is kept with the question, the sources it drew on, the model that phrased it and what that
          cost &mdash; the record a research platform is expected to keep, and the measurement behind the figures below.
        </p>
      </div>

      <Card>
        <div className="grid gap-px overflow-hidden rounded-2xl bg-slate-200 sm:grid-cols-2 lg:grid-cols-4 dark:bg-slate-800">
          {figures.map(([label, value, hint]) => (
            <div key={label} className="bg-white p-4 dark:bg-slate-900">
              <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</p>
              <p className="mt-1 text-xl font-semibold tabular-nums">{value}</p>
              {hint && <p className="mt-0.5 text-xs text-slate-400">{hint}</p>}
            </div>
          ))}
        </div>
      </Card>

      <Card>
        <CardHeader title="A sample to read through"
          subtitle="Drawn at random from what has not been checked. Mark each one so the rate above means something." />
        <CardBody className="space-y-3">
          {data.sample.length === 0 && <p className="text-sm text-slate-500">Nothing left unchecked.</p>}
          {data.sample.map((s) => {
            const verdict = marked[s.id] ?? s.review;
            return (
              <div key={s.id} className="rounded-xl border border-slate-200 p-3 dark:border-slate-800">
                <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-500">
                  <span className="rounded-md bg-slate-100 px-1.5 py-0.5 font-semibold dark:bg-slate-800">{s.symbol ?? s.kind}</span>
                  <span>{dateTime(s.at)}</span>
                  <span>· {s.written_by === "model" ? `model${s.model ? ` (${s.model})` : ""}` : "written from the data"}</span>
                  {s.figures > 0 && <span>· {s.figures} figure{s.figures === 1 ? "" : "s"}{s.ungrounded ? `, ${s.ungrounded} untraceable` : ", all traceable"}</span>}
                  {s.rating && <span>· reader said {s.rating}</span>}
                </div>
                {s.question && <p className="mt-1.5 text-sm font-medium">{s.question}</p>}
                <p className="mt-1 whitespace-pre-line text-sm text-slate-600 dark:text-slate-300">{s.answer.split(" | ").join("\n")}</p>
                <div className="mt-2 flex items-center gap-1.5">
                  {([["ok", CheckCircle2, "Reads correctly"], ["unclear", CircleHelp, "Unclear"], ["wrong", XCircle, "Wrong"]] as const).map(([v, Icon, label]) => (
                    <button key={v} type="button" onClick={() => mark(s.id, v)}
                      className={clsx("inline-flex items-center gap-1 rounded-lg border px-2 py-1 text-xs font-medium transition",
                        verdict === v ? "border-indigo-500 bg-indigo-50 text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300" : "border-slate-200 text-slate-600 hover:border-indigo-300 dark:border-slate-700 dark:text-slate-300")}>
                      <Icon size={13} /> {label}
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
        </CardBody>
      </Card>
    </div>
  );
}
