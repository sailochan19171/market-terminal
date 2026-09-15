"use client";

import clsx from "clsx";
import {
  Activity, BarChart3, Bell, BookOpen, Briefcase, Building2, CalendarDays, ChevronDown, CircleDollarSign, FileBarChart,
  FileText, Flame, Gauge, Grid3x3, Layers, LineChart, ListFilter, Menu, Moon, PieChart, Search, Star, Sun, TrendingUp,
  UserCheck, Users, X, type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { BrandMark } from "@/components/BrandMark";
import { startRouteProgress } from "@/components/RouteProgress";
import { useEffect, useRef, useState } from "react";
import { api, useApi } from "@/lib/api";
import { num, pct, tone } from "@/lib/format";

interface SearchResult {
  companies: { key: string; symbol: string | null; bseCode: string | null; company: string; industry: string | null; close: number | null; pct_1d: number | null }[];
  indices: { index_name: string; display_name: string }[];
}
interface TickerItem { name: string; label: string; value: number; change: number; pct: number; exchange: "NSE" | "BSE"; href: string }
interface Ticker { nse: { session: string; items: TickerItem[] }; bse: { session: string; asOf: string; items: TickerItem[] } }

interface MenuItem { href: string; label: string; description: string; icon: LucideIcon }
interface MenuGroup { label: string; match: string[]; sections: { title: string; items: MenuItem[] }[]; feature?: { title: string; text: string; href: string } }

// Our own information architecture, organised the way exchange sites group their pages.
const MENU: MenuGroup[] = [
  {
    label: "Markets", match: ["/markets", "/market-data", "/heatmap"],
    sections: [
      { title: "Equity", items: [
        { href: "/markets", label: "Market summary", description: "Session totals, breadth and turnover by segment", icon: Gauge },
        { href: "/markets?tab=watch", label: "Market watch", description: "Every traded security, filter and sort", icon: ListFilter },
        { href: "/markets?tab=watch&move=gainers&series=EQUITY", label: "Gainers and losers", description: "Biggest movers of the session", icon: TrendingUp },
        { href: "/markets?tab=watch&move=high52&series=EQUITY", label: "52-week highs", description: "Stocks closing near yearly highs", icon: Flame },
      ] },
      { title: "Analytics", items: [
        { href: "/heatmap", label: "Heatmap", description: "Index members sized by market cap", icon: Grid3x3 },
        { href: "/market-data/breadth", label: "Advances and declines", description: "Breadth over time", icon: BarChart3 },
        { href: "/market-data/sectors", label: "Sector performance", description: "How each sector moved", icon: PieChart },
        { href: "/market-data", label: "Exchange feeds", description: "Pre-open, most active, block deals", icon: Activity },
      ] },
    ],
    feature: { title: "BSE and NSE side by side", text: "Switch any market view between the two exchanges.", href: "/markets?exchange=BSE" },
  },
  {
    label: "Indices", match: ["/indices"],
    sections: [
      { title: "Indices", items: [
        { href: "/indices", label: "All indices", description: "Broad, sectoral and thematic NSE indices", icon: LineChart },
        { href: "/indices/NIFTY 50", label: "NIFTY 50", description: "Chart, valuation and constituents", icon: TrendingUp },
        { href: "/indices/NIFTY BANK", label: "NIFTY Bank", description: "Banking index detail", icon: Building2 },
        { href: "/markets?exchange=BSE", label: "BSE market", description: "SENSEX, BANKEX and BSE turnover", icon: Gauge },
      ] },
    ],
  },
  {
    label: "Corporates", match: ["/filings", "/results", "/corporate-actions", "/board-meetings", "/shareholding", "/insider"],
    sections: [
      { title: "Disclosures", items: [
        { href: "/filings", label: "Announcements", description: "Every NSE and BSE filing, searchable", icon: FileText },
        { href: "/results", label: "Financial results", description: "Latest quarter, growth and margins", icon: FileBarChart },
        { href: "/board-meetings", label: "Board meetings", description: "Upcoming results, dividends, fund raising", icon: CalendarDays },
      ] },
      { title: "Actions and ownership", items: [
        { href: "/corporate-actions", label: "Corporate actions", description: "Dividends, bonus, splits, rights", icon: CircleDollarSign },
        { href: "/shareholding", label: "Shareholding changes", description: "Promoter, FII and DII moves", icon: Users },
        { href: "/insider", label: "Insider trading", description: "Disclosed trades by insiders", icon: UserCheck },
      ] },
    ],
  },
  {
    label: "Research", match: ["/screens", "/analyses", "/company"],
    sections: [
      { title: "Research", items: [
        { href: "/screens", label: "Stock screens", description: "Ready-made and custom screens", icon: ListFilter },
        { href: "/analyses", label: "Completed analyses", description: "Stored company analyses and versions", icon: Layers },
        { href: "/company/RELIANCE", label: "Company dashboard", description: "Summary and detailed analysis for any company", icon: BookOpen },
      ] },
    ],
  },
  {
    label: "Investors", match: ["/portfolio", "/watchlist", "/alerts"],
    sections: [
      { title: "Your space", items: [
        { href: "/portfolio", label: "Portfolio", description: "Holdings, allocation and gains", icon: Briefcase },
        { href: "/watchlist", label: "Watchlist", description: "Companies you follow", icon: Star },
        { href: "/alerts", label: "Alerts", description: "Rules on prices and filings", icon: Bell },
      ] },
    ],
  },
];

function ThemeToggle() {
  const [dark, setDark] = useState(false);
  useEffect(() => {
    let stored: string | null = null;
    try { stored = localStorage.getItem("theme"); } catch { /* storage blocked */ }
    const on = stored ? stored === "dark" : window.matchMedia("(prefers-color-scheme: dark)").matches;
    document.documentElement.classList.toggle("dark", on);
    setDark(on);
  }, []);
  const flip = () => {
    const on = !dark;
    document.documentElement.classList.toggle("dark", on);
    try { localStorage.setItem("theme", on ? "dark" : "light"); } catch { /* ignore */ }
    setDark(on);
  };
  return (
    <button onClick={flip} aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}
      className="rounded-xl p-2 text-slate-500 transition hover:bg-slate-100 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-white">
      {dark ? <Sun size={18} /> : <Moon size={18} />}
    </button>
  );
}

