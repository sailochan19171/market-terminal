// The two questions the orders dashboard asks of the extracted rows.
//
//   1. Every order, newest first, filtered by company, customer, size or date.
//   2. Which companies have won orders worth the most against their own revenue, over a chosen period.
//
// The size of an order is always measured against the company's latest twelve-month revenue from
// company_metrics, and the answer carries the basis (standalone or consolidated) and the quarter it came from,
// so a percentage can be checked. A company whose revenue is unknown keeps its order but shows no percentage.
import type { Db, Row } from "../db";
import { ensureSchema } from "./store";

export interface OrderView {
  id: string; exchange: string; symbol: string | null; company: string | null; announcedAt: string;
  customer: string | null; orderType: string | null; contractValueCr: number | null; currency: string | null;
  durationMonths: number | null; annualValueCr: number | null; orderSizePct: number | null;
  workScope: string | null; location: string | null; summary: string | null; headline: string | null;
  pdfUrl: string | null; extractedBy: string | null; model: string | null; confidence: number | null; note: string | null;
  revenueCr: number | null; revenueBasis: string | null; revenueQuarter: string | null; marketCapCr: number | null;
}

export interface OrderFilters {
  company?: string | null; customer?: string | null; minOrderPct?: number | null; minValueCr?: number | null;
  months?: number | null; days?: number | null; search?: string | null; limit?: number; offset?: number;
  /** An explicit date range (YYYY-MM-DD), from the calendar; `from` alone is an open-ended window. */
  from?: string | null; to?: string | null;
  sort?: "date" | "value" | "size"; includeUnsized?: boolean;
}

/** An order spread over its execution period: what it adds to revenue in a year. */
export const annualValue = (valueCr: number | null, months: number | null) =>
  valueCr === null ? null : months && months > 12 ? (valueCr / months) * 12 : valueCr;

/**
 * The start of the period being looked at. `days` counts back in whole days from the start of today, so "today"
 * is everything filed since midnight and a week is the last seven calendar days; `months` counts back in months.
 */
function since(months: number | null | undefined, days?: number | null): string {
  if (days && days > 0) {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - (days - 1));
    return start.toISOString().slice(0, 10);
  }
  return months && months > 0 ? new Date(Date.now() - months * 30.44 * 86_400_000).toISOString().slice(0, 19) : "0000";
}

const BASE = `
  SELECT o.*, m.sales_ttm_cr, m.basis, m.latest_quarter, m.market_cap_cr, m.company AS metrics_company
    FROM company_order o
    LEFT JOIN company_metrics m ON m.symbol = o.symbol
   WHERE o.is_order = 1 AND o.announced_at >= ?`;

function toView(r: Row): OrderView {
  const value = r.contract_value_cr === null || r.contract_value_cr === undefined ? null : Number(r.contract_value_cr);
  const months = r.duration_months === null || r.duration_months === undefined ? null : Number(r.duration_months);
  const revenue = r.sales_ttm_cr === null || r.sales_ttm_cr === undefined ? null : Number(r.sales_ttm_cr);
  const annual = annualValue(value, months);
  return {
    id: String(r.id), exchange: String(r.exchange), symbol: r.symbol ? String(r.symbol) : null,
    company: String(r.metrics_company ?? r.company ?? r.symbol ?? ""), announcedAt: String(r.announced_at),
    customer: r.customer ? String(r.customer) : null, orderType: r.order_type ? String(r.order_type) : null,
    contractValueCr: value, currency: r.currency ? String(r.currency) : null, durationMonths: months,
    annualValueCr: annual, orderSizePct: annual !== null && revenue ? (annual / revenue) * 100 : null,
    workScope: r.work_scope ? String(r.work_scope) : null, location: r.location ? String(r.location) : null,
    summary: r.summary ? String(r.summary) : null, headline: r.headline ? String(r.headline) : null,
    pdfUrl: r.pdf_url ? String(r.pdf_url) : null, extractedBy: r.extracted_by ? String(r.extracted_by) : null,
    model: r.model ? String(r.model) : null, confidence: r.confidence === null || r.confidence === undefined ? null : Number(r.confidence),
    note: r.note ? String(r.note) : null, revenueCr: revenue, revenueBasis: r.basis ? String(r.basis) : null,
    revenueQuarter: r.latest_quarter ? String(r.latest_quarter) : null,
    marketCapCr: r.market_cap_cr === null || r.market_cap_cr === undefined ? null : Number(r.market_cap_cr),
  };
}

