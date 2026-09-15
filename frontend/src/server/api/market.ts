// Market-wide feeds organised the way the exchanges present them: ticker, market summary, market watch,
// latest results, shareholding changes and board meetings. All end-of-day data.
import type { Db, Row } from "../db";
import { placeholders, todayIso } from "../util";
import { Args, badRequest } from "./common";
import { INDEX_NAMES } from "./v2";

const NSE_TICKER = ["NIFTY 50", "NIFTY BANK", "NIFTY NEXT 50", "NIFTY IT", "NIFTY MIDCAP 100", "NIFTY FINANCIAL SERVICES", "INDIA VIX"];
const BSE_TICKER = ["BSE SENSEX", "BSE BANKEX", "BSE SENSEX 50", "BSE 100", "BSE FOCUSED MIDCAP"];

const paging = (a: Args, def = 25) => {
  const page = a.int("page", 1, 1, 100000);
  const size = a.int("pageSize", def, 5, 200);
  return [page, size, (page - 1) * size] as const;
};

export function ticker(db: Db) {
  const nseDay = db.scalar<string>("SELECT MAX(trade_date) FROM nse_index_history");
  const nse = db.all(`SELECT index_name AS name, display_name AS label, close AS value, pts_change AS change, pct_change AS pct FROM nse_index_history WHERE trade_date = ? AND index_name IN (${placeholders(NSE_TICKER.length)})`, [nseDay, ...NSE_TICKER])
    .map((r): Row => ({ ...r, exchange: "NSE", href: `/indices/${r.name}` })).sort((x, y) => NSE_TICKER.indexOf(x.name) - NSE_TICKER.indexOf(y.name));
  const bseAsOf = db.scalar<string>("SELECT MAX(as_of) FROM index_value");
  const bse = db.all(`SELECT i.index_name AS name, i.index_name AS label, v.value, v.change, v.pct_change AS pct FROM index_value v JOIN bse_index i ON i.index_code = v.index_code WHERE v.as_of = ? AND i.index_name IN (${placeholders(BSE_TICKER.length)})`, [bseAsOf, ...BSE_TICKER])
    .map((r): Row => ({ ...r, exchange: "BSE", href: "/markets?exchange=BSE" })).sort((x, y) => BSE_TICKER.indexOf(x.name) - BSE_TICKER.indexOf(y.name));
  return { nse: { session: nseDay, items: nse }, bse: { asOf: bseAsOf, session: db.scalar("SELECT MAX(trade_date) FROM bhavcopy"), items: bse } };
}

const NSE_SERIES: Record<string, string> = {
  EQ: "Equity (rolling settlement)", BE: "Trade-for-trade equity", BZ: "Trade-for-trade (Z)", SM: "SME emerge", ST: "SME trade-for-trade",
  GS: "Government securities", GB: "Gold / G-sec bonds", SG: "Sovereign gold bonds", IV: "InvIT units", RR: "REIT units", BL: "Block deals", MF: "Mutual fund units",
};
const BSE_GROUPS: Record<string, string> = {
  A: "Group A", B: "Group B", T: "Group T (trade-for-trade)", X: "Group X", XT: "Group XT", M: "SME (M)", MT: "SME trade-for-trade (MT)",
  Z: "Group Z", F: "Debt instruments (F)", G: "Government securities (G)", IF: "Institutional (IF)", E: "ETF (E)", R: "Rights (R)",
};

function exchangeArg(a: Args): "NSE" | "BSE" {
  const ex = (a.str("exchange") || "NSE").toUpperCase();
  if (ex !== "NSE" && ex !== "BSE") throw badRequest("exchange must be NSE or BSE");
  return ex;
}

function seriesLabel(ex: string, series: string) {
  if (ex === "NSE") {
    if (NSE_SERIES[series]) return NSE_SERIES[series];
    return "NYZEDP".includes(series.slice(0, 1)) && series ? `Bonds and debentures (${series})` : `Other (${series})`;
  }
  return BSE_GROUPS[series] ?? `Group ${series}`;
}

