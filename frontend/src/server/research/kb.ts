// The knowledge base the research answers read from.
//
// Exchange filings are already stored as short, searchable text, so they are indexed where they are. What was
// missing is everything held as numbers: results, balance sheets, cash flows, shareholding, corporate actions
// and company profiles. This module writes those out as small documents, each carrying the filing it came from,
// and indexes them for full-text search so a question can reach them.
//
// Documents are rebuilt per company whenever that company's data moves, so the base tracks the pipeline.
import { now, type Db, type Row } from "../db";
import { logger } from "../log";
import { toNum } from "../util";

const log = logger("kb");

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS kb_doc (
    id         TEXT PRIMARY KEY,          -- symbol:kind:period
    symbol     TEXT NOT NULL,
    company    TEXT,
    kind       TEXT NOT NULL,             -- profile | results | balance_sheet | cash_flow | shareholding | actions | valuation_inputs
    title      TEXT NOT NULL,
    period     TEXT,                      -- reporting period the document describes
    as_of      TEXT,                      -- when the underlying filing was published or the figure measured
    source     TEXT NOT NULL,             -- where it came from, in words
    url        TEXT,                      -- the filing itself, where there is one
    text       TEXT NOT NULL,             -- the document, written as sentences a search can match
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_kb_symbol ON kb_doc(symbol, kind);
CREATE INDEX IF NOT EXISTS ix_kb_updated ON kb_doc(updated_at);

CREATE VIRTUAL TABLE IF NOT EXISTS kb_doc_fts USING fts5(title, text, symbol, kind, content='kb_doc', content_rowid='rowid', tokenize='unicode61');
CREATE TRIGGER IF NOT EXISTS kb_doc_ai AFTER INSERT ON kb_doc BEGIN
  INSERT INTO kb_doc_fts(rowid, title, text, symbol, kind) VALUES (new.rowid, new.title, new.text, new.symbol, new.kind);
END;
CREATE TRIGGER IF NOT EXISTS kb_doc_ad AFTER DELETE ON kb_doc BEGIN
  INSERT INTO kb_doc_fts(kb_doc_fts, rowid, title, text, symbol, kind) VALUES ('delete', old.rowid, old.title, old.text, old.symbol, old.kind);
END;
CREATE TRIGGER IF NOT EXISTS kb_doc_au AFTER UPDATE ON kb_doc BEGIN
  INSERT INTO kb_doc_fts(kb_doc_fts, rowid, title, text, symbol, kind) VALUES ('delete', old.rowid, old.title, old.text, old.symbol, old.kind);
  INSERT INTO kb_doc_fts(rowid, title, text, symbol, kind) VALUES (new.rowid, new.title, new.text, new.symbol, new.kind);
END;

CREATE TABLE IF NOT EXISTS kb_state (symbol TEXT PRIMARY KEY, built_at TEXT NOT NULL, docs INTEGER, fingerprint TEXT);
`;

export function ensureSchema(db: Db) {
  db.exec(SCHEMA);
}

export interface Doc {
  id: string; symbol: string; company: string | null; kind: string; title: string;
  period: string | null; as_of: string | null; source: string; url: string | null; text: string; updated_at: string;
}

const CR = 1e7;
const cr = (v: number | null | undefined) => (v === null || v === undefined || !Number.isFinite(v) ? "not disclosed" : `Rs ${Math.round(v / CR).toLocaleString("en-IN")} crore`);
const plain = (v: number | null | undefined, unit = "") => (v === null || v === undefined || !Number.isFinite(v) ? "not disclosed" : `${Math.round(v * 100) / 100}${unit}`);
const fy = (period: string | null) => {
  if (!period) return null;
  const [y, m] = period.split("-").map(Number);
  const year = m <= 3 ? y : y + 1;
  const q = m <= 3 ? "Q4" : m <= 6 ? "Q1" : m <= 9 ? "Q2" : "Q3";
  return `${q} FY${String(year).slice(2)}`;
};

/** Everything known about one company, written out as documents. */
export function documents(db: Db, symbol: string): Doc[] {
  const sym = symbol.toUpperCase();
  const m = db.get<Row>("SELECT * FROM company_metrics WHERE symbol = ?", [sym]);
  if (!m) return [];
  const company = (m.company as string) ?? sym;
  const stamp = now();
  const docs: Doc[] = [];
  const add = (kind: string, id: string, title: string, period: string | null, asOf: string | null, source: string, url: string | null, text: string) =>
    docs.push({ id: `${sym}:${id}`, symbol: sym, company, kind, title, period, as_of: asOf, source, url, text: text.replace(/\s+/g, " ").trim(), updated_at: stamp });

  // --- who the company is, and where it trades ------------------------------------------------------
  add("profile", "profile", `${company}: profile and market data`, null, (m.trade_date as string) ?? null,
    `NSE and BSE listings, prices as at ${m.trade_date}`, null,
    `${company} (NSE symbol ${sym}${m.bse_code ? `, BSE code ${m.bse_code}` : ""}${m.isin ? `, ISIN ${m.isin}` : ""}) is in the ${m.industry ?? "unclassified"} industry.
     Indices: ${m.indices || "none recorded"}. Last traded price Rs ${plain(toNum(m.close))} on ${m.trade_date}, change ${plain(toNum(m.pct_1d), "%")} that session.
     Market capitalisation ${plain(toNum(m.market_cap_cr))} crore. 52 week high Rs ${plain(toNum(m.high_52w))}, low Rs ${plain(toNum(m.low_52w))}.
     Returns: one month ${plain(toNum(m.ret_1m), "%")}, six months ${plain(toNum(m.ret_6m), "%")}, one year ${plain(toNum(m.ret_1y), "%")}.
     Valuation ratios: price to earnings ${plain(toNum(m.pe))}, price to book ${plain(toNum(m.pb))}, dividend yield ${plain(toNum(m.div_yield), "%")}.
     Trailing twelve months: revenue ${plain(toNum(m.sales_ttm_cr))} crore, net profit ${plain(toNum(m.np_ttm_cr))} crore, earnings per share Rs ${plain(toNum(m.eps_ttm))},
     operating margin ${plain(toNum(m.opm_ttm), "%")}, net margin ${plain(toNum(m.net_margin_ttm), "%")}, return on equity ${plain(toNum(m.roe), "%")}, debt to equity ${plain(toNum(m.debt_to_equity))}.
     Three year growth: sales ${plain(toNum(m.sales_growth_3y), "%")}, profit ${plain(toNum(m.profit_growth_3y), "%")}.`);

  // --- each reported quarter ------------------------------------------------------------------------
  const quarters = db.all<Row>("SELECT period_end, consolidated, revenue, other_income, total_expenses, pbt, tax, pat, pat_owners, eps_basic, net_margin, gross_profit, depreciation, finance_costs, employee_cost, exceptional, report_format, xbrl_url, quality "
    + "FROM nse_fundamental WHERE symbol = ? AND quality IN ('ok','suspect') ORDER BY period_end DESC LIMIT 24", [sym]);
  const seen = new Set<string>();
  for (const q of quarters) {
    const period = String(q.period_end);
    if (seen.has(period)) continue;
    seen.add(period);
    add("results", `results:${period}`, `${company}: results for ${fy(period)} (quarter ended ${period})`, period, period,
      `NSE XBRL result filing, ${q.consolidated ? "consolidated" : "standalone"}`, (q.xbrl_url as string) ?? null,
      `${company} reported for the quarter ended ${period} (${fy(period)}), ${q.consolidated ? "consolidated" : "standalone"} basis.
       Revenue from operations ${cr(toNum(q.revenue))}. Other income ${cr(toNum(q.other_income))}. Total expenses ${cr(toNum(q.total_expenses))}.
       Employee cost ${cr(toNum(q.employee_cost))}. Finance costs ${cr(toNum(q.finance_costs))}. Depreciation and amortisation ${cr(toNum(q.depreciation))}.
       Profit before tax ${cr(toNum(q.pbt))}. Tax ${cr(toNum(q.tax))}. Net profit ${cr(toNum(q.pat_owners) ?? toNum(q.pat))}.
       ${toNum(q.exceptional) ? `Exceptional items ${cr(toNum(q.exceptional))}.` : ""}
       Earnings per share Rs ${plain(toNum(q.eps_basic))}. Net margin ${plain(toNum(q.net_margin), "%")}.
       ${toNum(q.gross_profit) !== null ? `Gross profit ${cr(toNum(q.gross_profit))}.` : "Gross profit is not separately disclosed in this filing."}
       ${q.quality === "suspect" ? "Some figures in this filing did not pass the consistency checks and may be misreported at source." : ""}`);
  }

  // --- balance sheets and cash flows ------------------------------------------------------------------
  for (const s of db.all<Row>("SELECT period_end, kind, months, report_format, data, xbrl_url FROM nse_statement WHERE symbol = ? AND kind IN ('balance_sheet','cash_flow') ORDER BY period_end DESC LIMIT 12", [sym])) {
    let v: Record<string, number | null>;
    try {
      v = JSON.parse(String(s.data));
    } catch {
      continue;
    }
    const period = String(s.period_end);
    const kind = String(s.kind);
    const words = Object.entries(v).filter(([, x]) => x !== null).map(([k, x]) => `${k.replace(/_/g, " ")} ${cr(x)}`).join(", ");
    add(kind, `${kind}:${period}`, `${company}: ${kind === "balance_sheet" ? "balance sheet" : "cash flow statement"} at ${period}`, period, period,
      "NSE XBRL filing", (s.xbrl_url as string) ?? null,
      `${company} ${kind === "balance_sheet" ? `balance sheet as at ${period}` : `cash flow statement for the ${s.months} months to ${period}`}
       (${s.report_format === "bank" ? "banking format" : "corporate format"}): ${words}.`);
  }

  // --- who owns it, quarter by quarter ----------------------------------------------------------------
  const holding = db.all<Row>("SELECT as_of_date, promoter, fii, dii, government, public, others, shareholders, total_shares, xbrl_url FROM nse_shareholding_detail WHERE symbol = ? ORDER BY as_of_date DESC LIMIT 8", [sym]);
  if (holding.length) {
    const lines = holding.map((h) => `as at ${h.as_of_date}: promoters ${plain(toNum(h.promoter), "%")}, foreign institutions ${plain(toNum(h.fii), "%")}, domestic institutions ${plain(toNum(h.dii), "%")}, government ${plain(toNum(h.government), "%")}, public ${plain(toNum(h.public), "%")}${h.shareholders ? `, ${Number(h.shareholders).toLocaleString("en-IN")} shareholders` : ""}`);
    add("shareholding", `shareholding:${holding[0].as_of_date}`, `${company}: shareholding pattern`, String(holding[0].as_of_date), String(holding[0].as_of_date),
      "NSE XBRL shareholding filings", (holding[0].xbrl_url as string) ?? null,
      `${company} shareholding pattern over the last ${holding.length} quarters, ${lines.join("; ")}.
       Change in the latest quarter: promoters ${plain((toNum(holding[0].promoter) ?? 0) - (toNum(holding[1]?.promoter) ?? toNum(holding[0].promoter) ?? 0), "%")},
       foreign institutions ${plain((toNum(holding[0].fii) ?? 0) - (toNum(holding[1]?.fii) ?? toNum(holding[0].fii) ?? 0), "%")}.`);
  }

  // --- dividends, splits, bonuses ----------------------------------------------------------------------
  const actions = db.all<Row>("SELECT purpose, ex_date, record_date FROM nse_corp_action WHERE symbol = ? ORDER BY ex_date DESC LIMIT 20", [sym]);
  if (actions.length) {
    add("actions", "actions", `${company}: corporate actions`, null, String(actions[0].ex_date ?? ""),
      "NSE corporate actions", null,
      `${company} corporate actions on record: ${actions.map((a) => `${a.purpose} with ex-date ${a.ex_date || "not announced"}${a.record_date ? `, record date ${a.record_date}` : ""}`).join("; ")}.`);
  }

  return docs;
}

/** A cheap signature of the company's data, so unchanged companies are skipped. */
function fingerprint(db: Db, symbol: string): string {
  const row = db.get<Row>(
    "SELECT (SELECT updated_at FROM company_metrics WHERE symbol = ?) AS m, (SELECT MAX(fetched_at) FROM nse_fundamental WHERE symbol = ?) AS f, "
    + "(SELECT MAX(fetched_at) FROM nse_statement WHERE symbol = ?) AS s, (SELECT MAX(fetched_at) FROM nse_shareholding_detail WHERE symbol = ?) AS h, "
    + "(SELECT MAX(fetched_at) FROM nse_corp_action WHERE symbol = ?) AS a", [symbol, symbol, symbol, symbol, symbol]);
  return [row?.m, row?.f, row?.s, row?.h, row?.a].join("|");
}

/** Rebuild the documents for one company. Returns how many were written. */
export function build(db: Db, symbol: string, force = false): number {
  ensureSchema(db);
  const sym = symbol.toUpperCase();
  const print = fingerprint(db, sym);
  if (!force && db.scalar<string>("SELECT fingerprint FROM kb_state WHERE symbol = ?", [sym]) === print) return 0;
  const docs = documents(db, sym);
  db.transaction(() => {
    db.run("DELETE FROM kb_doc WHERE symbol = ?", [sym]);
    if (docs.length) db.upsert("kb_doc", docs as unknown as Row[]);
    db.run("INSERT INTO kb_state (symbol, built_at, docs, fingerprint) VALUES (?, ?, ?, ?) ON CONFLICT(symbol) DO UPDATE SET built_at = excluded.built_at, docs = excluded.docs, fingerprint = excluded.fingerprint",
      [sym, now(), docs.length, print]);
  });
  return docs.length;
}

/** Rebuild everything that changed since the last pass, newest and largest companies first. */
export function buildAll(db: Db, opts: { limit?: number; force?: boolean } = {}): { companies: number; docs: number } {
  ensureSchema(db);
  const symbols = db.all<{ symbol: string }>(
    "SELECT symbol FROM company_metrics WHERE close IS NOT NULL ORDER BY market_cap_cr DESC NULLS LAST" + (opts.limit ? " LIMIT ?" : ""),
    opts.limit ? [opts.limit] : []).map((r) => r.symbol);
  let docs = 0;
  let companies = 0;
  for (const s of symbols) {
    const n = build(db, s, opts.force);
    if (n) {
      docs += n;
      companies++;
      if (companies % 250 === 0) log.info(`knowledge base: ${companies} companies, ${docs} documents`);
    }
  }
  log.info(`knowledge base: ${companies} companies rebuilt, ${docs} documents`);
  return { companies, docs };
}

export const stats = (db: Db) => ({
  documents: db.hasTable("kb_doc") ? db.scalar<number>("SELECT COUNT(*) FROM kb_doc") : 0,
  companies: db.hasTable("kb_state") ? db.scalar<number>("SELECT COUNT(*) FROM kb_state") : 0,
  byKind: db.hasTable("kb_doc") ? db.all("SELECT kind, COUNT(*) AS n FROM kb_doc GROUP BY kind ORDER BY n DESC") : [],
  lastBuilt: db.hasTable("kb_state") ? db.scalar<string>("SELECT MAX(built_at) FROM kb_state") : null,
});