function SearchBox() {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [res, setRes] = useState<SearchResult | null>(null);
  const [cursor, setCursor] = useState(0);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!q.trim()) { setRes(null); return; }
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      api<SearchResult>(`/api/v2/search?q=${encodeURIComponent(q.trim())}`, { signal: ctrl.signal }).then((r) => { setRes(r); setCursor(0); }).catch(() => {});
    }, 180);
    return () => { clearTimeout(t); ctrl.abort(); };
  }, [q]);

  useEffect(() => {
    const close = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  const items = [
    ...(res?.companies ?? []).map((c) => ({
      href: `/company/${encodeURIComponent(c.key)}`, primary: c.symbol ?? `BSE ${c.bseCode}`,
      secondary: c.symbol && c.bseCode ? `${c.company} · BSE ${c.bseCode}` : c.company, meta: c,
    })),
    ...(res?.indices ?? []).map((i) => ({ href: `/indices/${encodeURIComponent(i.index_name)}`, primary: i.display_name, secondary: "Index", meta: null })),
  ];
  const go = (href: string) => { setOpen(false); setQ(""); startRouteProgress(href); router.push(href); };

  return (
    <div ref={box} className="relative w-full max-w-xl">
      <Search size={16} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400" />
      <input value={q} onChange={(e) => { setQ(e.target.value); setOpen(true); }} onFocus={() => setOpen(true)}
        aria-label="Search companies and indices"
        onKeyDown={(e) => {
          if (!items.length) return;
          if (e.key === "ArrowDown") { e.preventDefault(); setCursor((c) => Math.min(c + 1, items.length - 1)); }
          if (e.key === "ArrowUp") { e.preventDefault(); setCursor((c) => Math.max(c - 1, 0)); }
          if (e.key === "Enter") { e.preventDefault(); go(items[cursor].href); }
          if (e.key === "Escape") setOpen(false);
        }}
        placeholder="Search company, NSE symbol, BSE code or index"
        className="w-full rounded-xl border border-slate-200 bg-slate-50 py-2.5 pl-10 pr-4 text-sm outline-none transition placeholder:text-slate-400 focus:border-indigo-400 focus:bg-white focus:ring-4 focus:ring-indigo-100 dark:border-slate-700 dark:bg-slate-800/60 dark:focus:bg-slate-900 dark:focus:ring-indigo-500/20" />
      {open && q.trim() && (
        <div className="menu-panel absolute left-0 right-0 top-full z-50 mt-2 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-xl dark:border-slate-700 dark:bg-slate-900">
          {items.length === 0 ? <p className="px-4 py-6 text-center text-sm text-slate-500">No matches for “{q}”.</p> : items.map((it, i) => (
            <button key={it.href} onMouseEnter={() => setCursor(i)} onClick={() => go(it.href)}
              className={clsx("flex w-full items-center justify-between gap-3 px-4 py-2.5 text-left", i === cursor && "bg-slate-50 dark:bg-slate-800")}>
              <span className="min-w-0">
                <span className="block text-sm font-semibold text-slate-900 dark:text-white">{it.primary}</span>
                <span className="block truncate text-xs text-slate-500">{it.secondary}</span>
              </span>
              {it.meta && it.meta.close != null && (
                <span className="tabular shrink-0 text-right text-xs">
                  <span className="block font-semibold">{num(it.meta.close)}</span>
                  <span className={tone(it.meta.pct_1d)}>{pct(it.meta.pct_1d)}</span>
                </span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function TickerStrip() {
  const { data } = useApi<Ticker>("/api/v2/market/ticker");
  const items = [...(data?.bse.items ?? []), ...(data?.nse.items ?? [])];
  if (!items.length) return <div className="h-10 border-t border-slate-100 dark:border-slate-800" />;
  const loop = [...items, ...items];
  return (
    <div className="flex h-10 items-stretch border-t border-slate-100 bg-slate-50/80 text-xs dark:border-slate-800 dark:bg-slate-900/60">
      <div className="relative flex-1 overflow-hidden" aria-label="Index values at the last close">
        <div className="animate-ticker flex h-full w-max items-center">
          {loop.map((t, i) => (
            <Link key={`${t.name}-${i}`} href={t.href} aria-hidden={i >= items.length} tabIndex={i >= items.length ? -1 : 0}
              className="flex items-center gap-2 border-r border-slate-200 px-4 hover:bg-white dark:border-slate-800 dark:hover:bg-slate-800">
              <span className="font-semibold text-indigo-700 dark:text-indigo-300">{t.label}</span>
              <span className="tabular font-semibold text-slate-800 dark:text-slate-100">{num(t.value)}</span>
              <span className={clsx("tabular font-semibold", tone(t.pct))}>{t.change >= 0 ? "▲" : "▼"} {num(Math.abs(t.change))} ({pct(t.pct)})</span>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}

function MegaMenu({ group, active, open, onOpen, onClose }: { group: MenuGroup; active: boolean; open: boolean; onOpen: () => void; onClose: () => void }) {
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancel = () => { if (closeTimer.current) clearTimeout(closeTimer.current); };
  return (
    <div className="relative" onMouseEnter={() => { cancel(); onOpen(); }} onMouseLeave={() => { closeTimer.current = setTimeout(onClose, 120); }}>
      <button type="button" aria-expanded={open} aria-haspopup="true" onClick={() => (open ? onClose() : onOpen())}
        onKeyDown={(e) => { if (e.key === "Escape") onClose(); }}
        className={clsx("relative flex items-center gap-1 whitespace-nowrap px-3 py-3 text-sm font-semibold transition",
          active || open ? "text-indigo-700 dark:text-indigo-300" : "text-slate-600 hover:text-slate-900 dark:text-slate-300 dark:hover:text-white")}>
        {group.label}
        <ChevronDown size={14} className={clsx("transition-transform", open && "rotate-180")} />
        {active && <span className="absolute inset-x-3 -bottom-px h-0.5 rounded-full bg-indigo-600 dark:bg-indigo-400" />}
      </button>
      {open && (
        <div className="menu-panel absolute left-0 top-full z-50 pt-1" onKeyDown={(e) => { if (e.key === "Escape") onClose(); }}>
          <div className="flex overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl dark:border-slate-700 dark:bg-slate-900">
            <div className={clsx("grid gap-x-2 p-3", group.sections.length > 1 ? "grid-cols-2 w-[36rem]" : "w-72")}>
              {group.sections.map((s) => (
                <div key={s.title}>
                  <p className="px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wider text-slate-400">{s.title}</p>
                  <ul className="motion-stagger">
                    {s.items.map((it) => (
                      <li key={it.href}>
                        <Link href={it.href} onClick={onClose} className="group flex gap-3 rounded-xl px-3 py-2.5 transition hover:bg-indigo-50 dark:hover:bg-indigo-500/10">
                          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-indigo-50 text-indigo-600 transition group-hover:scale-105 group-hover:bg-indigo-600 group-hover:text-white dark:bg-indigo-500/15 dark:text-indigo-300">
                            <it.icon size={17} />
                          </span>
                          <span className="min-w-0">
                            <span className="block text-sm font-semibold text-slate-800 dark:text-slate-100">{it.label}</span>
                            <span className="block text-xs text-slate-500">{it.description}</span>
                          </span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
            {group.feature && (
              <Link href={group.feature.href} onClick={onClose} className="hero-surface hidden w-52 flex-col justify-end p-4 lg:flex">
                <p className="text-sm font-semibold text-slate-900 dark:text-white">{group.feature.title}</p>
                <p className="mt-1 text-xs text-slate-600 dark:text-slate-300">{group.feature.text}</p>
              </Link>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function MobileMenu({ onClose }: { onClose: () => void }) {
  const [openGroup, setOpenGroup] = useState<string | null>("Markets");
  return (
    <div className="fixed inset-0 z-50 lg:hidden" role="dialog" aria-modal="true" aria-label="Site menu">
      <button className="motion-fade absolute inset-0 bg-slate-900/40" aria-label="Close menu" onClick={onClose} />
      <nav className="motion-rise absolute inset-y-0 left-0 w-[min(22rem,90vw)] overflow-y-auto bg-white p-4 shadow-2xl dark:bg-slate-950">
        <div className="mb-3 flex items-center justify-between">
          <span className="font-semibold">Menu</span>
          <button onClick={onClose} aria-label="Close menu" className="rounded-lg p-2 hover:bg-slate-100 dark:hover:bg-slate-800"><X size={18} /></button>
        </div>
        <Link href="/" onClick={onClose} className="block rounded-xl px-3 py-2.5 font-semibold hover:bg-slate-50 dark:hover:bg-slate-900">Home</Link>
        {MENU.map((g) => (
          <div key={g.label} className="border-t border-slate-100 dark:border-slate-800">
            <button className="flex w-full items-center justify-between px-3 py-3 font-semibold" aria-expanded={openGroup === g.label}
              onClick={() => setOpenGroup(openGroup === g.label ? null : g.label)}>
              {g.label}<ChevronDown size={16} className={clsx("transition-transform", openGroup === g.label && "rotate-180")} />
            </button>
            {openGroup === g.label && (
              <ul className="motion-fade pb-2">
                {g.sections.flatMap((s) => s.items).map((it) => (
                  <li key={it.href}>
                    <Link href={it.href} onClick={onClose} className="flex items-center gap-3 rounded-xl px-3 py-2 text-sm hover:bg-indigo-50 dark:hover:bg-indigo-500/10">
                      <it.icon size={16} className="text-indigo-600 dark:text-indigo-300" /> {it.label}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </nav>
    </div>
  );
}

export function Header() {
  const pathname = usePathname();
  const [open, setOpen] = useState<string | null>(null);
  const [mobile, setMobile] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => { setOpen(null); setMobile(false); }, [pathname]);
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
  const isActive = (g: MenuGroup) => g.match.some((m) => pathname.startsWith(m));

  return (
    <header className={clsx("sticky top-0 z-40 border-b bg-white/90 backdrop-blur transition-shadow supports-[backdrop-filter]:bg-white/80 dark:bg-slate-950/85",
      scrolled ? "border-slate-200 shadow-[0_6px_20px_-12px_rgba(15,23,42,0.25)] dark:border-slate-800" : "border-slate-200 dark:border-slate-800")}>
      <div className="mx-auto flex h-16 max-w-[1400px] items-center gap-3 px-4 sm:px-6">
        <button className="rounded-xl p-2 text-slate-600 hover:bg-slate-100 lg:hidden dark:text-slate-300 dark:hover:bg-slate-800" aria-label="Open menu" onClick={() => setMobile(true)}>
          <Menu size={20} />
        </button>
        <Link href="/" className="group flex shrink-0 items-center gap-2">
          <BrandMark size={38} className="drop-shadow-md transition group-hover:-rotate-3 group-hover:scale-105" />
          <span className="hidden leading-tight sm:block">
            <span className="block text-[15px] font-semibold tracking-tight">Market Terminal</span>
            <span className="block text-[10px] font-medium uppercase tracking-[0.16em] text-slate-400">NSE · BSE research</span>
          </span>
        </Link>
        <div className="flex flex-1 justify-center"><SearchBox /></div>
        <ThemeToggle />
      </div>
      <nav aria-label="Main" className="mx-auto hidden max-w-[1400px] items-center gap-1 px-4 sm:px-6 lg:flex">
        <Link href="/" className={clsx("relative px-3 py-3 text-sm font-semibold transition", pathname === "/" ? "text-indigo-700 dark:text-indigo-300" : "text-slate-600 hover:text-slate-900 dark:text-slate-300 dark:hover:text-white")}>
          Home{pathname === "/" && <span className="absolute inset-x-3 -bottom-px h-0.5 rounded-full bg-indigo-600 dark:bg-indigo-400" />}
        </Link>
        {MENU.map((g) => (
          <MegaMenu key={g.label} group={g} active={isActive(g)} open={open === g.label}
            onOpen={() => setOpen(g.label)} onClose={() => setOpen((o) => (o === g.label ? null : o))} />
        ))}
      </nav>
      <TickerStrip />
      {mobile && <MobileMenu onClose={() => setMobile(false)} />}
    </header>
  );
}

export function Footer() {
  return (
    <footer className="mt-16 border-t border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-950">
      <div className="mx-auto grid max-w-[1400px] gap-8 px-4 py-10 sm:grid-cols-2 sm:px-6 lg:grid-cols-6">
        <div className="lg:col-span-1">
          <p className="flex items-center gap-2 font-semibold"><BrandMark size={26} />Market Terminal</p>
          <p className="mt-2 text-sm text-slate-500">A personal research tool built on exchange-published data. Not affiliated with NSE, BSE or any data vendor.</p>
        </div>
        {MENU.map((g) => (
          <div key={g.label}>
            <p className="text-sm font-semibold">{g.label}</p>
            <ul className="mt-3 space-y-2">
              {g.sections.flatMap((s) => s.items).map((it) => (
                <li key={it.href}><Link href={it.href} className="text-sm text-slate-500 transition hover:text-indigo-600">{it.label}</Link></li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <p className="border-t border-slate-100 py-4 text-center text-xs text-slate-400 dark:border-slate-800">
        End-of-day prices and filings. Figures derived from exchange filings may be incomplete; check the source document.
      </p>
    </footer>
  );
}