export function summary(db: Db, a: Args) {
  const ex = exchangeArg(a);
  const table = ex === "NSE" ? "nse_bhavcopy" : "bhavcopy";
  const sessions = db.all<{ trade_date: string }>(`SELECT trade_date FROM ${table}_day WHERE status = 'ok' ORDER BY trade_date DESC LIMIT 21`).map((r) => r.trade_date);
  if (!sessions.length) return { status: 404, data: { error: "no_data", message: `No ${ex} sessions stored yet.` } };
  const day = sessions[0];
  const bySeries = db.all(`SELECT series, COUNT(*) securities, SUM(close > prev_close) advances, SUM(close < prev_close) declines, SUM(close = prev_close) unchanged, SUM(volume) volume, SUM(turnover) / 1e7 turnover_cr, SUM(num_trades) trades FROM ${table} WHERE trade_date = ? AND close IS NOT NULL GROUP BY series ORDER BY turnover_cr DESC`, [day])
    .map((r): Row => ({ ...r, label: seriesLabel(ex, r.series || "") }));
  const totals: Row = {};
  for (const k of ["securities", "advances", "declines", "unchanged", "volume", "turnover_cr", "trades"]) totals[k] = bySeries.reduce((s, r) => s + (r[k] || 0), 0);

  const equityFilter = ex === "NSE" ? "series IN ('EQ','BE','BZ','SM','ST')" : "instrument = 'STK' AND series NOT IN ('F','G')";
  const ef = equityFilter.replace("series", "b.series").replace("instrument", "b.instrument");
  const [nameSql, join, link] = ex === "NSE"
    ? ["COALESCE(m.company, n.company, b.symbol)", "LEFT JOIN company_metrics m ON m.symbol = b.symbol LEFT JOIN nse_symbol n ON n.symbol = b.symbol", "b.symbol"]
    : ["COALESCE(s.scrip_name, b.ticker)", "LEFT JOIN scrip s ON s.scrip_cd = b.scrip_cd LEFT JOIN company_metrics m ON m.bse_code = b.scrip_cd", "COALESCE(m.symbol, b.scrip_cd)"];
  const top = (order: string, extra = "", n = 10) => db.all(`SELECT ${link} AS key, ${nameSql} AS company, b.series, b.close, b.prev_close, CASE WHEN b.prev_close > 0 THEN (b.close - b.prev_close) / b.prev_close * 100 END AS pct, b.volume, b.turnover / 1e7 AS turnover_cr FROM ${table} b ${join} WHERE b.trade_date = ? AND ${ef} AND b.close IS NOT NULL ${extra} ORDER BY ${order} LIMIT ${n}`, [day]);
  const liquid = "AND b.turnover >= 1e7";
  const history = db.all(`SELECT trade_date, SUM(close > prev_close) advances, SUM(close < prev_close) declines, SUM(turnover) / 1e7 turnover_cr FROM ${table} WHERE trade_date IN (${placeholders(sessions.length)}) AND ${equityFilter} GROUP BY trade_date ORDER BY trade_date`, sessions);
  return {
    status: 200,
    data: {
      exchange: ex, session: day, previousSession: sessions[1] ?? null, totals, bySeries,
      topTurnover: top("b.turnover DESC"), gainers: top("pct DESC", liquid, 8), losers: top("pct ASC", liquid, 8),
      breadthHistory: history, source: `${ex} bhavcopy for ${day} (end of day)`,
    },
  };
}

const WATCH_SORT: Record<string, string> = {
  company: "company", close: "b.close", pct: "pct", change: "change", volume: "b.volume", turnover: "b.turnover", trades: "b.num_trades",
  high52: "m.high_52w", low52: "m.low_52w", mcap: "m.market_cap_cr",
};

