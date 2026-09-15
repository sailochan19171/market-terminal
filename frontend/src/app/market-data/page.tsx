"use client";

import { BarChart3, ChevronRight, Radio } from "lucide-react";
import Link from "next/link";
import { Badge, Card, CardBody, CardHeader, ErrorNote, Loading, PageTitle } from "@/components/ui";
import { useApi } from "@/lib/api";

interface Catalogue { modules: { key: string; title: string; note: string }[] }

const COMPUTED = [
  { key: "breadth", title: "Advances & declines", note: "Market breadth for every session, from stored end-of-day prices." },
  { key: "sectors", title: "Sector performance", note: "Average move of each sector's companies on the latest session." },
  { key: "movers-nse", title: "Top gainers & losers (all NSE)", note: "Every NSE equity ranked by the session's move." },
  { key: "movers-bse", title: "Top gainers & losers (all BSE)", note: "Every BSE equity ranked by the session's move." },
];

const GROUPS: { title: string; keys: string[] }[] = [
  { title: "Equity market", keys: ["pre-open", "gainers", "losers", "volume-gainers", "52w-high", "52w-low"] },
  { title: "Price bands & deals", keys: ["upper-band", "lower-band", "block-deals"] },
  { title: "Other segments", keys: ["etf", "sme", "sgb", "oi-spurts"] },
];

export default function MarketDataPage() {
  const { data, error, loading, reload } = useApi<Catalogue>("/api/live");
  const byKey = new Map((data?.modules ?? []).map((m) => [m.key, m]));

  return (
    <>
      <PageTitle title="Market data" subtitle="Live exchange feeds and views computed from stored prices." />
      {error && <Card><ErrorNote message={error} onRetry={reload} /></Card>}
      {loading && !data && <Card><Loading rows={8} /></Card>}
      <div className="space-y-6">
        {data && GROUPS.map((g) => (
          <Card key={g.title}>
            <CardHeader title={g.title} actions={<Badge tone="up"><Radio size={11} className="mr-1" /> Live from NSE</Badge>} />
            <CardBody className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {g.keys.map((k) => byKey.get(k)).filter(Boolean).map((m) => (
                <Link key={m!.key} href={`/market-data/${m!.key}`}
                  className="group flex items-start justify-between gap-3 rounded-2xl border border-slate-200 p-4 transition hover:border-indigo-300 hover:shadow-md dark:border-slate-800">
                  <div>
                    <p className="font-semibold">{m!.title}</p>
                    <p className="mt-1 text-sm text-slate-500">{m!.note || "Current exchange snapshot."}</p>
                  </div>
                  <ChevronRight size={16} className="mt-1 shrink-0 text-slate-300 group-hover:text-indigo-500" />
                </Link>
              ))}
            </CardBody>
          </Card>
        ))}
        <Card>
          <CardHeader title="Computed from stored prices" actions={<Badge tone="brand"><BarChart3 size={11} className="mr-1" /> End of day</Badge>} />
          <CardBody className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {COMPUTED.map((m) => (
              <Link key={m.key} href={`/market-data/${m.key}`}
                className="group rounded-2xl border border-slate-200 p-4 transition hover:border-indigo-300 hover:shadow-md dark:border-slate-800">
                <p className="font-semibold">{m.title}</p>
                <p className="mt-1 text-sm text-slate-500">{m.note}</p>
              </Link>
            ))}
          </CardBody>
        </Card>
      </div>
    </>
  );
}
