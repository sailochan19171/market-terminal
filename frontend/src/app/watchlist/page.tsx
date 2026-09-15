"use client";

import clsx from "clsx";
import { CheckCircle2, Plus, Search, Trash2, X, XCircle } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { DataTable } from "@/components/DataTable";
import { Badge, Button, Card, CardBody, CardHeader, ErrorNote, Loading, PageTitle, Pct, Segmented } from "@/components/ui";
import { ApiError, api, post, useApi } from "@/lib/api";
import { dateTime, num } from "@/lib/format";

interface Entry {
  symbol: string; scrip_cd: string | null; exchange: "NSE" | "BSE"; source: string | null; added_at: string;
  name: string | null; nse_symbol: string | null; industry: string | null;
  close: number | null; change: number | null; pct_1d: number | null; pe: number | null;
  market_cap_cr: number | null; ret_1m: number | null; ret_1y: number | null;
  high_52w: number | null; low_52w: number | null; trade_date: string | null;
}
interface Suggestion { symbol: string; company: string; close: number | null; pct_1d: number | null }
interface AddResult { added: number; symbols: string[]; already: string[]; unknown: string[]; error?: string }
type Notice = { tone: "ok" | "error"; text: string } | null;

const key = (e: { symbol: string; exchange: string }) => `${e.exchange}:${e.symbol}`;