export function watch(db: Db, a: Args) {
  const ex = exchangeArg(a);
  const [page, size, offset] = paging(a, 50);
  const sort = a.str("sort") || "turnover";
  if (!(sort in WATCH_SORT)) throw badRequest(`sort must be one of ${Object.keys(WATCH_SORT).join(", ")}`);
  const order = (a.str("order") || "desc").toLowerCase() === "asc" ? "ASC" : "DESC";
  const table = ex === "NSE" ? "nse_bhavcopy" : "bhavcopy";
  const day = db.scalar<string>(`SELECT MAX(trade_date) FROM ${table}`);
  const where = ["b.trade_date = ?", "b.close IS NOT NULL"];
  const args: (string | null)[] = [day];
  const [name, join, ident, member] = ex === "NSE"
    ? ["COALESCE(m.company, n.company, b.symbol)", "LEFT JOIN company_metrics m ON m.symbol = b.symbol LEFT JOIN nse_symbol n ON n.symbol = b.symbol", "b.symbol AS key, b.symbol AS symbol, m.bse_code AS bseCode", "b.symbol"]
    : ["COALESCE(s.scrip_name, b.ticker)", "LEFT JOIN scrip s ON s.scrip_cd = b.scrip_cd LEFT JOIN company_metrics m ON m.bse_code = b.scrip_cd", "COALESCE(m.symbol, b.scrip_cd) AS key, m.symbol AS symbol, b.scrip_cd AS bseCode", "m.symbol"];
  const series = a.str("series").toUpperCase();
  if (series === "EQUITY") where.push(ex === "NSE" ? "b.series IN ('EQ','BE','BZ','SM','ST')" : "b.instrument = 'STK' AND b.series NOT IN ('F','G')");
  else if (series) {
    if (!/^[A-Z0-9]{1,3}$/.test(series)) throw badRequest("invalid series");
    where.push("b.series = ?");
    args.push(series);
  }
  const index = a.str("index");
  if (index) { where.push(`${member} IN (SELECT symbol FROM nse_index_constituent WHERE index_symbol = ?)`); args.push(index); }
  const q = a.str("q").trim();
  if (q) {
    where.push(`(${name} LIKE ? OR ${ex === "NSE" ? "b.symbol" : "b.scrip_cd || ' ' || COALESCE(b.ticker, '')"} LIKE ?)`);
    args.push(`%${q}%`, `%${q.toUpperCase()}%`);
  }
  const move = a.str("move");
  if (move === "gainers") where.push("b.close > b.prev_close");
  else if (move === "losers") where.push("b.close < b.prev_close");
  else if (move === "high52") where.push("m.high_52w IS NOT NULL AND b.close >= m.high_52w * 0.99");
  else if (move === "low52") where.push("m.low_52w IS NOT NULL AND b.close <= m.low_52w * 1.01");
  const select = `SELECT ${ident}, ${name} AS company, b.series, b.open, b.high, b.low, b.close, b.prev_close, b.close - b.prev_close AS change, CASE WHEN b.prev_close > 0 THEN (b.close - b.prev_close) / b.prev_close * 100 END AS pct, b.volume, b.turnover / 1e7 AS turnover_cr, b.num_trades AS trades, m.high_52w, m.low_52w, m.market_cap_cr FROM ${table} b ${join} WHERE ${where.join(" AND ")}`;
  return {
    exchange: ex, session: day,
    total: db.scalar(`SELECT COUNT(*) FROM (${select})`, args),
    page, pageSize: size,
    items: db.all(`${select} ORDER BY ${WATCH_SORT[sort]} IS NULL, ${WATCH_SORT[sort]} ${order} LIMIT ? OFFSET ?`, [...args, size, offset]),
    series: db.all(`SELECT series, COUNT(*) n FROM ${table} WHERE trade_date = ? GROUP BY series ORDER BY COUNT(*) DESC`, [day]).map((r) => ({ value: r.series, label: seriesLabel(ex, r.series || ""), count: r.n })),
    indices: db.all("SELECT index_symbol, COUNT(*) n FROM nse_index_constituent GROUP BY index_symbol ORDER BY COUNT(*)").map((r) => ({ value: r.index_symbol, label: INDEX_NAMES[r.index_symbol] ?? String(r.index_symbol).toUpperCase(), members: r.n })),
  };
}

