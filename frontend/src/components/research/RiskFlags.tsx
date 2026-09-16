"use client";

// The risk-flag panel: the checks that most often precede trouble, each with the filing that raised it.
//
// Checks that found nothing are shown too, quietly. "We looked at pledging and there is none" is worth as much
// to a reader as the flag itself, and it makes clear which checks could not run for want of a filing.
import clsx from "clsx";
import { AlertTriangle, CheckCircle2, ExternalLink, HelpCircle } from "lucide-react";
import { useState } from "react";
import { AiDisclosure } from "@/components/Disclosure";
import { Card, CardBody, CardHeader, Skeleton } from "@/components/ui";
import { useApi } from "@/lib/api";
import { dateOnly } from "@/lib/format";

interface Flag {
  key: string; label: string; status: "raised" | "clear" | "unknown"; level: "high" | "medium" | "low";
  detail: string; source: { label: string; when: string | null; url: string | null } | null;
}
interface FlagData { symbol: string; company: string | null; bank: boolean; flags: Flag[]; raised: number; checked: number; summary: string }

export function RiskFlags({ symbol }: { symbol: string }) {
  const { data, error } = useApi<FlagData>(`/api/v2/company/${encodeURIComponent(symbol)}/flags`);
  const [showAll, setShowAll] = useState(false);

  if (error) return null;
  if (!data) return <Card><CardBody className="space-y-2"><Skeleton className="h-5 w-48" /><Skeleton className="h-20 w-full" /></CardBody></Card>;

  const raised = data.flags.filter((f) => f.status === "raised");
  const rest = data.flags.filter((f) => f.status !== "raised");
  const shown = showAll ? [...raised, ...rest] : raised.length ? raised : rest;

  return (
    <Card>
      <CardHeader
        title="Risk flags"
        subtitle={data.summary}
        actions={<button type="button" onClick={() => setShowAll((v) => !v)} className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-medium text-slate-600 dark:border-slate-700 dark:text-slate-300">{showAll ? "Show what was raised" : `Show all ${data.checked} checks`}</button>}
      />
      <CardBody className="space-y-2">
        {shown.map((f) => {
          const Icon = f.status === "raised" ? AlertTriangle : f.status === "unknown" ? HelpCircle : CheckCircle2;
          const tone = f.status === "raised"
            ? f.level === "high" ? "border-rose-200 bg-rose-50/50 dark:border-rose-500/20 dark:bg-rose-500/5" : "border-amber-200 bg-amber-50/50 dark:border-amber-500/20 dark:bg-amber-500/5"
            : "border-slate-200 dark:border-slate-800";
          const iconTone = f.status === "raised" ? (f.level === "high" ? "text-rose-600" : "text-amber-600") : f.status === "unknown" ? "text-slate-400" : "text-emerald-600";
          return (
            <div key={f.key} className={clsx("rounded-xl border p-3", tone)}>
              <div className="flex gap-2">
                <Icon size={16} className={clsx("mt-0.5 shrink-0", iconTone)} aria-hidden />
                <div className="min-w-0">
                  <p className="text-sm font-semibold">
                    {f.label}
                    {f.status === "raised" && <span className="ml-2 rounded-md bg-white/70 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide dark:bg-slate-900/60">{f.level === "high" ? "serious" : "worth reading"}</span>}
                  </p>
                  <p className="mt-0.5 text-sm text-slate-600 dark:text-slate-300">{f.detail}</p>
                  {f.source && (
                    <p className="mt-1 text-xs text-slate-500">
                      {f.source.label}{f.source.when ? ` · ${dateOnly(f.source.when)}` : ""}
                      {f.source.url && (
                        <a href={f.source.url} target="_blank" rel="noopener noreferrer" className="ml-2 inline-flex items-center gap-1 text-indigo-700 hover:underline dark:text-indigo-300">
                          open the filing <ExternalLink size={11} />
                        </a>
                      )}
                    </p>
                  )}
                </div>
              </div>
            </div>
          );
        })}
        <AiDisclosure kind="retrieval" />
      </CardBody>
    </Card>
  );
}
