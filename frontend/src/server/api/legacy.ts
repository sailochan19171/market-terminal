// The original /api endpoints (movers, breadth, sectors, corporate actions, portfolio, watchlist, alerts).
import type { Db, Row } from "../db";
import { latestSnapshot, saveWatchlist } from "../core/portfolio";
import { evaluate, markSent, unsent } from "../alerts/rules";
import { buildChannels, sendAll } from "../alerts/channels";
import { ApiError, type Args } from "./common";

const EXCH = {
  bse: { label: "BSE", key: "scrip_cd", master: "scrip", name_col: "scrip_name", prices: "bhavcopy", actions: "corp_action" },
  nse: { label: "NSE", key: "symbol", master: "nse_symbol", name_col: "company", prices: "nse_bhavcopy", actions: "nse_corp_action" },
};

function spec(name: string) {
  const s = EXCH[(name || "bse").toLowerCase() as keyof typeof EXCH];
  if (!s) throw new ApiError(400, `unknown exchange '${name}'`, { error: "bad_request" });
  return s;
}

export function movers(db: Db, a: Args) {
  const s = spec(a.str("exchange", "nse"));
  const limit = a.int("limit", 25, 1, 200);
  const day = db.scalar<string>(`SELECT MAX(trade_date) FROM ${s.prices}`);
  if (!day) return { day: null, gainers: [], losers: [] };
  // Qualified: nse_symbol also has a `series` column.
  const series = s.key === "symbol" ? " AND p.series = 'EQ'" : "";
  const sql = (dir: string) =>
    `SELECT p.${s.key} AS id, m.${s.name_col} AS name, p.close, p.prev_close, p.volume, p.turnover, (p.close - p.prev_close) / p.prev_close * 100.0 AS pct `
    + `FROM ${s.prices} p LEFT JOIN ${s.master} m ON m.${s.key} = p.${s.key} WHERE p.trade_date = ? AND p.prev_close > 0 AND p.close IS NOT NULL${series} ORDER BY pct ${dir} LIMIT ?`;
  return {
    day,
    gainers: db.all(sql("DESC"), [day, limit]),
    losers: db.all(sql("ASC"), [day, limit]),
    active: db.all(
      `SELECT p.${s.key} AS id, m.${s.name_col} AS name, p.close, p.prev_close, p.volume, p.turnover, (p.close - p.prev_close) / NULLIF(p.prev_close,0) * 100.0 AS pct `
      + `FROM ${s.prices} p LEFT JOIN ${s.master} m ON m.${s.key} = p.${s.key} WHERE p.trade_date = ?${series} AND p.turnover IS NOT NULL ORDER BY p.turnover DESC LIMIT ?`,
      [day, limit]),
  };
}

export function actions(db: Db, a: Args) {
  const days = a.int("days", 30, 1, 400);
  const out: Row[] = [];
  for (const [name, s] of Object.entries(EXCH)) {
    for (const r of db.all(`SELECT ${s.key} AS id, purpose, ex_date, record_date FROM ${s.actions} WHERE ex_date >= date('now') AND ex_date <= date('now', ?) ORDER BY ex_date LIMIT 500`, [`+${days} day`])) {
      out.push({ ...r, exchange: s.label, ex: name });
    }
  }
  out.sort((x, y) => String(x.ex_date ?? "").localeCompare(String(y.ex_date ?? "")));
  return { actions: out };
}

export function breadth(db: Db, a: Args) {
  const s = spec(a.str("exchange", "nse"));
  const days = a.int("days", 60, 1, 400);
  const series = s.key === "symbol" ? " AND series = 'EQ'" : "";
  return {
    breadth: db.all(
      "SELECT trade_date, SUM(CASE WHEN close > prev_close THEN 1 ELSE 0 END) AS advances, SUM(CASE WHEN close < prev_close THEN 1 ELSE 0 END) AS declines, "
      + `SUM(CASE WHEN close = prev_close THEN 1 ELSE 0 END) AS unchanged FROM ${s.prices} WHERE prev_close > 0 AND close IS NOT NULL${series} `
      + `AND trade_date >= date((SELECT MAX(trade_date) FROM ${s.prices}), ?) GROUP BY trade_date ORDER BY trade_date`, [`-${days} day`]),
  };
}

export function sectors(db: Db) {
  return {
    sectors: db.all(
      "WITH d AS (SELECT MAX(trade_date) x FROM nse_bhavcopy), ind AS (SELECT DISTINCT symbol, industry FROM nse_index_constituent WHERE industry IS NOT NULL AND industry != '') "
      + "SELECT ind.industry AS sector, COUNT(*) AS members, ROUND(AVG((b.close - b.prev_close) / NULLIF(b.prev_close,0) * 100.0), 2) AS avg_pct, SUM(b.turnover) AS turnover "
      + "FROM ind JOIN nse_bhavcopy b ON b.symbol = ind.symbol AND b.series='EQ' AND b.trade_date = (SELECT x FROM d) WHERE b.prev_close > 0 GROUP BY ind.industry ORDER BY avg_pct DESC"),
  };
}

export function distribution(db: Db, a: Args) {
  const s = spec(a.str("exchange", "nse"));
  const series = s.key === "symbol" ? " AND series = 'EQ'" : "";
  return {
    buckets: db.all(
      `WITH d AS (SELECT MAX(trade_date) x FROM ${s.prices}), m AS (SELECT (close - prev_close) / NULLIF(prev_close,0) * 100.0 AS pct FROM ${s.prices} `
      + `WHERE trade_date = (SELECT x FROM d) AND prev_close > 0 AND close IS NOT NULL${series}) `
      + "SELECT CAST(MAX(-10, MIN(10, ROUND(pct))) AS INTEGER) AS bucket, COUNT(*) AS n FROM m GROUP BY bucket ORDER BY bucket"),
  };
}