export function results(db: Db, a: Args) {
  const [page, size, offset] = paging(a, 25);
  const quarters = db.all("SELECT period_end, COUNT(DISTINCT symbol) companies FROM nse_fundamental WHERE quality = 'ok' AND period_end >= date('now', '-3 years') GROUP BY period_end HAVING companies >= 20 ORDER BY period_end DESC LIMIT 12");
  const quarter = a.str("quarter") || (quarters.length ? quarters[0].period_end : null);
  if (!quarter) return { quarters: [], items: [], total: 0, page, pageSize: size };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(quarter)) throw badRequest("quarter must be YYYY-MM-DD");
  const basis = (a.str("basis") || "preferred").toLowerCase();
  if (!["preferred", "consolidated", "standalone"].includes(basis)) throw badRequest("basis must be preferred, consolidated or standalone");
  const prior = `${parseInt(quarter.slice(0, 4), 10) - 1}${quarter.slice(4)}`;
  const basisFilter = basis === "consolidated" ? "AND f.consolidated LIKE 'Consol%'" : basis === "standalone" ? "AND f.consolidated NOT LIKE 'Consol%'" : "";
  const base = `WITH cur AS (SELECT f.*, ROW_NUMBER() OVER (PARTITION BY f.symbol ORDER BY f.consolidated LIKE 'Consol%' DESC) rn FROM nse_fundamental f WHERE f.period_end = ? AND f.quality = 'ok' ${basisFilter}) `
    + "SELECT cur.symbol, COALESCE(m.company, cur.company) company, m.industry, cur.consolidated basis, r.broadcast_dt filed_at, cur.revenue / 1e7 revenue_cr, cur.pat / 1e7 profit_cr, cur.eps_basic eps, "
    + "CASE WHEN cur.revenue > 0 THEN cur.pat * 100.0 / cur.revenue END npm, CASE WHEN p.revenue > 0 THEN (cur.revenue - p.revenue) * 100.0 / p.revenue END revenue_yoy, "
    + "CASE WHEN p.pat != 0 THEN (cur.pat - p.pat) * 100.0 / ABS(p.pat) END profit_yoy, m.close, m.pe, m.market_cap_cr "
    + "FROM cur LEFT JOIN nse_fundamental p ON p.symbol = cur.symbol AND p.period_end = ? AND p.consolidated = cur.consolidated AND p.quality = 'ok' "
    + "LEFT JOIN nse_financial_result r ON r.symbol = cur.symbol AND r.period_end = cur.period_end AND r.consolidated = cur.consolidated "
    + "LEFT JOIN company_metrics m ON m.symbol = cur.symbol WHERE cur.rn = 1";
  const args: string[] = [quarter, prior];
  const where: string[] = [];
  const q = a.str("q").trim();
  if (q) { where.push("(symbol LIKE ? OR company LIKE ?)"); args.push(`${q.toUpperCase()}%`, `%${q}%`); }
  const sector = a.str("sector");
  if (sector) { where.push("industry = ?"); args.push(sector); }
  const profit = a.str("profit");
  if (profit === "up") where.push("profit_yoy > 0");
  else if (profit === "down") where.push("profit_yoy < 0");
  else if (profit === "loss") where.push("profit_cr < 0");
  else if (profit === "turnaround") {
    where.push("profit_cr > 0 AND profit_yoy IS NOT NULL AND symbol IN (SELECT symbol FROM nse_fundamental WHERE period_end = ? AND pat < 0)");
    args.push(prior);
  }
  const sort = a.str("sort") || "filed_at";
  const sorts: Record<string, string> = { filed_at: "filed_at", revenue: "revenue_cr", profit: "profit_cr", profit_yoy: "profit_yoy", revenue_yoy: "revenue_yoy", mcap: "market_cap_cr", npm: "npm" };
  if (!(sort in sorts)) throw badRequest(`sort must be one of ${Object.keys(sorts).join(", ")}`);
  const order = (a.str("order") || "desc").toLowerCase() === "asc" ? "ASC" : "DESC";
  const outer = `SELECT * FROM (${base}) x ${where.length ? `WHERE ${where.join(" AND ")}` : ""}`;
  return {
    quarter, priorQuarter: prior, quarters,
    sectors: db.all("SELECT DISTINCT industry FROM company_metrics WHERE industry IS NOT NULL ORDER BY 1").map((r) => r.industry),
    stats: db.get(`SELECT COUNT(*) reported, SUM(profit_yoy > 0) profit_up, SUM(profit_yoy < 0) profit_down, SUM(profit_cr < 0) losses, SUM(revenue_cr) revenue_cr, SUM(profit_cr) profit_cr FROM (${outer})`, args) ?? null,
    total: db.scalar(`SELECT COUNT(*) FROM (${outer})`, args),
    page, pageSize: size,
    items: db.all(`${outer} ORDER BY ${sorts[sort]} IS NULL, ${sorts[sort]} ${order} LIMIT ? OFFSET ?`, [...args, size, offset]),
  };
}

