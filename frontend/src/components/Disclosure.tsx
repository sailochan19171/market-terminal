// Labels and disclaimers required of a platform that is not a SEBI-registered research analyst.
//
// Two rules drive this file. First, the SEBI (Research Analysts) (Third Amendment) Regulations, 2024 and the
// circular of 8 January 2025 make buy/sell/hold calls, price targets and model portfolios the preserve of
// registered analysts - so nothing here may read as a call to action, and every computed or generated block
// says what produced it. Second, the same amendment requires the extent of AI use to be disclosed, and holds
// the platform responsible for its own AI output. Hence: a label on every such block, and one page explaining
// the whole machine.
import Link from "next/link";
import { Cpu, Info, Sigma } from "lucide-react";

export type BlockKind = "computed" | "ai" | "retrieval";

const TEXT: Record<BlockKind, { icon: typeof Info; label: string; body: string }> = {
  computed: {
    icon: Sigma, label: "Computed, not advice",
    body: "Calculated by formula from filed figures. The inputs and the arithmetic are shown so you can check them. Educational only - not investment advice, and not a recommendation to buy, sell or hold.",
  },
  ai: {
    icon: Cpu, label: "AI-generated",
    body: "Written by an AI model from the sources cited beside it, and nothing else. It may be incomplete, out of date or wrong - open the filings and judge for yourself. Educational only, not investment advice.",
  },
  retrieval: {
    icon: Info, label: "Assembled from filings",
    body: "Selected and summarised from exchange filings and published results, each one cited. No figure here is estimated. Educational only, not investment advice.",
  },
};

/** The label that sits under any computed, retrieved or AI-written block. */
export function AiDisclosure({ kind = "ai", className }: { kind?: BlockKind; className?: string }) {
  const t = TEXT[kind];
  const Icon = t.icon;
  return (
    <p className={`flex gap-2 rounded-xl bg-slate-50 px-3 py-2 text-[11px] leading-relaxed text-slate-500 dark:bg-slate-900/60 dark:text-slate-400 ${className ?? ""}`}>
      <Icon size={13} className="mt-0.5 shrink-0" aria-hidden />
      <span><span className="font-semibold text-slate-600 dark:text-slate-300">{t.label}.</span> {t.body}{" "}
        <Link href="/disclosures" className="underline underline-offset-2 hover:text-indigo-600">How this works and its limits</Link>.
      </span>
    </p>
  );
}

/** The site-wide risk warning, shown in the footer and at the head of the disclosures page. */
export const SITE_DISCLAIMER =
  "Market Terminal is a research and educational tool. Nothing here is investment advice or a recommendation to buy or sell any security. "
  + "Investments in securities are subject to market risk; read all related documents carefully.";
