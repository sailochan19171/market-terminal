// Company dashboard, analysis versions and company documents (/api/v2/company/..., /api/v2/analyses...).
import type { Db, Row } from "../db";
import * as A from "../core/analysis";
import * as sync from "../nse/companySync";
import { addDays, parseIso, pctChange, todayIso } from "../util";
import { quote } from "../core/price";
import { ApiError, Args, badRequest, checkDate } from "./common";
import { DERIVATIVE_INDEX_SYMBOLS, INDEX_NAMES } from "./v2";
import { logger } from "../log";

const log = logger("api.company");
const MAX_RANGE_DAYS = 3660;
const PRESET_DAYS: Record<string, number> = { "1D": 0, "1W": 7, "1M": 30, "3M": 91, "6M": 182, "1Y": 365, "3Y": 1095, "5Y": 1826 };

export function identityOr404(db: Db, ident: string): A.Identity {
  try {
    return A.resolve(db, ident);
  } catch (e) {
    if (!(e instanceof A.NotFoundError)) throw e;
    const key = ident.trim().toUpperCase();
    if (DERIVATIVE_INDEX_SYMBOLS[key]) {
      throw new ApiError(404, `${ident} is an index, not a company.`, { error: "not_found", redirect: `/indices/${DERIVATIVE_INDEX_SYMBOLS[key]}`, suggestions: [] });
    }
    const like = `%${ident.trim().slice(0, 12)}%`;
    const suggestions = db.all("SELECT symbol AS key, symbol, company FROM company_metrics WHERE symbol LIKE ? OR company LIKE ? ORDER BY market_cap_cr DESC NULLS LAST LIMIT 8", [like, like]);
    throw new ApiError(404, `No NSE or BSE company matches ${ident}.`, { error: "not_found", suggestions });
  }
}

const VERSION_FIELDS = ["id", "company_key", "symbol", "bse_code", "company", "exchange", "analysis_date", "version", "status", "kind", "data_from", "data_to", "results_as_of", "shareholding_as_of", "summary", "created_at", "updated_at"];
const publicVersion = (v: Row) => Object.fromEntries(VERSION_FIELDS.map((k) => [k, v[k] ?? null]));

/** P/E through time: close over the trailing EPS known on each date (from its filing date, or ~45 days after quarter end). */
function valuationSeries(model: Row, prices: Row[]) {
  const qs = model.quarters as Row[];
  const points: [string, number][] = [];
  for (let i = 3; i < qs.length; i++) {
    const w = qs.slice(i - 3, i + 1);
    const a = parseIso(w[0].period_end), b = parseIso(w[3].period_end);
    if (!a || !b || (b.getTime() - a.getTime()) / 86_400_000 > 280 || w.some((q) => q.eps === null || q.eps === undefined)) continue;
    const eps = w.reduce((s, q) => s + q.eps, 0);
    const known = parseIso(w[3].filed_at) ? String(w[3].filed_at).slice(0, 10) : addDays(w[3].period_end, 45);
    if (eps > 0) points.push([known, eps]);
  }
  points.sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : x[1] - y[1]));
  const out: Row[] = [];
  let j = 0;
  let current: number | null = null;
  for (const p of prices) {
    while (j < points.length && points[j][0] <= p.t) current = points[j++][1];
    if (current) out.push({ t: p.t, pe: p.c / current });
  }
  return out;
}

