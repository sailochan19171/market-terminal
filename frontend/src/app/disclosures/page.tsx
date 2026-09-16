import type { Metadata } from "next";
import Link from "next/link";
import { Card, CardBody, CardHeader } from "@/components/ui";
import { SITE_DISCLAIMER } from "@/components/Disclosure";

export const metadata: Metadata = {
  title: "How our analysis works, and its limits",
  description: "What Market Terminal computes, what AI is used for, where the data comes from, and what this site is not.",
};

const SECTIONS: { title: string; body: React.ReactNode }[] = [
  {
    title: "What this site is, and is not",
    body: (
      <>
        <p>Market Terminal is a research and educational tool built on data the exchanges publish. It explains what filed
          figures say and what well-known valuation methods make of them.</p>
        <p className="mt-2">It is <strong>not</strong> a SEBI-registered research analyst or investment adviser. It does not issue
          buy, sell or hold calls, price targets, model portfolios or entry and exit levels, and it gives no personalised advice.
          Under the SEBI (Research Analysts) Regulations, 2014 as amended by the Third Amendment Regulations, 2024 and the
          circular of 8 January 2025, those activities require registration, which this platform does not hold. A verdict such as
          &ldquo;screens undervalued&rdquo; describes how a company reads on a published formula &mdash; it is not a call to act.</p>
      </>
    ),
  },
  {
    title: "Where the AI is, and where it is not",
    body: (
      <>
        <p>AI is used in exactly one place: writing the plain-English answers in the company question box, and only from
          material retrieved beforehand from that company&apos;s filings and results. The model is instructed to use nothing but
          the supplied sources, to cite each claim, and to say when the sources do not answer the question. Every claim that
          cannot be traced to a retrieved source is dropped before you see it.</p>
        <p className="mt-2">Nothing else on the site is AI-written. The valuation verdicts, scores, risk flags and observations
          are arithmetic on filed figures: the same inputs always produce the same output, and every input is shown beside it.
          When no AI key is configured, the answers fall back to the same rule-based assembly of cited filings.</p>
        <p className="mt-2">We are responsible for what our AI produces, including when the underlying model is a third
          party&apos;s. AI output can be incomplete, stale or wrong &mdash; the citations are there so you can check it against
          the filing rather than trust the summary.</p>
      </>
    ),
  },
  {
    title: "Where the numbers come from",
    body: (
      <>
        <p>Prices are end-of-day, from the exchange bhavcopy files. Financial figures come from companies&apos; own XBRL
          filings to NSE and BSE; announcements, results, board meetings, corporate actions, insider trades and shareholding
          patterns come from the exchanges&apos; published feeds.</p>
        <p className="mt-2">Every price surface carries the moment it is good for and whether it is live or end of day.
          Real-time display of NSE prices on a public website requires a licence that runs to tens of lakhs of rupees a year;
          we do not hold one, so the public site is end-of-day by design and says so.</p>
        <p className="mt-2">Where a figure is not in the filings, the site says &ldquo;data unavailable&rdquo; and explains why.
          It never fills a gap with an estimate that looks like a fact.</p>
      </>
    ),
  },
  {
    title: "What the valuation models can and cannot do",
    body: (
      <>
        <p>Several independent methods are run side by side &mdash; Peter Lynch&apos;s dividend-adjusted rule, PEG, the Graham
          number, a discounted cash flow, enterprise-value and price-to-book multiples, and the company&apos;s P/E against its
          sector and its own history. They frequently disagree, and the site shows the disagreement rather than hiding it
          behind one number.</p>
        <p className="mt-2">Every one of them depends on assumptions, above all the future growth rate. That input is visible
          and adjustable, and growth is capped at 25% a year because no company compounds faster for long. Models are
          suppressed where they do not apply: a loss-maker has no P/E, a bank is a poor fit for Lynch&apos;s rule, and a
          cyclical company&apos;s trailing earnings mislead at the top and bottom of its cycle.</p>
        <p className="mt-2">Forward-looking inputs are estimates, never facts. Past growth is not a forecast.</p>
      </>
    ),
  },
  {
    title: "News, filings and copyright",
    body: (
      <p>Filings are linked to the exchange&apos;s own document. Where headlines are shown, only the headline, a short extract
        and a link to the publisher are stored; full articles are never re-hosted. Summaries are our own description of the
        material, not a reproduction of it.</p>
    ),
  },
  {
    title: "Mistakes",
    body: (
      <p>Parsing thousands of filings produces errors. If a figure here disagrees with the source document, the source
        document is right. Every number links to its filing for exactly that reason.</p>
    ),
  },
];

export default function DisclosuresPage() {
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-400">Disclosures</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight sm:text-3xl">How our analysis works, and its limits</h1>
        <p className="mt-3 rounded-xl border border-amber-200 bg-amber-50/60 px-4 py-3 text-sm text-amber-900 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-200">
          {SITE_DISCLAIMER}
        </p>
      </div>
      {SECTIONS.map((s) => (
        <Card key={s.title}>
          <CardHeader title={s.title} />
          <CardBody className="text-sm leading-relaxed text-slate-600 dark:text-slate-300">{s.body}</CardBody>
        </Card>
      ))}
      <p className="text-sm text-slate-500">
        Questions about a figure? Open the filing linked beside it, or start from the{" "}
        <Link href="/filings" className="text-indigo-700 underline underline-offset-2 dark:text-indigo-300">announcements feed</Link>.
      </p>
    </div>
  );
}
