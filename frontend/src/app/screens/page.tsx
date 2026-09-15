"use client";

import { ChevronRight, Plus } from "lucide-react";
import Link from "next/link";
import { Badge, Button, Card, CardBody, CardHeader, ErrorNote, Loading, PageTitle } from "@/components/ui";
import { useApi } from "@/lib/api";
import type { ScreensMeta } from "@/lib/types";

export default function ScreensPage() {
  const { data, error, loading, reload } = useApi<ScreensMeta>("/api/v2/screens");

  return (
    <>
      <PageTitle title="Stock screens" subtitle="Ready-made screens and sector lists, run against every NSE-listed company."
        actions={<Button variant="primary" href="/screens/custom"><Plus size={16} /> Create a screen</Button>} />

      {error && <Card><ErrorNote message={error} onRetry={reload} /></Card>}
      {loading && !data && <Card><Loading rows={8} /></Card>}

      {data && (
        <div className="grid gap-6 lg:grid-cols-3">
          <Card className="lg:col-span-2">
            <CardHeader title="Popular themes" subtitle="Each screen shows its exact rules on the results page" />
            <CardBody className="grid gap-3 sm:grid-cols-2">
              {data.screens.map((s) => (
                <Link key={s.key} href={`/screens/${s.key}`}
                  className="group flex flex-col rounded-2xl border border-slate-200 p-4 transition hover:-translate-y-0.5 hover:border-indigo-300 hover:shadow-md dark:border-slate-800 dark:hover:border-indigo-500/50">
                  <div className="flex items-center justify-between gap-2">
                    <Badge tone="brand">{s.theme}</Badge>
                    <ChevronRight size={16} className="text-slate-300 transition group-hover:translate-x-0.5 group-hover:text-indigo-500" />
                  </div>
                  <p className="mt-3 font-semibold text-slate-900 dark:text-white">{s.title}</p>
                  <p className="mt-1 line-clamp-2 text-sm text-slate-500">{s.description}</p>
                </Link>
              ))}
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Browse sectors" subtitle={`${data.sectors.length} sectors`} />
            <CardBody className="flex flex-wrap gap-2">
              {data.sectors.map((s) => (
                <Link key={s.name} href={`/screens/custom?sector=${encodeURIComponent(s.name)}`}
                  className="rounded-xl border border-slate-200 px-3 py-1.5 text-sm text-slate-700 transition hover:border-indigo-300 hover:bg-indigo-50 hover:text-indigo-700 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-indigo-500/10">
                  {s.name} <span className="text-xs text-slate-400">{s.companies}</span>
                </Link>
              ))}
            </CardBody>
          </Card>
        </div>
      )}
    </>
  );
}