export function portfolio(db: Db) {
  const holds = latestSnapshot(db);
  const totalValue = holds.reduce((t, h) => t + (h.value || 0), 0);
  const totalCost = holds.reduce((t, h) => t + (h.cost || 0), 0);
  return {
    holdings: holds,
    total_value: totalValue,
    total_cost: totalCost,
    gain: totalValue - totalCost,
    gain_pct: totalCost ? ((totalValue - totalCost) / totalCost) * 100 : null,
    brokers: db.all<{ broker: string }>("SELECT DISTINCT broker FROM holding ORDER BY broker").map((r) => r.broker),
  };
}

export function watchlistGet(db: Db, name: string) {
  // Quotes come from company_metrics: NSE rows by symbol, BSE rows through the scrip's BSE code or ISIN.
  return {
    watchlist: db.all(
      "SELECT w.symbol, w.scrip_cd, w.exchange, w.source, w.added_at, COALESCE(m.company, s.scrip_name, n.company) AS name, "
      + "m.symbol AS nse_symbol, m.industry, m.close, m.change, m.pct_1d, m.pe, m.market_cap_cr, m.ret_1m, m.ret_1y, m.high_52w, m.low_52w, m.trade_date "
      + "FROM watchlist w LEFT JOIN scrip s ON s.scrip_cd = w.scrip_cd "
      + "LEFT JOIN nse_symbol n ON n.symbol = w.symbol AND UPPER(w.exchange) = 'NSE' "
      + "LEFT JOIN company_metrics m ON m.symbol = (CASE WHEN UPPER(w.exchange) = 'NSE' THEN w.symbol ELSE ("
      + "  SELECT m2.symbol FROM company_metrics m2 WHERE m2.bse_code = w.scrip_cd OR (s.isin IS NOT NULL AND m2.isin = s.isin) LIMIT 1) END) "
      + "WHERE w.name = ? ORDER BY w.added_at DESC, w.exchange, w.symbol", [name]),
  };
}

export function watchlistAdd(db: Db, name: string, body: Row) {
  let raw: unknown = body.symbols ?? [];
  if (typeof raw === "string") raw = raw.replaceAll(",", " ").split(/\s+/);
  const list = Array.isArray(raw) ? raw : [];
  const exchange = String(body.exchange || "NSE").toUpperCase();
  if (exchange !== "NSE" && exchange !== "BSE") throw new ApiError(400, "exchange must be NSE or BSE", { error: "exchange must be NSE or BSE" });

  const entries: Row[] = [];
  const unknown: string[] = [];
  for (const s of new Set(list.map((x) => String(x).trim().toUpperCase()).filter(Boolean))) {
    if (exchange === "NSE") {
      const hit = db.scalar<string>("SELECT symbol FROM company_metrics WHERE UPPER(symbol) = ? UNION SELECT symbol FROM nse_symbol WHERE UPPER(symbol) = ? LIMIT 1", [s, s]);
      if (hit) entries.push({ symbol: hit, exchange: "NSE" });
      else unknown.push(s);
    } else {
      // BSE accepts a scrip code or a scrip id (ticker).
      const hit = db.get("SELECT scrip_cd, scrip_id FROM scrip WHERE scrip_cd = ? OR UPPER(scrip_id) = ? ORDER BY (status = 'Active') DESC LIMIT 1", [s, s]);
      if (hit) entries.push({ symbol: hit.scrip_id || hit.scrip_cd, scrip_cd: hit.scrip_cd, exchange: "BSE" });
      else unknown.push(s);
    }
  }
  // Not an HTTP error: the page reports unknown symbols inline.
  if (!entries.length) return { added: 0, symbols: [], already: [], unknown };
  const existing = new Set(db.all<{ symbol: string }>("SELECT symbol FROM watchlist WHERE name = ? AND exchange = ?", [name, exchange]).map((r) => r.symbol));
  saveWatchlist(db, name, entries, "web");
  return {
    added: entries.filter((e) => !existing.has(e.symbol)).length,
    symbols: entries.filter((e) => !existing.has(e.symbol)).map((e) => e.symbol),
    already: entries.filter((e) => existing.has(e.symbol)).map((e) => e.symbol),
    unknown,
  };
}

export function watchlistRemove(db: Db, name: string, body: Row) {
  const items: Row[] = Array.isArray(body.items) ? body.items : [{ symbol: body.symbol, exchange: body.exchange }];
  let removed = 0;
  db.transaction(() => {
    for (const it of items) {
      if (!it?.symbol) continue;
      removed += Number(db.run("DELETE FROM watchlist WHERE name = ? AND UPPER(symbol) = UPPER(?) AND UPPER(exchange) = UPPER(?)", [name, String(it.symbol), String(it.exchange || "NSE")]).changes);
    }
  });
  return { removed };
}

export const alertRules = (db: Db) => ({ rules: db.all("SELECT id, name, kind, params, enabled FROM alert_rule ORDER BY name") });

export async function alertsRun(db: Db, body: Row) {
  const hits = evaluate(db, body.rule ?? null);
  const fresh = unsent(db, hits);
  let delivered = 0;
  if (body.send && fresh.length) {
    const channels = buildChannels();
    if (channels.length) {
      for (const h of fresh.slice(0, 50)) {
        const names = await sendAll(channels, h.subject, h.body);
        if (names.length) {
          markSent(db, h, names);
          delivered++;
        }
      }
    }
  }
  return {
    total: hits.length,
    new: fresh.length,
    delivered,
    hits: fresh.slice(0, 100).map((h) => ({ rule: h.rule_name, subject: h.subject, body: h.body, meta: h.meta })),
  };
}