export function shareholdingChanges(db: Db, a: Args) {
  const [page, size, offset] = paging(a, 25);
  const category = (a.str("category") || "fii").toLowerCase();
  if (!["promoter", "fii", "dii", "public"].includes(category)) throw badRequest("category must be promoter, fii, dii or public");
  const direction = a.str("direction").toLowerCase();
  const base = "WITH ranked AS (SELECT d.*, ROW_NUMBER() OVER (PARTITION BY d.symbol ORDER BY d.as_of_date DESC) rn FROM nse_shareholding_detail d WHERE d.status = 'ok'), "
    + "pairs AS (SELECT a.symbol, a.as_of_date, b.as_of_date prev_date, a.promoter, a.fii, a.dii, a.public, a.shareholders, "
    + "a.promoter - b.promoter d_promoter, a.fii - b.fii d_fii, a.dii - b.dii d_dii, a.public - b.public d_public, a.shareholders - b.shareholders d_shareholders "
    + "FROM ranked a JOIN ranked b ON b.symbol = a.symbol AND b.rn = 2 WHERE a.rn = 1) "
    + "SELECT p.*, COALESCE(m.company, p.symbol) company, m.industry, m.close, m.pct_1d, m.market_cap_cr FROM pairs p LEFT JOIN company_metrics m ON m.symbol = p.symbol";
  const where = [`d_${category} IS NOT NULL`];
  const args: string[] = [];
  if (direction === "up") where.push(`d_${category} > 0.009`);
  else if (direction === "down") where.push(`d_${category} < -0.009`);
  const q = a.str("q").trim();
  if (q) { where.push("(symbol LIKE ? OR company LIKE ?)"); args.push(`${q.toUpperCase()}%`, `%${q}%`); }
  const outer = `SELECT * FROM (${base}) x WHERE ${where.join(" AND ")}`;
  return {
    category,
    total: db.scalar(`SELECT COUNT(*) FROM (${outer})`, args),
    page, pageSize: size,
    items: db.all(`${outer} ORDER BY d_${category} ${direction === "down" ? "ASC" : "DESC"}, market_cap_cr DESC LIMIT ? OFFSET ?`, [...args, size, offset]),
    coverage: db.scalar("SELECT COUNT(DISTINCT symbol) FROM nse_shareholding_detail WHERE status = 'ok'"),
    listed: db.scalar("SELECT COUNT(*) FROM company_metrics WHERE close IS NOT NULL"),
  };
}

const PURPOSES: Record<string, string> = { results: "%result%", dividend: "%dividend%", fund: "%fund%", bonus: "%bonus%", split: "%split%", buyback: "%buy%back%" };

export function boardMeetings(db: Db, a: Args) {
  const [page, size, offset] = paging(a, 25);
  const when = (a.str("when") || "upcoming").toLowerCase();
  if (when !== "upcoming" && when !== "past") throw badRequest("when must be upcoming or past");
  const today = todayIso();
  const where = [when === "upcoming" ? "b.meeting_dt >= ?" : "b.meeting_dt < ?"];
  const args: string[] = [today];
  const purpose = a.str("purpose").toLowerCase();
  if (purpose) {
    if (!PURPOSES[purpose]) throw badRequest(`purpose must be one of ${Object.keys(PURPOSES).join(", ")}`);
    where.push("(LOWER(b.purpose) LIKE ? OR LOWER(b.description) LIKE ?)");
    args.push(PURPOSES[purpose], PURPOSES[purpose]);
  }
  const q = a.str("q").trim();
  if (q) { where.push("(b.symbol LIKE ? OR b.company LIKE ?)"); args.push(`${q.toUpperCase()}%`, `%${q}%`); }
  const clause = where.join(" AND ");
  return {
    when,
    total: db.scalar(`SELECT COUNT(*) FROM nse_board_meeting b WHERE ${clause}`, args),
    page, pageSize: size,
    items: db.all(`SELECT b.symbol, COALESCE(m.company, b.company) company, b.meeting_dt, b.purpose, b.description, m.close, m.pct_1d FROM nse_board_meeting b LEFT JOIN company_metrics m ON m.symbol = b.symbol WHERE ${clause} ORDER BY b.meeting_dt ${when === "upcoming" ? "ASC" : "DESC"}, b.symbol LIMIT ? OFFSET ?`, [...args, size, offset]),
    nextSevenDays: db.scalar("SELECT COUNT(*) FROM nse_board_meeting WHERE meeting_dt BETWEEN ? AND date(?, '+7 day')", [today, today]),
  };
}

