// Portfolio import (broker CSV exports and CAS statements), watchlist storage and holding valuation.
//
// Broker CSV headers vary a lot, so they are matched loosely: "Symbol", "Instrument", "Tradingsymbol",
// "Stock Name" and "Scrip" all mean the same thing. Unrecognised columns are ignored rather than fatal.
import { parse } from "csv-parse/sync";
import { now, type Db, type Row } from "../db";

const FIELD_ALIASES: Record<string, string> = {
  symbol: "symbol", tradingsymbol: "symbol", instrument: "symbol", scrip: "symbol", scripname: "symbol", scripcode: "symbol",
  stock: "symbol", stockname: "symbol", company: "symbol", companyname: "symbol", security: "symbol", securityname: "symbol", name: "symbol",
  isin: "isin", isincode: "isin", isinnumber: "isin",
  qty: "quantity", quantity: "quantity", qtyavailable: "quantity", holdingqty: "quantity", shares: "quantity", noofshares: "quantity",
  totalqty: "quantity", netqty: "quantity", freeqty: "quantity",
  avg: "avg_price", avgprice: "avg_price", avgcost: "avg_price", averageprice: "avg_price", averagecost: "avg_price", buyprice: "avg_price",
  buyavgprice: "avg_price", averagebuyprice: "avg_price", avgbuyprice: "avg_price", buyaverageprice: "avg_price", avgtradedprice: "avg_price",
  averagetradedprice: "avg_price", costprice: "avg_price", purchaseprice: "avg_price",
  ltp: "last_price", lastprice: "last_price", currentprice: "last_price", marketprice: "last_price", closeprice: "last_price",
  pnl: "pnl", profitandloss: "pnl", unrealizedpnl: "pnl", unrealisedpnl: "pnl", netpnl: "pnl",
  exchange: "exchange", exch: "exchange", segment: "exchange",
};

/** A user-facing import problem (reported as HTTP 400). */
export class ImportError extends Error {}

const normHeader = (h: string) => (h || "").toLowerCase().replace(/[^a-z0-9]/g, "");

