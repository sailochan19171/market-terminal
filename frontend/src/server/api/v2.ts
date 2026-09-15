// /api/v2 feeds: home, search, indices, peers, screens, heatmap, sector overview, filings and insider trades.
import type { Db, Row } from "../db";
import { available as ftsAvailable, matchQuery } from "../core/searchIndex";
import * as sync from "../nse/companySync";
import { addDays, median, pctChange, placeholders } from "../util";
import { ApiError, Args, badRequest, memo } from "./common";

export const HOME_TILES = [
  "NIFTY 50", "NIFTY NEXT 50", "NIFTY BANK", "NIFTY FINANCIAL SERVICES", "NIFTY MIDCAP 100", "NIFTY SMALLCAP 250",
  "NIFTY IT", "NIFTY AUTO", "NIFTY PHARMA", "NIFTY FMCG", "NIFTY METAL", "NIFTY REALTY", "INDIA VIX",
];

export const INDEX_SLUGS: Record<string, string> = {
  "NIFTY 50": "nifty50", "NIFTY NEXT 50": "niftynext50", "NIFTY 100": "nifty100", "NIFTY 200": "nifty200",
  "NIFTY 500": "nifty500", "NIFTY MIDCAP 50": "niftymidcap50", "NIFTY MIDCAP 100": "niftymidcap100",
  "NIFTY MIDCAP 150": "niftymidcap150", "NIFTY SMALLCAP 50": "niftysmallcap50", "NIFTY SMALLCAP 100": "niftysmallcap100",
  "NIFTY SMALLCAP 250": "niftysmallcap250", "NIFTY BANK": "niftybank", "NIFTY IT": "niftyit", "NIFTY AUTO": "niftyauto",
  "NIFTY FMCG": "niftyfmcg", "NIFTY PHARMA": "niftypharma", "NIFTY METAL": "niftymetal", "NIFTY REALTY": "niftyrealty",
  "NIFTY ENERGY": "niftyenergy", "NIFTY INFRASTRUCTURE": "niftyinfra", "NIFTY MEDIA": "niftymedia",
  "NIFTY PSU BANK": "niftypsubank", "NIFTY PRIVATE BANK": "niftyprivatebank", "NIFTY FINANCIAL SERVICES": "niftyfinancialservices",
  "NIFTY HEALTHCARE INDEX": "niftyhealthcare", "NIFTY CONSUMER DURABLES": "niftyconsumerdurables", "NIFTY OIL & GAS": "niftyoilgas",
  "NIFTY COMMODITIES": "niftycommodities", "NIFTY INDIA CONSUMPTION": "niftyconsumption", "NIFTY CPSE": "niftycpse",
  "NIFTY MNC": "niftymnc", "NIFTY PSE": "niftypse", "NIFTY SERVICES SECTOR": "niftyservicessector",
  "NIFTY GROWTH SECTORS 15": "niftygrowsect15", "NIFTY TOTAL MARKET": "niftytotalmarket", "NIFTY MICROCAP 250": "niftymicrocap250",
};
export const INDEX_NAMES: Record<string, string> = Object.fromEntries(Object.entries(INDEX_SLUGS).map(([k, v]) => [v, k]));

/** F&O symbols for index underlyings -> the index they track. */
export const DERIVATIVE_INDEX_SYMBOLS: Record<string, string> = {
  NIFTY: "NIFTY 50", BANKNIFTY: "NIFTY BANK", FINNIFTY: "NIFTY FINANCIAL SERVICES", MIDCPNIFTY: "NIFTY MIDCAP SELECT",
  NIFTYNXT50: "NIFTY NEXT 50", NIFTYFPI: "NIFTY INDIA FPI 150",
};

const members = (db: Db, slug: string) => db.all<{ symbol: string }>("SELECT symbol FROM nse_index_constituent WHERE index_symbol = ?", [slug]).map((r) => r.symbol);

const COUNTS_TTL_MS = 10 * 60_000;