export async function dashboard(db: Db, ident: string, a: Args): Promise<{ data: Row; cache: string }> {
  const identity = identityOr404(db, ident);
  const dateFrom = a.date("from");
  let dateTo = a.date("to");
  if (dateFrom && dateTo && dateFrom > dateTo) throw badRequest("from must be on or before to");
  const preset = a.str("range").toUpperCase();
  if (preset && preset !== "CUSTOM" && !(preset in PRESET_DAYS)) throw badRequest(`range must be one of ${Object.keys(PRESET_DAYS).join(", ")} or custom`);
  const versionId = a.str("version");
  const basis = a.str("basis") || "auto";
  if (!["auto", "consolidated", "standalone"].includes(basis)) throw badRequest("basis must be auto, consolidated or standalone");

  let version: Row | null = null;
  let model: Row;
  let exchange: A.Exchange;
  let asOf: string | null;
  if (versionId) {
    if (!/^\d+$/.test(versionId)) throw badRequest("version must be a numeric id");
    version = A.loadVersion(db, Number(versionId));
    if (!version || version.company_key !== identity.key) throw new ApiError(404, `Analysis ${versionId} does not exist for ${identity.key}.`, { error: "not_found" });
    model = version.snapshot;
    delete version.snapshot;
    exchange = model.exchange;
    asOf = version.analysis_date;
    if (dateTo === null || dateTo > asOf!) dateTo = asOf;
  } else {
    exchange = A.pickExchange(identity, a.str("exchange"));
    const newest = A.latestSession(db, exchange);
    asOf = dateTo && newest && dateTo < newest ? dateTo : null;
    model = A.build(db, identity, { exchange, asOf, basis });
  }

  const session: string | null = model.quote?.session ?? null;
  const end = dateTo && (!session || dateTo <= session) ? dateTo : session;
  const days = PRESET_DAYS[preset] ?? 365;
  const start = dateFrom && (preset === "" || preset === "CUSTOM") ? dateFrom : end ? addDays(end, -days) : null;
  if (start && end && (parseIso(end)!.getTime() - parseIso(start)!.getTime()) / 86_400_000 > MAX_RANGE_DAYS) throw badRequest("The date range can span at most ten years.");

  let prices: Row[] = [];
  if (end) {
    const adj = A.adjuster(db, identity, asOf);
    prices = A.priceRows(db, identity, exchange, start, end, adj).map((b) => ({ t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v }));
  }
  const inRange = (d: string) => (!start || d >= start) && (!end || d <= end);

  let syncStatus: Row | null = null;
  if (!version && !asOf && identity.symbol && !identity.limited && !db.isRemote) {
    try {
      if (sync.needsSync(db, identity.symbol)) sync.start(db, identity.symbol);
      syncStatus = sync.status(db, identity.symbol);
    } catch (e) {
      log.warn(`company sync ${identity.symbol}: ${(e as Error).message}`); // never breaks the dashboard
    }
  }
  const versions = db.all("SELECT id, version, analysis_date, kind, exchange, created_at, summary FROM analysis_version WHERE company_key = ? ORDER BY analysis_date DESC, version DESC LIMIT 50", [identity.key]);
  const identOut = { ...model.identity, indices: ((model.identity.indices ?? []) as string[]).map((s) => ({ slug: s, name: INDEX_NAMES[s] ?? s })) };

  // One price for every surface: the same service the research pages, screens and answers quote from, with its
  // own "as of" stamp and live/end-of-day flag. Historical and saved-version views stay pinned to their date.
  const price = await quote(db, identity, exchange, { asOf: version ? version.analysis_date : asOf });

  const data = {
    ...model,
    identity: identOut,
    price,
    mode: version ? "version" : asOf ? "historical" : "latest",
    version: version ? publicVersion(version) : null,
    range: { from: start, to: end, preset: preset || (dateFrom ? "CUSTOM" : "1Y") },
    prices,
    valuationSeries: valuationSeries(model, prices),
    quartersInRange: (model.quarters as Row[]).filter((q) => inRange(q.period_end)),
    shareholdingInRange: (model.shareholding as Row[]).filter((h) => inRange(h.as_of_date)),
    sync: syncStatus,
    versions,
  };
  return { data, cache: version ? "private, max-age=3600" : "no-store" };
}

export function companyAnalysesList(db: Db, ident: string, a: Args) {
  const identity = identityOr404(db, ident);
  A.ensureSchema(db);
  const page = a.int("page", 1, 1, 100000), size = a.int("pageSize", 20, 1, 100);
  const where = ["company_key = ?"];
  const args: (string | number)[] = [identity.key];
  const from = a.date("from"), to = a.date("to");
  if (from) { where.push("analysis_date >= ?"); args.push(from); }
  if (to) { where.push("analysis_date <= ?"); args.push(to); }
  const clause = where.join(" AND ");
  return {
    total: db.scalar(`SELECT COUNT(*) FROM analysis_version WHERE ${clause}`, args),
    page, pageSize: size,
    items: db.all(`SELECT id, company_key, symbol, bse_code, company, exchange, analysis_date, version, status, kind, data_from, data_to, results_as_of, shareholding_as_of, summary, created_at, updated_at FROM analysis_version WHERE ${clause} ORDER BY analysis_date DESC, version DESC LIMIT ? OFFSET ?`, [...args, size, (page - 1) * size]),
  };
}