/**
 * One order, filed with both exchanges, must be counted once. Two rows for the same company on the same day
 * with the same contract value are the same order; the NSE row is kept because it carries the symbol.
 */
function collapseDuplicates(rows: OrderView[]): OrderView[] {
  const byKey = new Map<string, OrderView>();
  for (const o of rows) {
    const key = `${o.symbol ?? o.company}|${o.announcedAt.slice(0, 10)}|${o.contractValueCr?.toFixed(2) ?? "?"}`;
    const kept = byKey.get(key);
    if (!kept || (kept.exchange !== "NSE" && o.exchange === "NSE")) byKey.set(key, o);
  }
  return [...byKey.values()];
}

/** The day of the most recent order on file, so "today" can fall back to it when nothing has been filed yet. */
export function latestOrderDay(db: Db): string | null {
  ensureSchema(db);
  const at = db.scalar<string>("SELECT MAX(announced_at) FROM company_order WHERE is_order = 1");
  return at ? String(at).slice(0, 10) : null;
}

export function listOrders(db: Db, f: OrderFilters = {}): { rows: OrderView[]; total: number } {
  ensureSchema(db);
  const params: (string | number)[] = [f.from ?? since(f.months ?? 6, f.days)];
  let sql = BASE;
  // A day chosen in the calendar means the whole of that day, up to its last second.
  if (f.to) { sql += " AND o.announced_at <= ?"; params.push(`${f.to}T23:59:59`); }
  if (f.company) { sql += " AND (o.symbol = ? OR o.company = ?)"; params.push(f.company, f.company); }
  if (f.customer) { sql += " AND o.customer = ?"; params.push(f.customer); }
  if (f.minValueCr) { sql += " AND o.contract_value_cr >= ?"; params.push(f.minValueCr); }
  if (f.search) {
    sql += " AND (o.company LIKE ? OR o.symbol LIKE ? OR o.customer LIKE ? OR o.work_scope LIKE ? OR o.summary LIKE ?)";
    const like = `%${f.search}%`;
    params.push(like, like, like, like, like);
  }
  const all = collapseDuplicates(db.all<Row>(sql, params).map(toView));
  const min = f.minOrderPct ?? 0;
  const filtered = min > 0 ? all.filter((o) => (o.orderSizePct ?? -1) >= min) : all;
  const sorted = filtered.sort((a, b) =>
    f.sort === "value" ? (b.contractValueCr ?? -1) - (a.contractValueCr ?? -1)
      : f.sort === "size" ? (b.orderSizePct ?? -1) - (a.orderSizePct ?? -1)
        : b.announcedAt.localeCompare(a.announcedAt));
  const offset = f.offset ?? 0;
  return { rows: sorted.slice(offset, offset + (f.limit ?? 100)), total: sorted.length };
}

export interface CompanyOrders {
  symbol: string | null; company: string; industry: string | null; orderCount: number;
  totalOrderValueCr: number; totalAnnualValueCr: number; revenueCr: number | null; revenueBasis: string | null;
  revenueQuarter: string | null; marketCapCr: number | null; ordersPctOfRevenue: number | null;
  latestOrderAt: string; orders: OrderView[];
}

export interface CompanyFilters {
  months?: number | null; days?: number | null; from?: string | null; to?: string | null; minRevenuePct?: number | null; minMarketCapCr?: number | null; maxMarketCapCr?: number | null;
  search?: string | null; limit?: number;
}