export function home(db: Db) {
  const last = db.scalar<string>("SELECT MAX(trade_date) FROM nse_index_history");
  const tiles = db.all(`SELECT index_name, display_name, trade_date, open, high, low, close, pts_change, pct_change, pe, pb, div_yield FROM nse_index_history WHERE trade_date = ? AND index_name IN (${placeholders(HOME_TILES.length)})`, [last, ...HOME_TILES]);
  tiles.sort((a, b) => (HOME_TILES.indexOf(a.index_name) + 1 || 99) - (HOME_TILES.indexOf(b.index_name) + 1 || 99));
  const nifty = members(db, "nifty50");
  const cols = "symbol, company, close, change, pct_1d, volume, turnover, market_cap_cr";
  const ticker = db.all(`SELECT ${cols} FROM company_metrics WHERE symbol IN (${placeholders(nifty.length)}) ORDER BY symbol`, nifty);
  const top = (orderBy: string, n = 10) => db.all(`SELECT ${cols} FROM company_metrics WHERE symbol IN (${placeholders(nifty.length)}) AND close IS NOT NULL ORDER BY ${orderBy} LIMIT ${n}`, nifty);
  const breadth = db.get("SELECT SUM(pct_1d > 0) advances, SUM(pct_1d < 0) declines, SUM(pct_1d = 0) unchanged, SUM(high_52w IS NOT NULL AND close >= high_52w * 0.999) new_highs, SUM(low_52w IS NOT NULL AND close <= low_52w * 1.001) new_lows FROM company_metrics WHERE close IS NOT NULL");
  return {
    asOf: last,
    priceDate: db.scalar("SELECT MAX(trade_date) FROM company_metrics"),
    tiles, ticker,
    snapshot: { gainers: top("pct_1d DESC"), losers: top("pct_1d ASC"), activeValue: top("turnover DESC"), activeVolume: top("volume DESC") },
    breadth,
    marketCapLakhCr: (db.scalar<number>("SELECT SUM(market_cap_cr) FROM company_metrics WHERE close IS NOT NULL") || 0) / 1e5,
    announcements: db.all("SELECT symbol, company, subject, details, ann_dt, pdf_url FROM nse_announcement ORDER BY ann_dt DESC LIMIT 20"),
    // Full-table counts over a million filings: seconds on a cold disk cache, and they barely move.
    counts: memo("home:counts", COUNTS_TTL_MS, () => ({
      companies: db.scalar("SELECT COUNT(*) FROM company_metrics WHERE close IS NOT NULL"),
      indices: db.scalar("SELECT COUNT(DISTINCT index_name) FROM nse_index_history"),
      filings: (db.scalar<number>("SELECT COUNT(*) FROM nse_announcement") || 0) + (db.scalar<number>("SELECT COUNT(*) FROM announcement") || 0),
    })),
  };
}

