"use client";

// The analyst agents' own app shell: a full-screen workspace with its own navigation, separate from the market
// site's header and footer, so the multi-agent system reads as the product it is.
import clsx from "clsx";
import { ArrowLeft, Bot, Workflow } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { BrandMark } from "@/components/BrandMark";
import { ThemeToggle } from "@/components/Header";
import { SignIn } from "@/components/SignIn";

const NAV = [
  { href: "/agents", label: "Workspace", icon: Bot },
  { href: "/agents/traces", label: "Traces", icon: Workflow },
];

export function AgentShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-slate-100 text-slate-900 dark:bg-[#0b1020] dark:text-slate-100">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-slate-200 bg-white px-3 sm:px-4 dark:border-slate-800 dark:bg-[#0e1428]">
        <Link href="/agents" className="flex shrink-0 items-center gap-2">
          <BrandMark size={30} />
          <span className="hidden leading-tight sm:block">
            <span className="block text-[14px] font-semibold tracking-tight">Analyst Agents</span>
            <span className="block text-[10px] font-medium uppercase tracking-[0.14em] text-slate-400">Market Terminal · India + US</span>
          </span>
        </Link>
        <nav aria-label="Agents" className="ml-2 flex items-center gap-1">
          {NAV.map((n) => {
            const active = n.href === "/agents" ? pathname === "/agents" : pathname.startsWith(n.href);
            return (
              <Link key={n.href} href={n.href}
                className={clsx("inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm font-medium transition",
                  active ? "bg-indigo-50 text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300" : "text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800")}>
                <n.icon size={15} aria-hidden /> <span className="hidden sm:inline">{n.label}</span>
              </Link>
            );
          })}
        </nav>
        <div className="ml-auto flex items-center gap-1.5">
          <Link href="/" className="hidden items-center gap-1 rounded-lg px-2.5 py-1.5 text-sm text-slate-500 transition hover:bg-slate-100 hover:text-slate-900 md:inline-flex dark:hover:bg-slate-800 dark:hover:text-white">
            <ArrowLeft size={14} /> Market Terminal
          </Link>
          <ThemeToggle />
          <SignIn />
        </div>
      </header>
      <div className="min-h-0 flex-1">{children}</div>
    </div>
  );
}