function num(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim().replaceAll(",", "").replaceAll("₹", "").replaceAll("(", "-").replaceAll(")", "");
  if (!s || ["-", "--", "NA", "N/A"].includes(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

const splitLine = (line: string): string[] => {
  try {
    return (parse(line, { relax_quotes: true, relax_column_count: true }) as string[][])[0] ?? [];
  } catch {
    return line.split(",");
  }
};

/** Find the real header row - broker exports often have preamble lines. */
function sniffRows(text: string): Record<string, string>[] {
  const lines = text.split(/\r?\n/);
  let bestIdx = 0;
  let bestScore = -1;
  lines.slice(0, 40).forEach((line, i) => {
    if (!line.trim()) return;
    const score = splitLine(line).map(normHeader).filter((h) => h in FIELD_ALIASES).length;
    if (score > bestScore) [bestIdx, bestScore] = [i, score];
  });
  if (bestScore < 2) throw new ImportError("could not find a header row with recognisable columns (need at least a symbol and a quantity)");
  return parse(lines.slice(bestIdx).join("\n"), { columns: true, skip_empty_lines: true, relax_column_count: true, relax_quotes: true });
}

export function parseCsv(text: string) {
  const out: Row[] = [];
  for (const raw of sniffRows(text.replace(/^﻿/, ""))) {
    const rec: Row = {};
    for (const [key, value] of Object.entries(raw)) {
      const field = FIELD_ALIASES[normHeader(key)];
      if (field && (rec[field] === undefined || rec[field] === "")) rec[field] = value;
    }
    const symbol = String(rec.symbol ?? "").trim();
    const qty = num(rec.quantity);
    if (!symbol || qty === null) continue;
    if (/^(total|grand total|sum)/i.test(symbol)) continue; // summary lines brokers append
    out.push({
      symbol: symbol.toUpperCase(),
      isin: String(rec.isin ?? "").trim() || null,
      exchange: String(rec.exchange ?? "").trim().toUpperCase() || null,
      quantity: qty,
      avg_price: num(rec.avg_price),
      last_price: num(rec.last_price),
      pnl: num(rec.pnl),
    });
  }
  return out;
}

const first = (db: Db, sql: string, args: (string | null)[]) => {
  const v = db.scalar(sql, args);
  return v === null ? null : String(v);
};

/** Map a broker's label (ticker or company name) to a tradeable ticker and its exchange. */
export function canonical(db: Db, symbol: string, isin: string | null): [string, string] {
  if (isin) {
    const n = first(db, "SELECT symbol FROM nse_symbol WHERE isin = ? LIMIT 1", [isin]);
    if (n) return [n, "NSE"];
    const b = first(db, "SELECT scrip_cd FROM scrip WHERE isin = ? LIMIT 1", [isin]);
    if (b) return [b, "BSE"];
  }
  const up = symbol.toUpperCase();
  for (const sql of ["SELECT symbol FROM nse_symbol WHERE UPPER(symbol) = ? LIMIT 1", "SELECT symbol FROM nse_symbol WHERE UPPER(company) = ? LIMIT 1"]) {
    const v = first(db, sql, [up]);
    if (v) return [v, "NSE"];
  }
  for (const col of ["scrip_id", "scrip_name"]) {
    const v = first(db, `SELECT scrip_cd FROM scrip WHERE UPPER(${col}) = ? ORDER BY (status = 'Active') DESC LIMIT 1`, [up]);
    if (v) return [v, "BSE"];
  }
  return [symbol, ""];
}

/** Prefer NSE when the symbol is listed there, else BSE. */
function guessExchange(db: Db, symbol: string, isin: string | null): string {
  if (isin && db.get("SELECT 1 FROM nse_symbol WHERE isin = ? LIMIT 1", [isin])) return "NSE";
  return db.get("SELECT 1 FROM nse_symbol WHERE UPPER(symbol) = ? LIMIT 1", [symbol]) ? "NSE" : "BSE";
}

/** Map a broker symbol (or ISIN) to a BSE scrip code. */
function resolveScrip(db: Db, symbol: string, isin?: string | null): string | null {
  if (isin) {
    const v = first(db, "SELECT scrip_cd FROM scrip WHERE isin = ?", [isin]);
    if (v) return v;
  }
  const v = first(db, "SELECT scrip_cd FROM scrip WHERE UPPER(scrip_id) = UPPER(?) ORDER BY (status = 'Active') DESC LIMIT 1", [symbol]);
  if (v) return v;
  return /^\d+$/.test(symbol) ? symbol : null; // a numeric symbol is already a scrip code
}

/** Persist watchlist entries, resolving BSE scrip codes where possible. */
export function saveWatchlist(db: Db, name: string, rows: Row[], source: string): number {
  const ts = now();
  const out: Row[] = [];
  for (const r of rows) {
    const symbol = String(r.symbol ?? "").trim();
    if (!symbol) continue;
    const exchange = String(r.exchange || "BSE").trim().toUpperCase();
    let scrip = r.scrip_cd ?? null;
    if (scrip === null && exchange === "BSE") scrip = resolveScrip(db, symbol, r.isin);
    out.push({ name, symbol, scrip_cd: scrip, exchange, source, added_at: ts });
  }
  return db.upsert("watchlist", out);
}

const normExchange = (e: string) => (e.startsWith("NSE") ? "NSE" : e.startsWith("BSE") ? "BSE" : e);

/** Import holdings from a broker CSV. Returns [holdings written, watchlist entries written]. */
export function importCsv(db: Db, text: string, broker = "manual", exchange: string | null = null, watchlist: string | null = "default"): [number, number] {
  const rows = parseCsv(text);
  if (!rows.length) return [0, 0];
  const asOf = now();
  const holdings: Row[] = [];
  const wl: Row[] = [];
  for (const r of rows) {
    const [ticker, resolved] = canonical(db, r.symbol, r.isin);
    const exch = normExchange((exchange || r.exchange || resolved || guessExchange(db, r.symbol, r.isin)).toUpperCase());
    holdings.push({ broker, as_of: asOf, symbol: ticker, isin: r.isin, exchange: exch, quantity: r.quantity, avg_price: r.avg_price, last_price: r.last_price, pnl: r.pnl, raw: null });
    wl.push({ symbol: ticker, exchange: exch, isin: r.isin });
  }
  return db.transaction(() => {
    const n = db.upsert("holding", holdings);
    const m = watchlist ? saveWatchlist(db, watchlist, wl, broker) : 0;
    return [n, m] as [number, number];
  });
}

const f = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** The parsed statement, in the same shape casparser produces (see core/cas.ts). */
export interface CasData {
  file_type?: string;
  accounts?: Row[];
  folios?: Row[];
}

/** Import a complete portfolio from a parsed Consolidated Account Statement. Returns counts by asset type. */
export function importCasData(db: Db, data: CasData, label = "cas", watchlist: string | null = "default"): Row {
  const asOf = now();
  const holdings: Row[] = [];
  const wl: Row[] = [];
  const counts = { equity: 0, mutual_fund: 0, bond: 0 };

  // One row per (symbol, exchange) per snapshot: merge the same ISIN held across several demat accounts.
  const add = (row: Row) => {
    const h = holdings.find((x) => x.symbol === row.symbol && x.exchange === row.exchange);
    if (!h) return void holdings.push(row);
    h.quantity = (h.quantity || 0) + (row.quantity || 0);
    h.last_price = row.last_price || h.last_price;
    if (h.account && row.account && !h.account.includes(row.account)) h.account = `${h.account}, ${row.account}`;
  };

  for (const acct of data.accounts ?? []) {
    const account = `${acct.dp_id ?? ""} ${acct.client_id ?? ""}`.trim() || acct.name || "";
    for (const e of acct.equities ?? []) {
      const isin = String(e.isin ?? "").trim() || null;
      const name = String(e.name ?? "").trim();
      const [ticker, ex] = canonical(db, String(e.symbol || name).toUpperCase(), isin);
      const exch = ex || guessExchange(db, ticker, isin);
      add({ broker: label, as_of: asOf, symbol: ticker, isin, exchange: exch, quantity: f(e.num_shares), avg_price: null, last_price: f(e.price), pnl: null, raw: null, name: name || null, asset_type: "equity", account });
      wl.push({ symbol: ticker, exchange: exch, isin });
      counts.equity++;
    }
    for (const mf of acct.mutual_funds ?? []) {
      const isin = String(mf.isin ?? "").trim() || null;
      add({ broker: label, as_of: asOf, symbol: isin || String(mf.name ?? "").slice(0, 40), isin, exchange: "MF", quantity: f(mf.balance), avg_price: f(mf.avg_cost), last_price: f(mf.nav), pnl: f(mf.pnl), raw: null, name: mf.name ?? null, asset_type: "mutual_fund", account });
      counts.mutual_fund++;
    }
    for (const b of acct.bonds ?? []) {
      const isin = String(b.isin ?? "").trim() || null;
      add({ broker: label, as_of: asOf, symbol: isin || String(b.name ?? "").slice(0, 40), isin, exchange: "BOND", quantity: f(b.num_units || b.num_bonds || b.balance || b.num_shares), avg_price: null, last_price: f(b.price || b.market_price || b.face_value), pnl: null, raw: null, name: b.name ?? null, asset_type: "bond", account });
      counts.bond++;
    }
  }

  for (const folio of data.folios ?? []) {
    for (const sch of folio.schemes ?? []) {
      const val = sch.valuation ?? {};
      const units = f(sch.close);
      if (!units) continue;
      const cost = f(val.cost);
      const value = f(val.value);
      const isin = String(sch.isin ?? "").trim() || null;
      add({
        broker: label, as_of: asOf, symbol: isin || String(sch.scheme ?? "").slice(0, 40), isin, exchange: "MF", quantity: units,
        avg_price: cost && units ? cost / units : null, last_price: f(val.nav), pnl: value !== null && cost !== null ? value - cost : null,
        raw: null, name: sch.scheme ?? null, asset_type: "mutual_fund", account: `Folio ${folio.folio ?? ""}`,
      });
      counts.mutual_fund++;
    }
  }

  if (!holdings.length) throw new ImportError("The statement opened, but it lists no holdings.");
  return db.transaction(() => {
    const written = db.upsert("holding", holdings);
    const wlWritten = watchlist && wl.length ? saveWatchlist(db, watchlist, wl, label) : 0;
    return { written, watchlist: wlWritten, file_type: String(data.file_type ?? "").toUpperCase(), ...counts };
  });
}

/** Latest EOD close for a holding, from whichever exchange table fits. */
function latestClose(db: Db, symbol: string, exchange: string | null, isin: string | null): number | null {
  if ((exchange ?? "").toUpperCase() === "NSE") {
    return db.scalar<number>("SELECT close FROM nse_bhavcopy WHERE symbol = ? AND series = 'EQ' ORDER BY trade_date DESC LIMIT 1", [symbol]);
  }
  let scrip = isin ? first(db, "SELECT scrip_cd FROM scrip WHERE isin = ?", [isin]) : null;
  scrip ??= first(db, "SELECT scrip_cd FROM scrip WHERE UPPER(scrip_id) = ? ORDER BY (status = 'Active') DESC LIMIT 1", [symbol]);
  if (!scrip && /^\d+$/.test(symbol)) scrip = symbol;
  if (!scrip) return null;
  return db.scalar<number>("SELECT close FROM bhavcopy WHERE scrip_cd = ? ORDER BY trade_date DESC LIMIT 1", [scrip]);
}

/** Most recent holdings snapshot, valued against the latest close. */
export function latestSnapshot(db: Db, broker?: string): Row[] {
  const asOf = broker
    ? db.scalar<string>("SELECT MAX(as_of) FROM holding WHERE broker = ?", [broker])
    : db.scalar<string>("SELECT MAX(as_of) FROM holding");
  if (!asOf) return [];
  const rows = broker
    ? db.all("SELECT * FROM holding WHERE as_of = ? AND broker = ? ORDER BY symbol", [asOf, broker])
    : db.all("SELECT * FROM holding WHERE as_of = ? ORDER BY symbol", [asOf]);
  return rows.map((h) => {
    const rec: Row = { ...h };
    const exch = String(rec.exchange ?? "").toUpperCase();
    rec.close = exch === "MF" || exch === "BOND" ? null : latestClose(db, rec.symbol, rec.exchange, rec.isin);
    const price = rec.close ?? rec.last_price;
    const qty = rec.quantity || 0;
    const avg = rec.avg_price;
    rec.value = (price || 0) * qty;
    rec.cost = (avg || 0) * qty;
    rec.gain = avg !== null && avg !== undefined && price ? rec.value - rec.cost : null;
    rec.gain_pct = rec.cost && rec.gain !== null ? rec.gain / rec.cost * 100 : null;
    return rec;
  });
}