export function search(db: Db, a: Args) {
  const q = a.str("q").trim();
  if (!q) return { companies: [], indices: [] };
  const like = `%${q}%`;
  const limit = a.int("limit", 12, 1, 50);
  const companies: Row[] = db.all("SELECT symbol AS key, symbol, bse_code AS bseCode, company, industry, close, pct_1d, market_cap_cr, 1 AS nse, bse_code IS NOT NULL AS bse FROM company_metrics WHERE symbol LIKE ? OR company LIKE ? OR isin = ? OR bse_code = ? ORDER BY (UPPER(symbol) = UPPER(?)) DESC, (symbol LIKE ?) DESC, market_cap_cr DESC NULLS LAST LIMIT ?",
    [like, like, q.toUpperCase(), q, q, `${q}%`, limit]).map((r) => ({ ...r }));
  if (companies.length < limit) {
    // Companies listed only on BSE, priced from the BSE bhavcopy.
    companies.push(...db.all("SELECT s.scrip_cd AS key, NULL AS symbol, s.scrip_cd AS bseCode, s.scrip_name AS company, s.industry, b.close, CASE WHEN b.prev_close > 0 THEN (b.close - b.prev_close) / b.prev_close * 100 END AS pct_1d, s.market_cap AS market_cap_cr, 0 AS nse, 1 AS bse FROM scrip s LEFT JOIN bhavcopy b ON b.scrip_cd = s.scrip_cd AND b.trade_date = (SELECT MAX(trade_date) FROM bhavcopy) WHERE s.status = 'Active' AND (s.scrip_cd = ? OR s.scrip_id LIKE ? OR s.scrip_name LIKE ?) AND (s.isin IS NULL OR s.isin NOT IN (SELECT isin FROM nse_symbol WHERE isin IS NOT NULL)) ORDER BY (s.scrip_cd = ?) DESC, s.market_cap DESC NULLS LAST LIMIT ?",
      [q, `${q.toUpperCase()}%`, like, q, limit - companies.length]).map((r) => ({ ...r })));
  }
  for (const c of companies) {
    c.exchanges = { NSE: Boolean(c.nse), BSE: Boolean(c.bse) };
    delete c.nse;
    delete c.bse;
  }
  const indices = db.all("SELECT DISTINCT index_name, display_name FROM nse_index_history WHERE index_name LIKE ? LIMIT 6", [like.toUpperCase()]);
  return { companies, indices };
}

export function indices(db: Db) {
  const last = db.scalar<string>("SELECT MAX(trade_date) FROM nse_index_history");
  if (!last) return { asOf: null, indices: [] };
  const yearAgo = addDays(last, -365);
  const latest = db.all("SELECT index_name, display_name, open, high, low, close, pts_change, pct_change, volume, turnover_cr, pe, pb, div_yield FROM nse_index_history WHERE trade_date = ? ORDER BY index_name", [last]).map((r) => ({ ...r }));
  const y1 = new Map(db.all("SELECT h.index_name, h.close FROM nse_index_history h JOIN (SELECT index_name, MAX(trade_date) t FROM nse_index_history WHERE trade_date <= ? GROUP BY index_name) m ON m.index_name = h.index_name AND m.t = h.trade_date", [yearAgo]).map((r) => [r.index_name, r.close]));
  const w52 = new Map(db.all("SELECT index_name, MAX(high) hi, MIN(low) lo FROM nse_index_history WHERE trade_date > ? GROUP BY index_name", [yearAgo]).map((r) => [r.index_name, [r.hi, r.lo]]));
  for (const r of latest) {
    r.ret_1y = pctChange(r.close, y1.get(r.index_name));
    [r.high_52w, r.low_52w] = w52.get(r.index_name) ?? [null, null];
    r.slug = INDEX_SLUGS[r.index_name] ?? null;
  }
  return { asOf: last, indices: latest };
}

export function indexDetail(db: Db, rawName: string, a: Args) {
  const name = rawName.toUpperCase();
  const days = a.int("days", 365, 5, 4000);
  const last = db.scalar<string>("SELECT MAX(trade_date) FROM nse_index_history WHERE index_name = ?", [name]);
  if (!last) throw new ApiError(404, `unknown index '${name}'`, { error: `unknown index '${name}'` });
  const history = db.all("SELECT trade_date, open, high, low, close, volume, pe, pb, div_yield FROM nse_index_history WHERE index_name = ? AND trade_date >= ? ORDER BY trade_date", [name, addDays(last, -days)]);
  const latest = db.get("SELECT * FROM nse_index_history WHERE index_name = ? AND trade_date = ?", [name, last])!;
  const returns: Record<string, number | null> = {};
  for (const [label, back] of [["1M", 30], ["3M", 91], ["6M", 182], ["1Y", 365], ["3Y", 1095], ["5Y", 1826]] as const) {
    const base = db.scalar<number>("SELECT close FROM nse_index_history WHERE index_name = ? AND trade_date <= ? ORDER BY trade_date DESC LIMIT 1", [name, addDays(last, -back)]);
    returns[label] = base ? pctChange(latest.close, base) : null;
  }
  const slug = INDEX_SLUGS[name];
  const constituents = slug ? db.all("SELECT m.symbol, m.company, k.industry, m.close, m.change, m.pct_1d, m.volume, m.turnover, m.market_cap_cr, m.pe, m.ret_1y FROM nse_index_constituent k JOIN company_metrics m ON m.symbol = k.symbol WHERE k.index_symbol = ? ORDER BY m.market_cap_cr DESC NULLS LAST", [slug]) : [];
  return { name, display: latest.display_name ?? null, latest, returns, history, constituents, hasConstituents: Boolean(slug) };
}

