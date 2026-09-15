"use client";

import clsx from "clsx";
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, ChevronsUpDown, Search } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";

export interface Column<T> {
  key: string;
  label: ReactNode;
  align?: "left" | "right";
  render?: (row: T, index: number) => ReactNode;
  sortValue?: (row: T) => number | string | null | undefined;
  /** Text used by the search box. Defaults to the raw field value. */
  searchValue?: (row: T) => string;
  className?: string;
  sticky?: boolean;
  /** Set false for controls such as checkboxes or action buttons. */
  sortable?: boolean;
}

interface Props<T> {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T, index: number) => string;
  /** Client-side sorting. Leave off when the server sorts. */
  sortable?: boolean;
  initialSort?: { key: string; dir: "asc" | "desc" };
  /** Controlled server-side sorting. */
  sort?: { key: string; dir: "asc" | "desc" };
  onSort?: (key: string) => void;
  footer?: ReactNode;
  dense?: boolean;
  highlight?: (row: T) => boolean;
  numbered?: boolean;
  offset?: number;
  empty?: ReactNode;
  /** Rows per page for client-side pagination; 0 disables it. */
  pageSize?: number;
  /** Show a search box that filters rows across all columns. */
  searchable?: boolean;
  searchPlaceholder?: string;
  /** Extra controls rendered next to the search box (filters). */
  toolbar?: ReactNode;
}

const PAGE_SIZES = [10, 25, 50, 100];

export function Pagination({
  page, pages, total, pageSize, onPage, onPageSize,
}: { page: number; pages: number; total: number; pageSize: number; onPage: (p: number) => void; onPageSize?: (n: number) => void }) {
  if (total === 0) return null;
  const from = (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  const windowStart = Math.max(1, Math.min(page - 2, pages - 4));
  const numbers = Array.from({ length: Math.min(5, pages) }, (_, i) => windowStart + i);

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 px-4 py-3 text-sm dark:border-slate-800">
      <div className="flex items-center gap-3 text-slate-500">
        <span className="tabular">{from.toLocaleString("en-IN")}–{to.toLocaleString("en-IN")} of {total.toLocaleString("en-IN")}</span>
        {onPageSize && (
          <select value={pageSize} onChange={(e) => onPageSize(Number(e.target.value))} aria-label="Rows per page"
            className="rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs dark:border-slate-700 dark:bg-slate-900">
            {PAGE_SIZES.map((n) => <option key={n} value={n}>{n} / page</option>)}
          </select>
        )}
      </div>
      {pages > 1 && (
        <div className="flex items-center gap-1">
          <button onClick={() => onPage(page - 1)} disabled={page <= 1} aria-label="Previous page"
            className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100 disabled:opacity-30 dark:hover:bg-slate-800"><ChevronLeft size={16} /></button>
          {windowStart > 1 && <button onClick={() => onPage(1)} className="h-8 min-w-8 rounded-lg px-2 text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800">1</button>}
          {windowStart > 2 && <span className="px-1 text-slate-400">…</span>}
          {numbers.map((n) => (
            <button key={n} onClick={() => onPage(n)}
              className={clsx("h-8 min-w-8 rounded-lg px-2 font-medium",
                n === page ? "bg-indigo-600 text-white" : "text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800")}>{n}</button>
          ))}
          {windowStart + 4 < pages - 1 && <span className="px-1 text-slate-400">…</span>}
          {windowStart + 4 < pages && <button onClick={() => onPage(pages)} className="h-8 min-w-8 rounded-lg px-2 text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800">{pages}</button>}
          <button onClick={() => onPage(page + 1)} disabled={page >= pages} aria-label="Next page"
            className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100 disabled:opacity-30 dark:hover:bg-slate-800"><ChevronRight size={16} /></button>
        </div>
      )}
    </div>
  );
}

