"use client";

// The analyst agents' own app shell: a full-screen workspace with its own navigation, separate from the market
// site's header and footer, so the multi-agent system reads as the product it is.
import clsx from "clsx";
import { ArrowLeft, Bot, Home, LineChart, Menu, PackageCheck, Sparkles, Workflow, X } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { BrandMark } from "@/components/BrandMark";
import { ThemeToggle } from "@/components/Header";
import { SignIn } from "@/components/SignIn";

const NAV = [
  { href: "/agents", label: "Workspace", icon: Bot },
  { href: "/agents/traces", label: "Traces", icon: Workflow },
];

export function AgentShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!mobileOpen) return;
    const orig = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setMobileOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = orig;
      window.removeEventListener("keydown", onKey);
    };
  }, [mobileOpen]);

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-slate-100 text-slate-900 dark:bg-[#0b1020] dark:text-slate-100">
      <header className="flex h-14 shrink-0 items-center gap-2 sm:gap-3 border-b border-slate-200 bg-white px-3 sm:px-4 dark:border-slate-800 dark:bg-[#0e1428]">
        <button
          type="button"
          onClick={() => setMobileOpen(true)}
          className="rounded-xl p-1.5 text-slate-600 hover:bg-slate-100 md:hidden dark:text-slate-300 dark:hover:bg-slate-800"
          aria-label="Open menu"
        >
          <Menu size={18} />
        </button>

        <Link href="/agents" className="flex shrink-0 items-center gap-2">
          <BrandMark size={28} className="sm:size-[30px]" />
          <span className="block leading-tight">
            <span className="block text-[13px] sm:text-[14px] font-semibold tracking-tight">Analyst Agents</span>
            <span className="hidden sm:block text-[10px] font-medium uppercase tracking-[0.14em] text-slate-400">Market Terminal · India + US</span>
          </span>
        </Link>
        <nav aria-label="Agents" className="ml-1 hidden items-center gap-1 md:ml-2 md:flex">
          {NAV.map((n) => {
            const active = n.href === "/agents" ? pathname === "/agents" : pathname.startsWith(n.href);
            return (
              <Link key={n.href} href={n.href}
                className={clsx("inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs sm:text-sm font-medium transition",
                  active ? "bg-indigo-50 text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300" : "text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800")}>
                <n.icon size={15} aria-hidden /> <span>{n.label}</span>
              </Link>
            );
          })}
        </nav>
        <div className="ml-auto flex items-center gap-1 sm:gap-1.5">
          <Link href="/" className="hidden items-center gap-1 rounded-lg px-2.5 py-1.5 text-sm text-slate-500 transition hover:bg-slate-100 hover:text-slate-900 md:inline-flex dark:hover:bg-slate-800 dark:hover:text-white">
            <ArrowLeft size={14} /> Market Terminal
          </Link>
          <ThemeToggle />
          <SignIn />
        </div>
      </header>
      <div className="min-h-0 flex-1">{children}</div>

      {mobileOpen && (
        <div className="fixed inset-0 z-50 md:hidden" role="dialog" aria-modal="true" aria-label="Agents menu">
          <button className="motion-fade fixed inset-0 bg-slate-900/60 backdrop-blur-xs" aria-label="Close menu" onClick={() => setMobileOpen(false)} />
          <nav className="motion-rise relative z-10 flex h-full w-[min(20rem,85vw)] flex-col bg-white shadow-2xl dark:bg-slate-950">
            <div className="flex h-14 shrink-0 items-center justify-between border-b border-slate-100 px-4 dark:border-slate-800">
              <span className="flex items-center gap-2 font-semibold text-sm">
                <BrandMark size={24} /> Analyst Agents
              </span>
              <button onClick={() => setMobileOpen(false)} aria-label="Close menu" className="rounded-xl p-1.5 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800">
                <X size={18} />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-3 space-y-4">
              <div>
                <p className="px-2 pb-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-slate-400">Agents workspace</p>
                <div className="space-y-1">
                  {NAV.map((n) => {
                    const active = n.href === "/agents" ? pathname === "/agents" : pathname.startsWith(n.href);
                    return (
                      <Link key={n.href} href={n.href} onClick={() => setMobileOpen(false)}
                        className={clsx("flex items-center gap-2.5 rounded-xl px-3 py-2 text-sm font-medium transition",
                          active ? "bg-indigo-50 font-semibold text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300" : "text-slate-700 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800")}>
                        <n.icon size={16} className={active ? "text-indigo-600 dark:text-indigo-400" : "text-slate-400"} />
                        {n.label}
                      </Link>
                    );
                  })}
                </div>
              </div>

              <div>
                <p className="px-2 pb-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-slate-400">Market Terminal</p>
                <div className="space-y-1">
                  <Link href="/" onClick={() => setMobileOpen(false)}
                    className="flex items-center gap-2.5 rounded-xl px-3 py-2 text-sm text-slate-700 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800">
                    <Home size={16} className="text-slate-400" /> Home
                  </Link>
                  <Link href="/markets" onClick={() => setMobileOpen(false)}
                    className="flex items-center gap-2.5 rounded-xl px-3 py-2 text-sm text-slate-700 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800">
                    <LineChart size={16} className="text-slate-400" /> Markets
                  </Link>
                  <Link href="/orders" onClick={() => setMobileOpen(false)}
                    className="flex items-center gap-2.5 rounded-xl px-3 py-2 text-sm text-slate-700 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800">
                    <PackageCheck size={16} className="text-slate-400" /> Orders
                  </Link>
                  <Link href="/assistant" onClick={() => setMobileOpen(false)}
                    className="flex items-center gap-2.5 rounded-xl px-3 py-2 text-sm text-slate-700 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800">
                    <Sparkles size={16} className="text-slate-400" /> Ask AI
                  </Link>
                </div>
              </div>
            </div>

            <div className="border-t border-slate-100 p-3 dark:border-slate-800">
              <Link href="/" onClick={() => setMobileOpen(false)}
                className="flex w-full items-center justify-center gap-2 rounded-xl bg-slate-900 py-2.5 text-xs font-semibold text-white shadow-sm transition hover:bg-slate-800 dark:bg-white dark:text-slate-900 dark:hover:bg-slate-100">
                <ArrowLeft size={14} /> Back to Market Terminal
              </Link>
            </div>
          </nav>
        </div>
      )}
    </div>
  );
}