export function peers(db: Db, rawSymbol: string) {
  const symbol = rawSymbol.toUpperCase();
  const me = db.get("SELECT industry FROM company_metrics WHERE symbol = ?", [symbol]);
  if (!me || !me.industry) return { industry: null, peers: [], median: null };
  const list = db.all("SELECT symbol, company, close, pe, market_cap_cr, div_yield, np_qtr_cr, qtr_profit_var, sales_qtr_cr, qtr_sales_var, net_margin_ttm, ret_1y FROM company_metrics WHERE industry = ? AND close IS NOT NULL ORDER BY (symbol = ?) DESC, market_cap_cr DESC NULLS LAST LIMIT 16", [me.industry, symbol]);
  const head = list.filter((p) => p.symbol === symbol);
  const rest = list.filter((p) => p.symbol !== symbol).sort((x, y) => -(x.market_cap_cr || 0) + (y.market_cap_cr || 0)).slice(0, 15);
  const ordered = [...head, ...rest].sort((x, y) => -(x.market_cap_cr || 0) + (y.market_cap_cr || 0));
  const keys = ["close", "pe", "market_cap_cr", "div_yield", "np_qtr_cr", "qtr_profit_var", "sales_qtr_cr", "qtr_sales_var", "net_margin_ttm", "ret_1y"];
  return {
    industry: me.industry,
    peers: ordered,
    median: Object.fromEntries(keys.map((k) => [k, median(ordered.map((p) => p[k]))])),
    industrySize: db.scalar("SELECT COUNT(*) FROM company_metrics WHERE industry = ?", [me.industry]),
  };
}

export function syncStatus(db: Db, rawSymbol: string, startNow: boolean) {
  const symbol = rawSymbol.toUpperCase();
  const started = startNow ? sync.start(db, symbol) : false;
  return { ...sync.status(db, symbol), started };
}

// --- screens --------------------------------------------------------------------------------------
export const SCREEN_COLUMNS: Record<string, string> = {
  close: "Price", pct_1d: "Change %", market_cap_cr: "Market cap (Cr)", pe: "P/E", eps_ttm: "EPS TTM", div_yield: "Div yield %",
  np_qtr_cr: "Net profit qtr (Cr)", qtr_profit_var: "Qtr profit var %", sales_qtr_cr: "Sales qtr (Cr)", qtr_sales_var: "Qtr sales var %",
  sales_ttm_cr: "Sales TTM (Cr)", np_ttm_cr: "Net profit TTM (Cr)", opm_ttm: "OPM TTM %", net_margin_ttm: "Net margin TTM %",
  sales_growth_3y: "Sales growth 3Y %", profit_growth_3y: "Profit growth 3Y %", promoter: "Promoter %", ret_1m: "Return 1M %",
  ret_3m: "Return 3M %", ret_1y: "Return 1Y %", from_high: "From 52W high %", from_low: "From 52W low %", volume: "Volume",
  turnover: "Turnover", avg_eps_annual: "Avg annual EPS", earnings_years: "Years of earnings", price_to_avg_earnings: "Price / avg earnings",
  pb: "P/B", roe: "ROE %", gpm_ttm: "Gross margin TTM %", gross_profit_ttm_cr: "Gross profit TTM (Cr)", debt_to_equity: "Debt / equity",
  book_value_cr: "Book value (Cr)", ret_1w: "Return 1W %", ret_6m: "Return 6M %",
};
const OPS: Record<string, string> = { gt: ">", gte: ">=", lt: "<", lte: "<=", eq: "=" };