export function DataTable<T>({
  columns, rows, rowKey, sortable, initialSort, sort, onSort, footer, dense, highlight, numbered, offset = 0, empty,
  pageSize: initialPageSize = 25, searchable, searchPlaceholder = "Search this table", toolbar,
}: Props<T>) {
  const [local, setLocal] = useState(initialSort);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(initialPageSize);
  const active = sort ?? local;
  const paginate = initialPageSize > 0 && !onSort;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => columns.some((c) => {
      const v = c.searchValue ? c.searchValue(r) : (r as Record<string, unknown>)[c.key];
      return v != null && String(v).toLowerCase().includes(q);
    }));
  }, [rows, columns, query]);

  const sorted = useMemo(() => {
    if (!sortable || onSort || !active) return filtered;
    const col = columns.find((c) => c.key === active.key);
    if (!col) return filtered;
    const get = col.sortValue ?? ((r: T) => (r as Record<string, unknown>)[col.key] as number | string | null);
    return [...filtered].sort((a, b) => {
      const va = get(a), vb = get(b);
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      const cmp = va < vb ? -1 : va > vb ? 1 : 0;
      return active.dir === "asc" ? cmp : -cmp;
    });
  }, [filtered, columns, active, sortable, onSort]);

  const pages = paginate ? Math.max(1, Math.ceil(sorted.length / pageSize)) : 1;
  // Reset to the first page when the data or the filter changes underneath.
  useEffect(() => { setPage(1); }, [query, rows, pageSize]);
  const current = Math.min(page, pages);
  const visible = paginate ? sorted.slice((current - 1) * pageSize, current * pageSize) : sorted;
  const rowOffset = paginate ? (current - 1) * pageSize : offset;

  const clickSort = (key: string) => {
    if (columns.find((c) => c.key === key)?.sortable === false) return;
    if (onSort) return onSort(key);
    if (!sortable) return;
    setLocal((s) => (s?.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: "desc" }));
  };

  const canSort = Boolean(sortable || onSort);
  const pad = dense ? "px-3 py-2" : "px-4 py-3";

  return (
    <div>
      {(searchable || toolbar) && (
        <div className="flex flex-wrap items-center gap-2 px-4 pb-3">
          {searchable && (
            <div className="relative w-full max-w-xs">
              <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
              <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={searchPlaceholder}
                className="w-full rounded-xl border border-slate-200 bg-white py-1.5 pl-8 pr-3 text-sm outline-none focus:border-indigo-400 dark:border-slate-700 dark:bg-slate-900" />
            </div>
          )}
          {toolbar}
          {query && <span className="text-xs text-slate-500">{sorted.length.toLocaleString("en-IN")} match{sorted.length === 1 ? "" : "es"}</span>}
        </div>
      )}
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-slate-200 dark:border-slate-800">
              {numbered && <th className={clsx(pad, "w-12 text-left text-xs font-semibold text-slate-500")}>#</th>}
              {columns.map((c) => {
                const on = active?.key === c.key;
                return (
                  <th
                    key={c.key}
                    className={clsx(
                      pad,
                      "whitespace-nowrap text-xs font-semibold text-slate-500 dark:text-slate-400",
                      c.align === "right" ? "text-right" : "text-left",
                      canSort && "cursor-pointer select-none hover:text-slate-900 dark:hover:text-white",
                      on && "text-indigo-700 dark:text-indigo-300",
                      c.sticky && "sticky left-0 z-10 bg-white dark:bg-slate-900",
                    )}
                    onClick={() => clickSort(c.key)}
                  >
                    <span className={clsx("inline-flex items-center gap-1", c.align === "right" && "flex-row-reverse")}>
                      {c.label}
                      {canSort && c.sortable !== false && (on ? (active!.dir === "asc" ? <ArrowUp size={12} /> : <ArrowDown size={12} />)
                        : <ChevronsUpDown size={12} className="opacity-30" />)}
                    </span>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 && (
              <tr>
                <td colSpan={columns.length + (numbered ? 1 : 0)} className="px-4 py-10 text-center text-sm text-slate-500">
                  {query ? `Nothing matches “${query}”.` : (empty ?? "No rows.")}
                </td>
              </tr>
            )}
            {visible.map((row, i) => (
              <tr
                key={rowKey(row, i + rowOffset)}
                className={clsx(
                  "border-b border-slate-100 transition-colors last:border-0 hover:bg-slate-50 dark:border-slate-800/70 dark:hover:bg-slate-800/40",
                  highlight?.(row) && "bg-indigo-50/60 dark:bg-indigo-500/10",
                )}
              >
                {numbered && <td className={clsx(pad, "tabular text-slate-400")}>{rowOffset + i + 1}.</td>}
                {columns.map((c) => (
                  <td
                    key={c.key}
                    className={clsx(
                      pad,
                      "whitespace-nowrap",
                      c.align === "right" ? "tabular text-right" : "text-left",
                      c.sticky && "sticky left-0 bg-inherit",
                      c.className,
                    )}
                  >
                    {c.render ? c.render(row, i + rowOffset) : String((row as Record<string, unknown>)[c.key] ?? "—")}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
          {footer && <tfoot>{footer}</tfoot>}
        </table>
      </div>
      {paginate && sorted.length > Math.min(...PAGE_SIZES) && (
        <Pagination page={current} pages={pages} total={sorted.length} pageSize={pageSize}
          onPage={(p) => setPage(Math.max(1, Math.min(pages, p)))} onPageSize={setPageSize} />
      )}
    </div>
  );
}
