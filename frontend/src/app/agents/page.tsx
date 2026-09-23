"use client";

// The analyst workspace. `?q=` runs a question on arrival and `?company=` sets the company in view - the company
// dashboard links here with both.
import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { Workspace } from "@/components/agents/Workspace";

function AgentsPage() {
  const search = useSearchParams();
  return <Workspace initialQuestion={search.get("q")} initialSymbol={search.get("company")?.toUpperCase() ?? null} />;
}

export default function Page() {
  return <Suspense fallback={null}><AgentsPage /></Suspense>;
}