function SymbolInput({ value, onChange, onPick, onSubmit, exchange }: {
  value: string; onChange: (v: string) => void; onPick: (s: string) => void; onSubmit: () => void; exchange: string;
}) {
  // Suggest for the token being typed, so "TCS, INF" completes INF.
  const token = value.split(/[,\s]+/).pop() ?? "";
  const [debounced, setDebounced] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(token.trim()), 200);
    return () => clearTimeout(t);
  }, [token]);
  const { data } = useApi<{ companies: Suggestion[] }>(debounced.length >= 1 ? `/api/v2/search?q=${encodeURIComponent(debounced)}` : null);
  const items = debounced ? (data?.companies ?? []).slice(0, 8) : [];

  useEffect(() => {
    const close = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);
  useEffect(() => setActive(0), [debounced]);

  return (
    <div ref={box} className="relative w-full max-w-md">
      <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
      <input value={value} onFocus={() => setOpen(true)}
        onChange={(e) => { onChange(e.target.value); setOpen(true); }}
        onKeyDown={(e) => {
          if (open && items.length && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
            e.preventDefault();
            setActive((a) => (a + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length);
          } else if (e.key === "Enter") {
            e.preventDefault();
            // Enter on a highlighted suggestion completes it; otherwise add what was typed.
            if (open && items.length && token.trim() && items[active]) { onPick(items[active].symbol); setOpen(false); }
            else { onSubmit(); setOpen(false); }
          } else if (e.key === "Escape") setOpen(false);
        }}
        placeholder={exchange === "NSE" ? "Search company or symbol, e.g. RELIANCE, TCS" : "BSE ticker or scrip code, e.g. RELIANCE or 500325"}
        className="w-full rounded-xl border border-slate-200 bg-white py-2 pl-9 pr-3 text-sm outline-none focus:border-indigo-400 dark:border-slate-700 dark:bg-slate-900" />
      {open && items.length > 0 && (
        <ul className="absolute z-40 mt-1 max-h-80 w-full overflow-y-auto rounded-xl border border-slate-200 bg-white py-1 shadow-lg dark:border-slate-700 dark:bg-slate-900">
          {items.map((s, i) => (
            <li key={s.symbol}>
              <button type="button" onMouseDown={(e) => e.preventDefault()} onMouseEnter={() => setActive(i)}
                onClick={() => { onPick(s.symbol); setOpen(false); }}
                className={clsx("flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm", i === active && "bg-indigo-50 dark:bg-indigo-500/10")}>
                <span className="min-w-0">
                  <span className="block font-semibold">{s.symbol}</span>
                  <span className="block truncate text-xs text-slate-500">{s.company}</span>
                </span>
                <span className="shrink-0 text-right">
                  <span className="tabular block">{num(s.close)}</span>
                  <Pct value={s.pct_1d} className="text-xs" />
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function WatchlistPage() {
  const { data, error, loading, reload } = useApi<{ watchlist: Entry[] }>("/api/watchlist");
  const [rows, setRows] = useState<Entry[]>([]);
  const [input, setInput] = useState("");
  const [exchange, setExchange] = useState<"NSE" | "BSE">("NSE");
  const [filter, setFilter] = useState<"all" | "NSE" | "BSE">("all");
  const [move, setMove] = useState<"all" | "up" | "down">("all");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);

  useEffect(() => { if (data) setRows(data.watchlist); }, [data]);
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 6000);
    return () => clearTimeout(t);
  }, [notice]);

  const shown = useMemo(() => rows
    .filter((r) => filter === "all" || r.exchange === filter)
    .filter((r) => move === "all" || (r.pct_1d != null && (move === "up" ? r.pct_1d > 0 : r.pct_1d < 0))), [rows, filter, move]);

  const pick = (symbol: string) => {
    const parts = input.split(/([,\s]+)/);
    parts[parts.length - 1] = symbol;
    setInput(parts.join("") + ", ");
  };

  const add = async () => {
    const symbols = input.split(/[,\s]+/).map((s) => s.trim().toUpperCase()).filter(Boolean);
    if (!symbols.length) { setNotice({ tone: "error", text: "Type at least one symbol to add." }); return; }
    setBusy(true);
    try {
      const r = await post<AddResult>("/api/watchlist", { symbols, exchange });
      const parts = [];
      if (r.added) parts.push(`Added ${r.symbols.join(", ")}`);
      if (r.already.length) parts.push(`already watching ${r.already.join(", ")}`);
      if (r.unknown.length) parts.push(`not found on ${exchange}: ${r.unknown.join(", ")}`);
      setNotice({ tone: r.unknown.length && !r.added ? "error" : "ok", text: parts.join(" · ") || "Nothing changed." });
      setInput("");
      reload();
    } catch (e) {
      setNotice({ tone: "error", text: e instanceof ApiError ? e.message : "Could not reach the server. Is the API running?" });
    } finally {
      setBusy(false);
    }
  };

  const remove = async (items: Entry[]) => {
    if (!items.length) return;
    const gone = new Set(items.map(key));
    const before = rows;
    setRows((rs) => rs.filter((r) => !gone.has(key(r))));   // optimistic
    setSelected((s) => new Set([...s].filter((k) => !gone.has(k))));
    try {
      const r = await api<{ removed: number }>("/api/watchlist", {
        method: "DELETE", body: JSON.stringify({ items: items.map((i) => ({ symbol: i.symbol, exchange: i.exchange })) }),
      });
      setNotice({ tone: "ok", text: `Removed ${r.removed} ${r.removed === 1 ? "company" : "companies"}.` });
      reload();
    } catch (e) {
      setRows(before);
      setNotice({ tone: "error", text: `Remove failed: ${(e as Error).message}` });
    }
  };

  const allShownSelected = shown.length > 0 && shown.every((r) => selected.has(key(r)));
  const toggleAll = () => setSelected(allShownSelected ? new Set() : new Set(shown.map(key)));
  const toggle = (r: Entry) => setSelected((s) => {
    const n = new Set(s);
    if (n.has(key(r))) n.delete(key(r)); else n.add(key(r));
    return n;
  });

  const up = rows.filter((r) => (r.pct_1d ?? 0) > 0).length;
  const down = rows.filter((r) => (r.pct_1d ?? 0) < 0).length;

  return (
    <>
      <PageTitle title="Watchlist" subtitle="Companies you track. Alert rules use this list." />

      <Card className="mb-6">
        <CardHeader title="Add companies" subtitle="Pick from the suggestions or type several symbols separated by commas" />
        <CardBody className="space-y-3">
          <div className="flex flex-wrap items-center gap-3">
            <SymbolInput value={input} onChange={setInput} onPick={pick} onSubmit={add} exchange={exchange} />
            <Segmented size="sm" value={exchange} onChange={setExchange} options={[{ value: "NSE", label: "NSE" }, { value: "BSE", label: "BSE" }]} />
            <Button variant="primary" onClick={add} disabled={busy}><Plus size={15} /> {busy ? "Adding…" : "Add"}</Button>
          </div>
          {notice && (
            <div role="status" className={clsx("flex items-start justify-between gap-3 rounded-xl border px-3 py-2 text-sm",
              notice.tone === "ok" ? "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-200"
                : "border-rose-200 bg-rose-50 text-rose-800 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-200")}>
              <span className="flex items-center gap-2">{notice.tone === "ok" ? <CheckCircle2 size={16} /> : <XCircle size={16} />}{notice.text}</span>
              <button onClick={() => setNotice(null)} aria-label="Dismiss"><X size={14} /></button>
            </div>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title={`${rows.length} ${rows.length === 1 ? "company" : "companies"}`}
          subtitle={rows.length ? <><span className="text-up">{up} up</span> · <span className="text-down">{down} down</span> on the latest session</> : undefined}
          actions={selected.size > 0 ? (
            <Button onClick={() => remove(rows.filter((r) => selected.has(key(r))))}><Trash2 size={15} /> Remove {selected.size} selected</Button>
          ) : undefined} />
        {error && <ErrorNote message={error} onRetry={reload} />}
        {loading && !data ? <Loading rows={8} /> : (
          <div className="pt-3">
            <DataTable<Entry> dense sortable searchable searchPlaceholder="Search watchlist" rows={shown} rowKey={key}
              initialSort={{ key: "added_at", dir: "desc" }}
              highlight={(r) => selected.has(key(r))}
              toolbar={<>
                <Segmented size="sm" value={filter} onChange={setFilter} options={[{ value: "all", label: "All" }, { value: "NSE", label: "NSE" }, { value: "BSE", label: "BSE" }]} />
                <Segmented size="sm" value={move} onChange={setMove} options={[{ value: "all", label: "Any move" }, { value: "up", label: "Gainers" }, { value: "down", label: "Losers" }]} />
              </>}
              empty={rows.length ? "No companies match these filters." : "Your watchlist is empty. Search for a company above to add it."}
              columns={[
                { key: "select", sortable: false, label: <input type="checkbox" aria-label="Select all" checked={allShownSelected} onChange={toggleAll} className="h-4 w-4 accent-indigo-600" />,
                  render: (r) => <input type="checkbox" aria-label={`Select ${r.symbol}`} checked={selected.has(key(r))} onChange={() => toggle(r)} className="h-4 w-4 accent-indigo-600" /> },
                { key: "symbol", label: "Symbol", searchValue: (r) => `${r.symbol} ${r.name ?? ""} ${r.scrip_cd ?? ""}`, render: (r) => {
                  // BSE-only companies have their own pages, keyed by scrip code.
                  const target = r.exchange === "NSE" ? r.symbol : (r.nse_symbol ?? r.scrip_cd);
                  return target
                    ? <Link href={`/company/${encodeURIComponent(target)}`} className="font-semibold text-indigo-700 hover:underline dark:text-indigo-300">{r.symbol}</Link>
                    : <span className="font-semibold">{r.symbol}</span>;
                } },
                { key: "name", label: "Company", className: "max-w-[260px] truncate", render: (r) => <span className="text-slate-600 dark:text-slate-300">{r.name ?? "—"}</span> },
                { key: "exchange", label: "Exchange", render: (r) => <Badge tone={r.exchange === "NSE" ? "brand" : "up"}>{r.exchange}{r.scrip_cd && r.exchange === "BSE" ? ` · ${r.scrip_cd}` : ""}</Badge> },
                { key: "close", label: "Price ₹", align: "right", render: (r) => num(r.close) },
                { key: "pct_1d", label: "% Chg", align: "right", render: (r) => <Pct value={r.pct_1d} /> },
                { key: "pe", label: "P/E", align: "right", render: (r) => num(r.pe, 1) },
                { key: "market_cap_cr", label: "Mkt cap ₹ Cr", align: "right", render: (r) => num(r.market_cap_cr, 0) },
                { key: "ret_1m", label: "1M", align: "right", render: (r) => <Pct value={r.ret_1m} digits={1} /> },
                { key: "ret_1y", label: "1Y", align: "right", render: (r) => <Pct value={r.ret_1y} digits={1} /> },
                { key: "added_at", label: "Added", render: (r) => <span className="text-xs text-slate-500">{dateTime(r.added_at)}</span> },
                { key: "rm", sortable: false, label: "", align: "right", render: (r) => (
                  <button onClick={() => remove([r])} aria-label={`Remove ${r.symbol}`} title="Remove from watchlist"
                    className="rounded-lg p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-500/10"><Trash2 size={15} /></button>
                ) },
              ]} />
          </div>
        )}
      </Card>
    </>
  );
}