/** Orders won in the period, per company, against that company's revenue (the second screen). */
export function companyOrders(db: Db, f: CompanyFilters = {}): CompanyOrders[] {
  const { rows } = listOrders(db, { months: f.months ?? 6, days: f.days, from: f.from, to: f.to, limit: 100_000, sort: "date" });
  const byCompany = new Map<string, CompanyOrders>();
  for (const o of rows) {
    const key = o.symbol ?? o.company ?? o.id;
    let c = byCompany.get(key);
    if (!c) {
      c = {
        symbol: o.symbol, company: o.company || key, industry: null, orderCount: 0, totalOrderValueCr: 0,
        totalAnnualValueCr: 0, revenueCr: o.revenueCr, revenueBasis: o.revenueBasis, revenueQuarter: o.revenueQuarter,
        marketCapCr: o.marketCapCr, ordersPctOfRevenue: null, latestOrderAt: o.announcedAt, orders: [],
      };
      byCompany.set(key, c);
    }
    c.orderCount++;
    c.totalOrderValueCr += o.contractValueCr ?? 0;
    c.totalAnnualValueCr += o.annualValueCr ?? 0;
    if (o.announcedAt > c.latestOrderAt) c.latestOrderAt = o.announcedAt;
    c.orders.push(o);
  }

  const industries = new Map<string, string>();
  for (const r of db.all<Row>("SELECT symbol, industry FROM company_metrics WHERE industry IS NOT NULL")) industries.set(String(r.symbol), String(r.industry));

  let out = [...byCompany.values()].map((c) => ({
    ...c,
    industry: c.symbol ? industries.get(c.symbol) ?? null : null,
    ordersPctOfRevenue: c.revenueCr ? (c.totalOrderValueCr / c.revenueCr) * 100 : null,
  }));

  if (f.search) {
    const q = f.search.toLowerCase();
    out = out.filter((c) => c.company.toLowerCase().includes(q) || (c.symbol ?? "").toLowerCase().includes(q));
  }
  if (f.minRevenuePct != null && f.minRevenuePct > 0) out = out.filter((c) => (c.ordersPctOfRevenue ?? -1) >= f.minRevenuePct!);
  if (f.minMarketCapCr != null) out = out.filter((c) => (c.marketCapCr ?? 0) >= f.minMarketCapCr!);
  if (f.maxMarketCapCr != null) out = out.filter((c) => (c.marketCapCr ?? 0) <= f.maxMarketCapCr!);

  return out
    .sort((a, b) => (b.ordersPctOfRevenue ?? -1) - (a.ordersPctOfRevenue ?? -1) || b.totalOrderValueCr - a.totalOrderValueCr)
    .slice(0, f.limit ?? 200);
}

/**
 * What the dropdowns offer. Each list is built from the orders the *other* filters leave: pick a company and
 * the customer list narrows to that company's customers in the period, and picking a shorter period narrows
 * both. A filter can then never offer a value that would return nothing.
 */
export function filterOptions(db: Db, f: OrderFilters = {}): { companies: { value: string; label: string; count: number }[]; customers: { value: string; label: string; count: number }[]; orderTypes: string[] } {
  const base = { months: f.months ?? 6, days: f.days, from: f.from, to: f.to, search: f.search, limit: 100_000 };
  const forCompanies = listOrders(db, { ...base, customer: f.customer }).rows;
  const forCustomers = listOrders(db, { ...base, company: f.company }).rows;
  const rows = forCustomers;
  const companies = new Map<string, { label: string; count: number }>();
  const customers = new Map<string, number>();
  const types = new Set<string>();
  for (const o of forCompanies) {
    const key = o.symbol ?? o.company ?? "";
    if (!key) continue;
    const c = companies.get(key) ?? { label: o.company || key, count: 0 };
    c.count++;
    companies.set(key, c);
  }
  for (const o of forCustomers) {
    if (o.customer) customers.set(o.customer, (customers.get(o.customer) ?? 0) + 1);
    if (o.orderType) types.add(o.orderType);
  }
  return {
    companies: [...companies.entries()].map(([value, c]) => ({ value, label: c.label, count: c.count })).sort((a, b) => a.label.localeCompare(b.label)),
    customers: [...customers.entries()].map(([value, count]) => ({ value, label: value, count })).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)),
    orderTypes: [...types].sort(),
  };
}