export function createAnalysis(db: Db, ident: string, body: Row): { data: Row; status: number } {
  const identity = identityOr404(db, ident);
  A.ensureSchema(db);
  const asOf = checkDate("asOf", body.asOf ? String(body.asOf) : "");
  if (asOf && asOf > todayIso()) throw badRequest("asOf cannot be in the future");
  let v: Row;
  try {
    v = A.createVersion(db, identity, { exchange: body.exchange ?? null, asOf, kind: asOf ? "point_in_time" : "on_demand" });
  } catch (e) {
    if ((e as Error).message.startsWith("No ")) throw new ApiError(422, (e as Error).message, { error: "no_data" });
    throw e;
  }
  const out = { ...publicVersion(v), unchanged: Boolean(v.unchanged) };
  return { data: out, status: out.unchanged ? 200 : 201 };
}

export function analysesList(db: Db, a: Args) {
  A.ensureSchema(db);
  const page = a.int("page", 1, 1, 100000), size = a.int("pageSize", 20, 1, 100);
  const where = ["v.status = 'completed'"];
  const args: (string | number)[] = [];
  const q = a.str("q").trim();
  if (q) { where.push("(v.company LIKE ? OR v.symbol LIKE ? OR v.bse_code = ?)"); args.push(`%${q}%`, `${q.toUpperCase()}%`, q); }
  const exchange = a.str("exchange").toUpperCase();
  if (exchange === "NSE" || exchange === "BSE") { where.push("v.exchange = ?"); args.push(exchange); }
  const kind = a.str("kind").toLowerCase();
  if (["scheduled", "on_demand", "point_in_time", "sync"].includes(kind)) { where.push("v.kind = ?"); args.push(kind); }
  const from = a.date("from"), to = a.date("to");
  if (from) { where.push("v.analysis_date >= ?"); args.push(from); }
  if (to) { where.push("v.analysis_date <= ?"); args.push(to); }
  const clause = where.join(" AND ");
  const latestOnly = a.str("latest", "1") !== "0";
  const base = `SELECT v.*, ROW_NUMBER() OVER (PARTITION BY v.company_key ORDER BY v.analysis_date DESC, v.version DESC) rn, COUNT(*) OVER (PARTITION BY v.company_key) versions FROM analysis_version v WHERE ${clause}`;
  const filt = latestOnly ? "WHERE rn = 1" : "";
  return {
    total: db.scalar(`SELECT COUNT(*) FROM (${base}) ${filt}`, args),
    page, pageSize: size,
    items: db.all(`SELECT id, company_key, symbol, bse_code, company, exchange, analysis_date, version, status, kind, data_from, data_to, results_as_of, shareholding_as_of, summary, created_at, updated_at, versions FROM (${base}) ${filt} ORDER BY analysis_date DESC, updated_at DESC LIMIT ? OFFSET ?`, [...args, size, (page - 1) * size]),
    stats: { ...db.get("SELECT COUNT(DISTINCT company_key) companies, COUNT(*) versions, MAX(updated_at) last_updated FROM analysis_version WHERE status = 'completed'") },
  };
}

export function analysisDetail(db: Db, id: number) {
  const v = A.loadVersion(db, id);
  if (!v) throw new ApiError(404, `Analysis ${id} does not exist.`, { error: "not_found" });
  return { ...publicVersion(v), snapshot: v.snapshot };
}

const COMPARE_KEYS: [string, string][] = [
  ["close", "Price (Rs)"], ["market_cap", "Market cap (Rs Cr)"], ["pe", "P/E"], ["pb", "P/B"], ["revenue_ttm", "Revenue TTM (Rs Cr)"],
  ["gross_profit_ttm", "Gross profit TTM (Rs Cr)"], ["net_profit_ttm", "Net profit TTM (Rs Cr)"], ["eps_ttm", "EPS TTM (Rs)"], ["opm_ttm", "OPM TTM %"],
  ["npm_ttm", "Net margin TTM %"], ["roe", "ROE %"], ["debt_to_equity", "Debt / equity"], ["dividend_yield", "Dividend yield %"],
  ["shares", "Shares outstanding"], ["promoter", "Promoter %"], ["fii", "FII %"], ["dii", "DII %"], ["ret_1y", "1Y return %"],
  ["sales_cagr_3y", "Sales CAGR 3Y %"], ["profit_cagr_3y", "Profit CAGR 3Y %"],
];