export const SAVED_SCREENS = [
  { key: "low-on-average-earnings", theme: "Value", title: "Low on long-run average earnings",
    description: "Graham-style: price is cheap against the average of yearly earnings across every complete fiscal year on file (at least three).",
    filters: [{ field: "price_to_avg_earnings", op: "gt", value: 0 }, { field: "price_to_avg_earnings", op: "lt", value: 15 }, { field: "earnings_years", op: "gte", value: 3 }],
    sort: "price_to_avg_earnings", order: "asc" },
  { key: "loss-to-profit", theme: "Turnaround", title: "Loss to profit",
    description: "Latest quarter is profitable and profit has swung up sharply year on year.",
    filters: [{ field: "np_qtr_cr", op: "gt", value: 0 }, { field: "qtr_profit_var", op: "gt", value: 100 }], sort: "qtr_profit_var", order: "desc" },
  { key: "new-highs", theme: "Momentum", title: "Companies near a 52-week high",
    description: "Closing within 2% of the one-year high, with real turnover.",
    filters: [{ field: "from_high", op: "gte", value: -2 }, { field: "turnover", op: "gt", value: 10000000 }], sort: "turnover", order: "desc" },
  { key: "low-pe-profitable", theme: "Value", title: "Low P/E, growing profit",
    description: "Trailing P/E under 15 with profit up on the same quarter last year.",
    filters: [{ field: "pe", op: "gt", value: 0 }, { field: "pe", op: "lt", value: 15 }, { field: "qtr_profit_var", op: "gt", value: 0 }], sort: "pe", order: "asc" },
  { key: "high-dividend", theme: "Income", title: "High dividend yield",
    description: "Dividends paid over the last twelve months yield more than 3%.",
    filters: [{ field: "div_yield", op: "gt", value: 3 }], sort: "div_yield", order: "desc" },
  { key: "promoter-backed-growth", theme: "Quality", title: "Promoter-backed growth",
    description: "Promoter holding above 50% with sales compounding faster than 15% a year.",
    filters: [{ field: "promoter", op: "gt", value: 50 }, { field: "sales_growth_3y", op: "gt", value: 15 }], sort: "sales_growth_3y", order: "desc" },
  { key: "beaten-down", theme: "Contrarian", title: "Beaten down over a year",
    description: "Down more than 30% in a year, still liquid.",
    filters: [{ field: "ret_1y", op: "lt", value: -30 }, { field: "turnover", op: "gt", value: 20000000 }], sort: "ret_1y", order: "asc" },
  { key: "margin-leaders", theme: "Quality", title: "Margin leaders",
    description: "Net margin over 20% on trailing twelve months, with at least Rs 100 Cr sales.",
    filters: [{ field: "net_margin_ttm", op: "gt", value: 20 }, { field: "sales_ttm_cr", op: "gt", value: 100 }], sort: "net_margin_ttm", order: "desc" },
];

export function screens(db: Db) {
  return {
    screens: SAVED_SCREENS,
    columns: SCREEN_COLUMNS,
    sectors: db.all("SELECT industry AS name, COUNT(*) AS companies FROM company_metrics WHERE industry IS NOT NULL GROUP BY industry ORDER BY industry"),
  };
}

