"use client";

import { RotateCcw } from "lucide-react";
import Link from "next/link";
import { useEffect } from "react";
import { AnalysisIllustration } from "@/components/Illustrations";

/** Shown if a page throws while rendering, instead of a blank screen. */
export default function PageError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error("page error", error);
  }, [error]);
  return (
    <div className="motion-rise mx-auto max-w-xl rounded-3xl border border-slate-200 bg-white p-8 text-center dark:border-slate-800 dark:bg-slate-900" role="alert">
      <div className="mx-auto w-56 text-slate-400"><AnalysisIllustration /></div>
      <h1 className="mt-4 text-xl font-semibold">This view hit a problem</h1>
      <p className="mt-2 text-sm text-slate-500">
        Something went wrong while showing this page. Your data is safe; trying again usually fixes it.
      </p>
      <div className="mt-5 flex justify-center gap-2">
        <button onClick={reset} className="inline-flex items-center gap-2 rounded-xl bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500">
          <RotateCcw size={15} /> Try again
        </button>
        <Link href="/" className="rounded-xl border border-slate-200 px-4 py-2 text-sm font-semibold hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800">Go home</Link>
      </div>
    </div>
  );
}