export function compare(db: Db, a: Args) {
  const ids = [a.str("a"), a.str("b")];
  if (!ids.every((i) => /^\d+$/.test(i))) throw badRequest("a and b must be analysis ids");
  const [va, vb] = ids.map((i) => A.loadVersion(db, Number(i)));
  if (!va || !vb) throw new ApiError(404, "One of the analyses does not exist.", { error: "not_found" });
  if (va.company_key !== vb.company_key) throw badRequest("Both analyses must belong to the same company.");
  const ma = va.snapshot.metrics, mb = vb.snapshot.metrics;
  const metrics = COMPARE_KEYS.map(([key, label]) => {
    const x = ma[key] ?? null, y = mb[key] ?? null;
    return { key, label, a: x, b: y, change: x !== null && y !== null ? y - x : null, changePct: x !== null && y !== null ? pctChange(y, x) : null };
  });
  const pa = [...va.snapshot.analysis.pros, ...va.snapshot.analysis.cons], pb = [...vb.snapshot.analysis.pros, ...vb.snapshot.analysis.cons];
  return {
    a: publicVersion(va), b: publicVersion(vb), metrics,
    observations: { added: pb.filter((x: string) => !pa.includes(x)), removed: pa.filter((x: string) => !pb.includes(x)) },
  };
}

export function documents(db: Db, ident: string, a: Args) {
  const identity = identityOr404(db, ident);
  const from = a.date("from"), to = a.date("to");
  const limit = a.int("limit", 150, 1, 500);
  const sym = identity.symbol, code = identity.bseCode;
  const win = (col: string): [string, string[]] => {
    let clause = "";
    const args: string[] = [];
    if (from) { clause += ` AND ${col} >= ?`; args.push(from); }
    if (to) { clause += ` AND ${col} < date(?, '+1 day')`; args.push(to); }
    return [clause, args];
  };
  let ann: Row[] = [];
  if (sym) {
    const [w, args] = win("ann_dt");
    ann.push(...db.all(`SELECT subject AS title, details, ann_dt AS dt, pdf_url AS url, 'NSE' AS source FROM nse_announcement WHERE symbol = ?${w} ORDER BY ann_dt DESC LIMIT ?`, [sym, ...args, limit]));
  }
  if (code) {
    const [w, args] = win("news_dt");
    ann.push(...db.all(`SELECT headline AS title, category AS details, news_dt AS dt, pdf_url AS url, 'BSE' AS source FROM announcement WHERE scrip_cd = ?${w} ORDER BY news_dt DESC LIMIT ?`, [code, ...args, limit]));
  }
  ann = ann.sort((x, y) => (String(y.dt ?? "") < String(x.dt ?? "") ? -1 : String(y.dt ?? "") > String(x.dt ?? "") ? 1 : 0));
  const meetRe = /analyst|investor meet|con\.? ?call|conference call|earnings call/i;
  const out: Row = {
    announcements: ann.slice(0, limit),
    investorMeets: ann.filter((x) => meetRe.test(`${x.title ?? ""} ${x.details ?? ""}`)).slice(0, 60),
    results: [], boardMeetings: [], corporateActions: [], insider: [],
  };
  if (sym) {
    let [w, args] = win("COALESCE(broadcast_dt, period_end)");
    out.results = db.all(`SELECT period_end, consolidated, audited, broadcast_dt, xbrl_url FROM nse_financial_result WHERE symbol = ?${w} ORDER BY period_end DESC, consolidated LIMIT ?`, [sym, ...args, limit]);
    [w, args] = win("meeting_dt");
    out.boardMeetings = db.all(`SELECT meeting_dt, purpose, description FROM nse_board_meeting WHERE symbol = ?${w} ORDER BY meeting_dt DESC LIMIT ?`, [sym, ...args, limit]);
    [w, args] = win("broadcast");
    out.insider = db.all(`SELECT broadcast, acquirer, security, quantity, value, txn_type FROM nse_insider_trade WHERE symbol = ?${w} ORDER BY broadcast DESC LIMIT ?`, [sym, ...args, limit]);
  }
  const actions: Row[] = [];
  const [w, args] = win("ex_date");
  if (sym) actions.push(...db.all(`SELECT purpose, ex_date, record_date, 'NSE' AS source FROM nse_corp_action WHERE symbol = ?${w}`, [sym, ...args]));
  if (code) actions.push(...db.all(`SELECT purpose, ex_date, record_date, 'BSE' AS source FROM corp_action WHERE scrip_cd = ?${w}`, [code, ...args]));
  out.corporateActions = actions.sort((x, y) => (String(y.ex_date ?? "") < String(x.ex_date ?? "") ? -1 : String(y.ex_date ?? "") > String(x.ex_date ?? "") ? 1 : 0)).slice(0, limit);
  out.range = { from, to };
  return out;
}