export function runScreen(db: Db, b: Row) {
  const where = ["close IS NOT NULL"];
  const args: (string | number)[] = [];
  for (const f of (Array.isArray(b.filters) ? b.filters : []) as Row[]) {
    const col = f?.field, op = OPS[f?.op];
    if (!(col in SCREEN_COLUMNS) || !op) continue;
    const val = Number(f.value);
    if (f.value === null || f.value === "" || !Number.isFinite(val)) continue;
    where.push(`${col} ${op} ?`);
    args.push(val);
  }
  if (b.sector) { where.push("industry = ?"); args.push(String(b.sector)); }
  if (b.index) { where.push("symbol IN (SELECT symbol FROM nse_index_constituent WHERE index_symbol = ?)"); args.push(String(b.index)); }
  const q = String(b.q ?? "").trim();
  if (q) { where.push("(symbol LIKE ? OR company LIKE ?)"); args.push(`%${q}%`, `%${q}%`); }
  const sort = b.sort in SCREEN_COLUMNS ? b.sort : "market_cap_cr";
  const order = String(b.order).toLowerCase() === "asc" ? "ASC" : "DESC";
  const page = Math.max(1, Math.trunc(Number(b.page) || 1));
  const size = Math.max(10, Math.min(100, Math.trunc(Number(b.pageSize) || 25)));
  const clause = where.join(" AND ");
  return {
    total: db.scalar(`SELECT COUNT(*) FROM company_metrics WHERE ${clause}`, args),
    page, pageSize: size,
    results: db.all(`SELECT symbol, company, industry, ${Object.keys(SCREEN_COLUMNS).join(", ")} FROM company_metrics WHERE ${clause} ORDER BY ${sort} IS NULL, ${sort} ${order} LIMIT ? OFFSET ?`, [...args, size, (page - 1) * size]),
    coverage: {
      withFundamentals: db.scalar("SELECT COUNT(*) FROM company_metrics WHERE pe IS NOT NULL OR np_qtr_cr IS NOT NULL"),
      companies: db.scalar("SELECT COUNT(*) FROM company_metrics WHERE close IS NOT NULL"),
    },
  };
}

// --- heatmap & sector overview --------------------------------------------------------------------------
const HEATMAP_UNIVERSES: Record<string, string> = { nifty50: "NIFTY 50", nifty100: "NIFTY 100", nifty200: "NIFTY 200", nifty500: "NIFTY 500", niftytotalmarket: "NIFTY Total Market" };
const HEATMAP_METRICS: Record<string, string> = { pct_1d: "1 day", ret_1m: "1 month", ret_3m: "3 months", ret_1y: "1 year" };
const SECTOR_TABS: [string, string, string][] = [
  ["Financial Services", "Financial Services", "NIFTY FINANCIAL SERVICES"], ["Technology", "Information Technology", "NIFTY IT"],
  ["Consumer", "Fast Moving Consumer Goods", "NIFTY FMCG"], ["Auto", "Automobile and Auto Components", "NIFTY AUTO"],
  ["Healthcare", "Healthcare", "NIFTY PHARMA"], ["Energy", "Oil Gas & Consumable Fuels", "NIFTY OIL & GAS"],
  ["Metals", "Metals & Mining", "NIFTY METAL"], ["Realty", "Realty", "NIFTY REALTY"],
];

export function heatmap(db: Db, a: Args) {
  let universe = a.str("universe", "nifty100");
  let metric = a.str("metric", "pct_1d");
  if (!(metric in HEATMAP_METRICS)) metric = "pct_1d";
  let sql = `SELECT symbol, company, industry, close, market_cap_cr, ${metric} AS change FROM company_metrics WHERE market_cap_cr > 0 AND close IS NOT NULL`;
  const args: string[] = [];
  if (universe in HEATMAP_UNIVERSES) {
    sql += " AND symbol IN (SELECT symbol FROM nse_index_constituent WHERE index_symbol = ?)";
    args.push(universe);
  } else {
    universe = "all";
    sql += " AND industry IS NOT NULL";
  }
  sql += " ORDER BY market_cap_cr DESC LIMIT 600";
  const groups = new Map<string, Row>();
  for (const r of db.all(sql, args)) {
    const sector = r.industry || "Other";
    const g = groups.get(sector) ?? { sector, market_cap_cr: 0, companies: [] as Row[] };
    g.market_cap_cr += r.market_cap_cr;
    g.companies.push({ ...r });
    groups.set(sector, g);
  }
  const out = [...groups.values()].sort((x, y) => y.market_cap_cr - x.market_cap_cr);
  for (const g of out) {
    const weights = (g.companies as Row[]).filter((x) => x.change !== null).map((x) => [x.market_cap_cr, x.change]);
    const total = weights.reduce((s, [w]) => s + w, 0);
    g.change = total ? weights.reduce((s, [w, ch]) => s + w * ch, 0) / total : null;
  }
  return { universe, metric, universes: HEATMAP_UNIVERSES, metrics: HEATMAP_METRICS, asOf: db.scalar("SELECT MAX(trade_date) FROM company_metrics"), sectors: out };
}

