"use client";

// The research assistant on a page of its own, rather than buried at the foot of a company's research.
//
// It always has one company in view, because every answer is drawn from that company's filings - but a question
// that names another ("how is Infosys doing?") moves to it, and the picker at the top does the same deliberately.
import { Building2, Sparkles } from "lucide-react";
import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { CompanySelect } from "@/components/dashboard/Controls";
import { AiDisclosure } from "@/components/Disclosure";
import { Ask } from "@/components/research/Ask";
import { Library } from "@/components/research/Library";
import { Card, CardBody, Skeleton } from "@/components/ui";
import { useApi } from "@/lib/api";

interface Identity { key: string; symbol: string | null; bseCode: string | null; company: string }

const EXAMPLES = [
  "How did the last quarter go, and why did profit move?",
  "How much debt does it carry, and is the cash flow covering it?",
  "Who owns it, and has the promoter holding changed?",
  "Is it cheap or expensive against its own history and its peers?",
  "What did it file with the exchanges this month?",
];

function Assistant() {
  const search = useSearchParams();
  const router = useRouter();
  const symbol = (search.get("company") ?? "RELIANCE").toUpperCase();
  const [tab, setTab] = useState<"ask" | "library">("ask");
  const { data } = useApi<{ identity: Identity }>(`/api/v2/company/${encodeURIComponent(symbol)}/dashboard?range=1M`);
  const company = data?.identity.company ?? null;

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <div>
        <p className="inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-indigo-600 dark:text-indigo-300">
          <Sparkles size={14} aria-hidden /> Research assistant
        </p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight sm:text-3xl">Ask about any listed company</h1>
        <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
          Answers come from that company&apos;s own filings to NSE and BSE, the figures parsed out of them, and any
          document you add. Every number carries the source it came from.
        </p>
      </div>

      <Card>
        <CardBody className="flex flex-wrap items-center gap-3">
          <Building2 size={16} className="text-slate-400" aria-hidden />
          <span className="text-sm text-slate-500">Company in view</span>
          <CompanySelect
            current={{ key: symbol, company: company ?? symbol, symbol: data?.identity.symbol ?? symbol, bseCode: data?.identity.bseCode ?? null }}
            onSelect={(key) => router.replace(`/assistant?company=${encodeURIComponent(key)}`, { scroll: false })}
          />
          <div className="ml-auto inline-flex rounded-xl border border-slate-200 bg-slate-50 p-0.5 dark:border-slate-700 dark:bg-slate-800/60">
            {(["ask", "library"] as const).map((t) => (
              <button key={t} type="button" onClick={() => setTab(t)}
                className={`rounded-lg px-3 py-1.5 text-sm font-medium transition ${tab === t ? "bg-white text-slate-900 shadow-sm dark:bg-slate-900 dark:text-white" : "text-slate-500"}`}>
                {t === "ask" ? "Ask" : "Documents"}
              </button>
            ))}
          </div>
        </CardBody>
      </Card>

      {!data && <Skeleton className="h-64 w-full" />}
      {data && tab === "ask" && <Ask symbol={data.identity.key} company={company} />}
      {data && tab === "library" && <Library symbol={data.identity.key} company={company} />}

      {tab === "ask" && (
        <Card>
          <CardBody>
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Things worth asking</p>
            <ul className="mt-2 space-y-1.5">
              {EXAMPLES.map((e) => <li key={e} className="text-sm text-slate-600 dark:text-slate-300">{e}</li>)}
            </ul>
            <AiDisclosure kind="ai" className="mt-4" />
          </CardBody>
        </Card>
      )}
    </div>
  );
}

export default function AssistantPage() {
  return <Suspense fallback={<Skeleton className="h-96 w-full" />}><Assistant /></Suspense>;
}
