"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { DataTable } from "@/components/DataTable";
import { Badge, Card, ErrorNote, Loading, PageTitle, Segmented } from "@/components/ui";
import { useApi } from "@/lib/api";
import { dateOnly } from "@/lib/format";

interface Action { id: string; purpose: string; ex_date: string; record_date: string; exchange: string; ex: string }

const KINDS = [
  { value: "all", label: "All" }, { value: "dividend", label: "Dividends" }, { value: "bonus", label: "Bonus" },
  { value: "split", label: "Splits" }, { value: "rights", label: "Rights" }, { value: "buyback", label: "Buyback" },
] as const;

export default function CorporateActionsPage() {
  const [days, setDays] = useState("30");
  const [kind, setKind] = useState<(typeof KINDS)[number]["value"]>("all");
  const { data, error, loading, reload } = useApi<{ actions: Action[] }>(`/api/actions?days=${days}`);

  const rows = useMemo(() => (data?.actions ?? []).filter((a) => {
    if (kind === "all") return true;
    const p = a.purpose.toLowerCase();
    if (kind === "split") return p.includes("split") || p.includes("sub-division") || p.includes("subdivision");
    if (kind === "buyback") return p.includes("buy back") || p.includes("buyback");
    return p.includes(kind);
  }), [data, kind]);

  return (
    <>
      <PageTitle title="Corporate actions" subtitle="Upcoming ex-dates for dividends, bonuses, splits and rights on NSE and BSE." />
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3 px-5 pt-5 sm:px-6">
          <Segmented size="sm" value={kind} onChange={setKind} options={KINDS.map((k) => ({ value: k.value, label: k.label }))} />
          <Segmented size="sm" value={days} onChange={setDays} options={[{ value: "7", label: "7 days" }, { value: "30", label: "30 days" }, { value: "90", label: "90 days" }]} />
        </div>
        {error && <ErrorNote message={error} onRetry={reload} />}
        <div className="pt-4">
          {loading && !data ? <Loading rows={12} /> : (
            <DataTable dense sortable searchable searchPlaceholder="Search company or action" rows={rows} rowKey={(r, i) => `${r.id}-${r.ex_date}-${i}`} initialSort={{ key: "ex_date", dir: "asc" }}
              empty="No corporate actions with an ex-date in this window."
              columns={[
                { key: "ex_date", label: "Ex-date", render: (r) => <span className="font-medium">{dateOnly(r.ex_date)}</span> },
                { key: "id", label: "Symbol", render: (r) => r.ex === "nse"
                  ? <Link href={`/company/${r.id}`} className="font-semibold text-indigo-700 hover:underline dark:text-indigo-300">{r.id}</Link>
                  : <span className="font-semibold">{r.id}</span> },
                { key: "purpose", label: "Action", className: "whitespace-normal" },
                { key: "record_date", label: "Record date", render: (r) => dateOnly(r.record_date || null) },
                { key: "exchange", label: "Exchange", render: (r) => <Badge tone={r.exchange === "NSE" ? "brand" : "up"}>{r.exchange}</Badge> },
              ]} />
          )}
        </div>
      </Card>
    </>
  );
}
