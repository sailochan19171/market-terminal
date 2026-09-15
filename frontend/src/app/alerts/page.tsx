"use client";

import { BellRing, Play, Send } from "lucide-react";
import { useState } from "react";
import { DataTable } from "@/components/DataTable";
import { Badge, Button, Card, CardBody, CardHeader, ErrorNote, Loading, PageTitle } from "@/components/ui";
import { post, useApi } from "@/lib/api";

interface Rule { id: number; name: string; kind: string; params: string; enabled: number }
interface Run { total: number; new: number; delivered: number; hits: { rule: string; subject: string; body: string }[] }

export default function AlertsPage() {
  const { data, error, loading, reload } = useApi<{ rules: Rule[] }>("/api/alerts/rules");
  const [run, setRun] = useState<Run | null>(null);
  const [busy, setBusy] = useState<"eval" | "send" | null>(null);
  const [runError, setRunError] = useState<string | null>(null);

  const evaluate = async (send: boolean) => {
    setBusy(send ? "send" : "eval");
    setRunError(null);
    try { setRun(await post<Run>("/api/alerts/run", { send })); }
    catch (e) { setRunError((e as Error).message); }
    finally { setBusy(null); }
  };

  return (
    <>
      <PageTitle title="Alerts" subtitle="Rules evaluated against stored prices, filings and corporate actions."
        actions={<div className="flex gap-2">
          <Button onClick={() => evaluate(false)} disabled={busy !== null}><Play size={15} /> {busy === "eval" ? "Evaluating…" : "Evaluate"}</Button>
          <Button variant="primary" onClick={() => evaluate(true)} disabled={busy !== null}><Send size={15} /> {busy === "send" ? "Sending…" : "Evaluate & send"}</Button>
        </div>} />

      <Card className="mb-6">
        <CardHeader title="Rules" subtitle="Delivery channels are configured with ALERT_CHANNELS in the pipeline's .env" />
        {error && <ErrorNote message={error} onRetry={reload} />}
        <div className="pt-3">
          {loading && !data ? <Loading /> : (
            <DataTable dense searchable searchPlaceholder="Search rules" rows={data?.rules ?? []} rowKey={(r) => String(r.id)} empty="No rules. Run `npm run market -- alerts seed` in the frontend folder to add the starter set."
              columns={[
                { key: "name", label: "Rule", render: (r) => <span className="font-semibold">{r.name}</span> },
                { key: "kind", label: "Kind", render: (r) => <Badge tone="brand">{r.kind.replace("_", " ")}</Badge> },
                { key: "params", label: "Parameters", className: "max-w-xl whitespace-normal font-mono text-xs text-slate-500", render: (r) => r.params },
                { key: "enabled", label: "Status", render: (r) => <Badge tone={r.enabled ? "up" : "slate"}>{r.enabled ? "Enabled" : "Off"}</Badge> },
              ]} />
          )}
        </div>
      </Card>

      {runError && <Card className="mb-6"><ErrorNote message={runError} /></Card>}
      {run && (
        <Card>
          <CardHeader title={<span className="flex items-center gap-2"><BellRing size={18} /> {run.new} new of {run.total} matches</span>}
            subtitle={busy === null && run.delivered ? `${run.delivered} delivered` : "Matches already sent are skipped automatically"} />
          <CardBody>
            {run.hits.length === 0 ? <p className="text-sm text-slate-500">Nothing new matched.</p> : (
              <ul className="space-y-3">
                {run.hits.map((h, i) => (
                  <li key={i} className="rounded-2xl border border-slate-200 p-4 dark:border-slate-800">
                    <div className="flex items-center justify-between gap-2"><p className="font-semibold">{h.subject}</p><Badge>{h.rule}</Badge></div>
                    <pre className="mt-2 whitespace-pre-wrap font-sans text-sm text-slate-600 dark:text-slate-300">{h.body}</pre>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>
      )}
    </>
  );
}