export function sectorOverview(db: Db) {
  const tabs: Row[] = [];
  for (const [label, industry, indexName] of SECTOR_TABS) {
    const latest = db.get("SELECT close, pts_change, pct_change, trade_date FROM nse_index_history WHERE index_name = ? ORDER BY trade_date DESC LIMIT 1", [indexName]) ?? null;
    const leaders = db.all("SELECT symbol, company, close, change, pct_1d, market_cap_cr FROM company_metrics WHERE industry = ? AND close IS NOT NULL ORDER BY market_cap_cr DESC NULLS LAST LIMIT 12", [industry]);
    if (latest || leaders.length) tabs.push({ label, industry, index: indexName, latest, leaders });
  }
  return { tabs };
}

// --- paginated feeds ----------------------------------------------------------------------------------------
const pageArgs = (a: Args, def = 25) => {
  const page = a.int("page", 1, 1, 100000);
  const size = a.int("pageSize", def, 5, 200);
  return [page, size, (page - 1) * size] as const;
};

const MAX_FILINGS_OFFSET = 10000;
const COUNT_CAP = 100000;

/** Announcements from both exchanges: each table read newest-first and only the rows for this page merged. */
export function filings(db: Db, a: Args) {
  const [page, size, rawOffset] = pageArgs(a);
  const q = a.str("q").trim();
  const exchange = a.str("exchange").toLowerCase();
  if (!["", "nse", "bse"].includes(exchange)) throw badRequest("exchange must be nse or bse");
  const from = a.str("from"), to = a.str("to");
  for (const v of [from, to]) if (v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw badRequest("dates must be YYYY-MM-DD");
  const match = q && ftsAvailable(db) ? matchQuery(q) : "";
  const fts = Boolean(match);
  const capped = rawOffset + size > MAX_FILINGS_OFFSET;
  const offset = Math.min(rawOffset, Math.max(0, MAX_FILINGS_OFFSET - size));
  const need = offset + size;

  const sources: [body: string, args: string[], select: string, order: string][] = [];
  if (exchange !== "bse") {
    const where: string[] = [], args: string[] = [];
    if (fts) { where.push("rowid IN (SELECT rowid FROM nse_announcement_fts WHERE nse_announcement_fts MATCH ? UNION SELECT rowid FROM nse_announcement WHERE symbol = ?)"); args.push(match, q.toUpperCase()); }
    else if (q) { where.push("(subject LIKE ? OR symbol LIKE ? OR company LIKE ?)"); args.push(`%${q}%`, `%${q}%`, `%${q}%`); }
    if (from) { where.push("ann_dt >= ?"); args.push(from); }
    if (to) { where.push("ann_dt < date(?, '+1 day')"); args.push(to); }
    sources.push([`FROM nse_announcement${where.length ? ` WHERE ${where.join(" AND ")}` : ""}`, args, "SELECT symbol AS id, company, subject AS title, ann_dt AS dt, pdf_url AS url, 'NSE' AS exchange ", "ann_dt"]);
  }
  if (exchange !== "nse") {
    const where: string[] = [], args: string[] = [];
    if (fts) { where.push("a.rowid IN (SELECT rowid FROM announcement_fts WHERE announcement_fts MATCH ? UNION SELECT rowid FROM announcement WHERE scrip_cd IN (SELECT scrip_cd FROM scrip WHERE scrip_cd = ? OR scrip_name LIKE ? OR scrip_id LIKE ?))"); args.push(match, q, `%${q}%`, `${q.toUpperCase()}%`); }
    else if (q) { where.push("(a.headline LIKE ? OR a.scrip_cd = ? OR a.scrip_cd IN (SELECT scrip_cd FROM scrip WHERE scrip_name LIKE ? OR scrip_id LIKE ?))"); args.push(`%${q}%`, q, `%${q}%`, `${q.toUpperCase()}%`); }
    if (from) { where.push("a.news_dt >= ?"); args.push(from); }
    if (to) { where.push("a.news_dt < date(?, '+1 day')"); args.push(to); }
    sources.push([`FROM announcement a${where.length ? ` WHERE ${where.join(" AND ")}` : ""}`, args, "SELECT a.scrip_cd AS id, NULL AS company, a.headline AS title, a.news_dt AS dt, a.pdf_url AS url, 'BSE' AS exchange ", "a.news_dt"]);
  }
  let total = 0;
  const merged: Row[] = [];
  for (const [bodySql, args, select, order] of sources) {
    total += db.scalar<number>(`SELECT COUNT(*) FROM (SELECT 1 ${bodySql} LIMIT ${COUNT_CAP})`, args) || 0;
    merged.push(...db.all(`${select} ${bodySql} ORDER BY ${order} DESC LIMIT ?`, [...args, need]).map((r) => ({ ...r })));
  }
  merged.sort((x, y) => (String(y.dt ?? "") < String(x.dt ?? "") ? -1 : String(y.dt ?? "") > String(x.dt ?? "") ? 1 : 0));
  const items = merged.slice(offset, offset + size);
  const bseCodes = items.filter((i) => i.exchange === "BSE").map((i) => i.id);
  if (bseCodes.length) {
    const names = new Map(db.all(`SELECT scrip_cd, scrip_name FROM scrip WHERE scrip_cd IN (${placeholders(bseCodes.length)})`, bseCodes).map((r) => [r.scrip_cd, r.scrip_name]));
    const nseOf = new Map(db.all(`SELECT bse_code, symbol FROM company_metrics WHERE bse_code IN (${placeholders(bseCodes.length)})`, bseCodes).map((r) => [r.bse_code, r.symbol]));
    for (const it of items) {
      if (it.exchange !== "BSE") continue;
      it.company = names.get(it.id) ?? null;
      it.bseCode = it.id;
      it.id = nseOf.get(it.id) ?? it.id;
    }
  }
  const ids = [...new Set(items.map((i) => i.id).filter(Boolean))];
  const known = new Set(ids.length ? db.all(`SELECT symbol FROM company_metrics WHERE symbol IN (${placeholders(ids.length)})`, ids).map((r) => r.symbol) : []);
  for (const it of items) it.hasPage = known.has(it.id) || it.exchange === "BSE";
  return { total, totalCapped: total >= COUNT_CAP, page, pageSize: size, items, pageCapped: capped, maxPage: Math.floor(MAX_FILINGS_OFFSET / size) };
}

export function insider(db: Db, a: Args) {
  const [page, size, offset] = pageArgs(a);
  const q = a.str("q").trim();
  const side = a.str("side").toLowerCase();
  const where = ["1=1"];
  const args: string[] = [];
  if (q) { where.push("(symbol LIKE ? OR company LIKE ? OR acquirer LIKE ?)"); args.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  if (["buy", "sell", "pledge"].includes(side)) { where.push("LOWER(COALESCE(txn_type,'')) LIKE ?"); args.push(`%${side}%`); }
  const clause = where.join(" AND ");
  return {
    total: db.scalar(`SELECT COUNT(*) FROM nse_insider_trade WHERE ${clause}`, args),
    page, pageSize: size,
    items: db.all(`SELECT symbol, company, acquirer, security, broadcast, quantity, value, txn_type FROM nse_insider_trade WHERE ${clause} ORDER BY broadcast DESC LIMIT ? OFFSET ?`, [...args, size, offset]),
  };
}
