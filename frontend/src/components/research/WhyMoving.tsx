"use client";

// "Why is this stock moving?" - the card that sits under the price header.
//
// Each bullet is a real filing with its timestamp, its source and a link, or it is the sector's own move. When
// nothing material was filed the card says exactly that rather than reaching for a story, which is the whole
// point: a confident wrong cause costs more trust than an honest blank.
import clsx from "clsx";
import { ArrowDownRight, ArrowUpRight, ExternalLink, Minus } from "lucide-react";
import { useState } from "react";
import { AiDisclosure } from "@/components/Disclosure";
import { Card, CardBody, CardHeader, Skeleton } from "@/components/ui";
import { useApi } from "@/lib/api";
import { dateTime, int, num } from "@/lib/format";

interface Catalyst {
  kind: string; title: string; detail: string | null; when: string; source: string; url: string | null;
  confidence: "High" | "Medium" | "Low"; expected: string; agrees: boolean | null; score: number;
}
interface MoveData {
  symbol: string; company: string | null;
  move: {
    session: string | null; changePct: number | null;
    benchmark: { slug: string | null; name: string; changePct: number | null; isSector: boolean } | null;
    market: { name: string; changePct: number | null } | null;
    beta: number | null; abnormalPct: number | null; volume: number | null; averageVolume20d: number | null;
    volumeRatio: number | null; volatility30d: number | null; threshold: number | null; material: boolean;
    direction: "up" | "down" | "flat";
  };
  headline: string; summary: string; catalysts: Catalyst[]; noCatalyst: boolean;
  searched: string[]; notCovered: string[]; generatedAt: string;
}

const CONFIDENCE_TONE: Record<string, string> = {
  High: "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300",
  Medium: "bg-amber-50 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300",
  Low: "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300",
};

const KIND_LABEL: Record<string, string> = {
  filing: "Filing", result: "Results", action: "Corporate action", insider: "Insider trade",
  board: "Board meeting", shareholding: "Shareholding", sector: "Sector",
};

const pctText = (v: number | null | undefined) => (v === null || v === undefined ? "—" : `${v > 0 ? "+" : ""}${num(v, 2)}%`);

export function WhyMoving({ symbol }: { symbol: string }) {
  const { data, error } = useApi<MoveData>(`/api/v2/company/${encodeURIComponent(symbol)}/moves`);
  const [showWorkings, setShowWorkings] = useState(false);

  if (error) return null; // never let this card break the page it sits on
  if (!data) return <Card><CardBody className="space-y-2"><Skeleton className="h-5 w-64" /><Skeleton className="h-16 w-full" /></CardBody></Card>;

  const m = data.move;
  const Icon = m.direction === "up" ? ArrowUpRight : m.direction === "down" ? ArrowDownRight : Minus;
  const headTone = m.direction === "up" ? "text-emerald-600 dark:text-emerald-400" : m.direction === "down" ? "text-rose-600 dark:text-rose-400" : "text-slate-500";

  return (
    <Card>
      <CardHeader
        title={<span className={clsx("inline-flex items-center gap-2", headTone)}><Icon size={18} aria-hidden />{data.headline}</span>}
        subtitle={m.session ? `Close of ${dateTime(`${m.session}T15:30:00+05:30`)} IST · end of day` : undefined}
        actions={<button type="button" onClick={() => setShowWorkings((v) => !v)} className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-medium text-slate-600 dark:border-slate-700 dark:text-slate-300">{showWorkings ? "Hide the workings" : "How this was worked out"}</button>}
      />
      <CardBody className="space-y-4">
        <p className="text-sm leading-relaxed text-slate-700 dark:text-slate-200">{data.summary}</p>

        <div className="grid gap-px overflow-hidden rounded-xl bg-slate-200 sm:grid-cols-2 lg:grid-cols-4 dark:bg-slate-800">
          {[
            ["This stock", pctText(m.changePct), m.session ?? ""],
            [m.benchmark?.name ?? "Benchmark", pctText(m.benchmark?.changePct), m.benchmark?.isSector ? "its sector index" : "broad index"],
            ["Move not explained by the index", pctText(m.abnormalPct), m.beta === null ? "beta unavailable, taken as 1" : `after a beta of ${num(m.beta, 2)}`],
            ["Volume against its 20-day average", m.volumeRatio === null ? "—" : `${num(m.volumeRatio, 2)}×`, m.averageVolume20d ? `${int(m.averageVolume20d)} shares average` : ""],
          ].map(([label, value, hint]) => (
            <div key={label} className="bg-white p-3 dark:bg-slate-900">
              <p className="text-[11px] font-medium uppercase tracking-wide text-slate-500">{label}</p>
              <p className="mt-0.5 text-lg font-semibold tabular-nums">{value}</p>
              {hint && <p className="text-[11px] text-slate-400">{hint}</p>}
            </div>
          ))}
        </div>

        {data.catalysts.length > 0 ? (
          <ul className="space-y-2">
            {data.catalysts.map((c) => (
              <li key={`${c.kind}-${c.when}-${c.title}`} className="rounded-xl border border-slate-200 p-3 dark:border-slate-800">
                <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
                  <span className="rounded-md bg-slate-100 px-1.5 py-0.5 font-semibold text-slate-600 dark:bg-slate-800 dark:text-slate-300">{KIND_LABEL[c.kind] ?? c.kind}</span>
                  <span className="text-slate-500">{c.source}</span>
                  <span className="text-slate-400">· {dateTime(c.when)} IST</span>
                  <span className={clsx("ml-auto rounded-md px-1.5 py-0.5 font-semibold", CONFIDENCE_TONE[c.confidence])}>{c.confidence} confidence</span>
                </div>
                <p className="mt-1.5 text-sm font-medium">{c.title}</p>
                {c.detail && <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">{c.detail}</p>}
                {c.url && (
                  <a href={c.url} target="_blank" rel="noopener noreferrer" className="mt-1.5 inline-flex items-center gap-1 text-xs font-medium text-indigo-700 hover:underline dark:text-indigo-300">
                    Open the document <ExternalLink size={11} />
                  </a>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="rounded-xl border border-dashed border-slate-300 p-3 text-sm text-slate-500 dark:border-slate-700">
            No company-specific filing was found in the window. That is the finding, not a gap: where the record shows
            nothing, this card says nothing.
          </p>
        )}

        {showWorkings && (
          <div className="rounded-xl bg-slate-50 p-4 text-xs text-slate-600 dark:bg-slate-900/60 dark:text-slate-300">
            <p className="font-semibold text-slate-700 dark:text-slate-200">What was searched</p>
            <ul className="mt-1 list-disc space-y-0.5 pl-4">{data.searched.map((s) => <li key={s}>{s}</li>)}</ul>
            <p className="mt-3 font-semibold text-slate-700 dark:text-slate-200">What this card cannot see</p>
            <ul className="mt-1 list-disc space-y-0.5 pl-4">{data.notCovered.map((s) => <li key={s}>{s}</li>)}</ul>
            <p className="mt-3">
              A move counts as material when it is more than {m.threshold === null ? "—" : `${num(m.threshold, 2)}%`} (twice this
              stock&apos;s own 30-day daily volatility of {m.volatility30d === null ? "—" : `${num(m.volatility30d, 2)}%`}) or the
              volume is twice its 20-day average. Candidates are ranked by how close they fell to the session, how material the
              kind of disclosure usually is, and whether the direction fits the move.
            </p>
          </div>
        )}

        <AiDisclosure kind="retrieval" />
      </CardBody>
    </Card>
  );
}
