// Fair value from several independent models, weighted into a range, with the price zones that follow from it.
//
// Rules this module follows:
//   - never invent a number: a model with missing inputs reports why it is unavailable instead of guessing;
//   - every figure carries its source (filing period and document, or the session it was priced from);
//   - banks and finance companies are valued on book value, not on enterprise value.
import type { Db, Row } from "../db";
import { cagr, median, toNum } from "../util";

export interface Source {
  label: string;
  origin: string;
  period?: string | null;
  asOf?: string | null;
  url?: string | null;
}

export interface Model {
  key: string;
  label: string;
  fairValue: number | null;
  weight: number;
  basis: string;
  unavailable?: string;
}

export type Status = "DEEPLY UNDERVALUED" | "UNDERVALUED" | "FAIRLY VALUED" | "MODERATELY OVERVALUED" | "OVERVALUED" | "EXTREMELY OVERVALUED" | "DATA UNAVAILABLE";

export interface Zone { key: string; label: string; from: number | null; to: number | null; meaning: string }

export interface Valuation {
  symbol: string;
  company: string | null;
  kind: "bank" | "corporate";
  price: { close: number | null; session: string | null; exchange: "NSE" | "BSE" | null };
  inputs: Row;
  models: Model[];
  fairValue: number | null;
  range: { bear: number | null; base: number | null; bull: number | null };
  confidence: "high" | "medium" | "low" | "none";
  confidenceWhy: string;
  upsidePct: number | null;
  marginOfSafety: number | null;
  status: Status;
  zones: Zone[];
  history: { years: number; medianPe: number | null; minPe: number | null; maxPe: number | null; percentile: number | null; points: { date: string; pe: number }[] };
  peers: { count: number; medianPe: number | null; medianPb: number | null; industry: string | null };
  reasons: string[];
  cautions: string[];
  sources: Source[];
  generatedAt: string;
}

// Discount and growth assumptions, shown to the reader rather than hidden in the code.
export const ASSUMPTIONS = {
  discountRate: 0.12,
  terminalGrowth: 0.04,
  years: 10,
  maxGrowth: 0.18,
  defaultGrowth: 0.08,
  targetFcfYield: 0.05,
  evEbitdaMultiple: 10,
  /** Below this payout ratio a dividend model says little about value. */
  minPayoutForDdm: 0.4,
  /** Models below this weight support the picture but do not set the range. */
  coreWeight: 0.1,
  historyYears: 5,
  // Margin of safety bands, as a fraction of fair value.
  zones: { strongBuy: 0.7, buy: 0.85, fair: 1.1, overvalued: 1.35 },
};

const CR = 1e7; // one crore, the unit company_metrics stores
const round = (v: number | null, digits = 2) => (v === null || !Number.isFinite(v) ? null : Math.round(v * 10 ** digits) / 10 ** digits);
/** 1st, 2nd, 3rd, 4th... */
const ordinal = (n: number) => `${n}${["th", "st", "nd", "rd"][(n % 100 - n % 10 !== 10 ? n % 10 : 0)] ?? "th"}`;

const positive = (v: number | null | undefined) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null);

const isBank = (metrics: Row, format: string | null) =>
  format === "bank" || /bank|financial|finance|nbfc|insur/i.test(String(metrics.industry ?? ""));

/** Trailing four quarters of parsed results, newest first. */
function quarters(db: Db, symbol: string, limit = 24): Row[] {
  return db.all(
    "SELECT f.period_end, f.consolidated, f.revenue, f.pbt, f.pat_owners, f.pat, f.eps_basic, f.depreciation, f.finance_costs, f.shares, f.equity, f.borrowings, f.total_assets, f.report_format, f.quality, f.xbrl_url "
    + "FROM nse_fundamental f WHERE f.symbol = ? AND f.quality IN ('ok', 'suspect') ORDER BY f.period_end DESC, f.consolidated DESC LIMIT ?", [symbol, limit]);
}

/** One row per period on the preferred basis (consolidated when the company reports it). */
function byPeriod(rows: Row[]): Row[] {
  const out = new Map<string, Row>();
  for (const r of rows) if (!out.has(r.period_end)) out.set(r.period_end, r);
  return [...out.values()].sort((a, b) => String(b.period_end).localeCompare(String(a.period_end)));
}

function statement(db: Db, symbol: string, kind: "balance_sheet" | "cash_flow", months?: number): Row | null {
  const row = db.get<Row>(`SELECT period_end, months, report_format, data, xbrl_url FROM nse_statement WHERE symbol = ? AND kind = ?${months ? " AND months = ?" : ""} ORDER BY period_end DESC LIMIT 1`,
    months ? [symbol, kind, months] : [symbol, kind]);
  if (!row) return null;
  try {
    return { ...row, values: JSON.parse(row.data) as Record<string, number | null> };
  } catch {
    return null;
  }
}

/** Annual free cash flow, newest first (used by the discounted cash flow model). */
function annualCashFlows(db: Db, symbol: string): Row[] {
  return db.all("SELECT period_end, json_extract(data, '$.fcf') AS fcf, json_extract(data, '$.cfo') AS cfo, json_extract(data, '$.capex') AS capex, xbrl_url "
    + "FROM nse_statement WHERE symbol = ? AND kind = 'cash_flow' AND months = 12 ORDER BY period_end DESC LIMIT 6", [symbol]);
}

/** Month-end price against the earnings reported by then: the company's own valuation history. */
function peHistory(db: Db, symbol: string, qs: Row[], years: number): { date: string; pe: number }[] {
  const prices = db.all<{ d: string; c: number }>(
    "SELECT MAX(trade_date) AS d, close AS c FROM nse_bhavcopy WHERE symbol = ? AND series IN ('EQ','BE','BZ') AND trade_date >= date('now', ?) GROUP BY substr(trade_date, 1, 7) ORDER BY d", [symbol, `-${years} years`]);
  const periods = byPeriod(qs).filter((q) => q.eps_basic !== null);
  const points: { date: string; pe: number }[] = [];
  for (const p of prices) {
    const trailing = periods.filter((q) => String(q.period_end) <= p.d).slice(0, 4);
    if (trailing.length < 4) continue;
    const eps = trailing.reduce((s, q) => s + (toNum(q.eps_basic) ?? 0), 0);
    if (eps > 0 && p.c > 0) points.push({ date: p.d, pe: round(p.c / eps, 1)! });
  }
  return points;
}

function peerMedians(db: Db, symbol: string, industry: string | null) {
  if (!industry) return { count: 0, medianPe: null, medianPb: null, industry: null };
  const rows = db.all("SELECT symbol, pe, pb FROM company_metrics WHERE industry = ? AND symbol != ? AND close IS NOT NULL", [industry, symbol]);
  return {
    count: rows.length,
    medianPe: round(median(rows.map((r) => positive(toNum(r.pe))).filter((v) => v !== null && v < 200))),
    medianPb: round(median(rows.map((r) => positive(toNum(r.pb))).filter((v) => v !== null && v < 30))),
    industry,
  };
}

/** Present value of a fading growth stream plus a terminal value. */
export function discountedCashFlow(base: number, growth: number, shares: number, netDebt: number): number | null {
  const { discountRate: r, terminalGrowth: g, years } = ASSUMPTIONS;
  if (!(base > 0) || !(shares > 0) || r <= g) return null;
  let pv = 0;
  let cash = base;
  for (let y = 1; y <= years; y++) {
    // Growth fades linearly from the starting rate to the terminal rate.
    const rate = growth + ((g - growth) * (y - 1)) / (years - 1);
    cash *= 1 + rate;
    pv += cash / (1 + r) ** y;
  }
  const terminal = (cash * (1 + g)) / (r - g);
  pv += terminal / (1 + r) ** years;
  return (pv - netDebt) / shares;
}

function statusFor(mos: number | null): Status {
  if (mos === null) return "DATA UNAVAILABLE";
  if (mos >= 0.35) return "DEEPLY UNDERVALUED";
  if (mos >= 0.15) return "UNDERVALUED";
  if (mos >= -0.1) return "FAIRLY VALUED";
  if (mos >= -0.25) return "MODERATELY OVERVALUED";
  if (mos >= -0.5) return "OVERVALUED";
  return "EXTREMELY OVERVALUED";
}

/** Fair value for one company, with every model's inputs and reasoning. */
export function valuation(db: Db, symbol: string): Valuation {
  const sym = symbol.toUpperCase();
  const m = db.get<Row>("SELECT * FROM company_metrics WHERE symbol = ?", [sym]);
  const qs = byPeriod(quarters(db, sym));
  const ttm = qs.slice(0, 4);
  const bs = statement(db, sym, "balance_sheet");
  const cf = annualCashFlows(db, sym);
  const format = (qs[0]?.report_format as string | null) ?? (bs?.report_format as string | null) ?? null;
  const bank = isBank(m ?? {}, format);

  const price = positive(toNum(m?.close));
  const epsTtm = ttm.length === 4 ? ttm.reduce((s, q) => s + (toNum(q.eps_basic) ?? 0), 0) : null;
  const shares = positive(toNum(m?.shares)) ?? positive(toNum(qs[0]?.shares));
  const bvps = positive(toNum(m?.bvps));
  const dps = positive(toNum(m?.div_ttm));
  const roe = toNum(m?.roe);
  const bsValues = (bs?.values ?? {}) as Record<string, number | null>;
  const debt = bank ? null : (toNum(bsValues.borrowings_noncurrent) ?? 0) + (toNum(bsValues.borrowings_current) ?? 0);
  const cash = bank ? null : (toNum(bsValues.cash) ?? 0) + (toNum(bsValues.current_investments) ?? 0);
  const netDebt = debt === null ? null : debt - (cash ?? 0);
  const ebitdaTtm = ttm.length === 4 && !bank
    ? ttm.reduce((s, q) => s + (toNum(q.pbt) ?? 0) + (toNum(q.finance_costs) ?? 0) + (toNum(q.depreciation) ?? 0), 0)
    : null;
  const fcfs = cf.map((c) => toNum(c.fcf)).filter((v): v is number => v !== null);
  const fcfBase = fcfs.length ? median(fcfs.slice(0, 3)) : null;
  const revenueCagr = qs.length >= 8 ? cagr(toNum(qs[0]?.revenue), toNum(qs[Math.min(qs.length - 1, 11)]?.revenue), Math.min(qs.length - 1, 11) / 4) : null;

  const history = peHistory(db, sym, quarters(db, sym, 40), ASSUMPTIONS.historyYears);
  const pes = history.map((p) => p.pe);
  const medianPe = round(median(pes));
  const currentPe = positive(toNum(m?.pe));
  const percentile = currentPe && pes.length >= 12 ? round((pes.filter((v) => v <= currentPe).length / pes.length) * 100, 0) : null;
  const peers = peerMedians(db, sym, (m?.industry as string | null) ?? null);

  const models: Model[] = [];
  const add = (key: string, label: string, weight: number, fairValue: number | null, basis: string, unavailable?: string) =>
    models.push({ key, label, weight, fairValue: round(fairValue), basis, ...(fairValue === null ? { unavailable: unavailable ?? "inputs unavailable" } : {}) });

  // --- earnings based -----------------------------------------------------------------------------
  if (epsTtm !== null && epsTtm > 0) {
    add("pe_history", "P/E on its own 5-year median", bank ? 0.2 : 0.2, medianPe ? epsTtm * medianPe : null,
      medianPe ? `EPS (TTM) ₹${round(epsTtm)} × median P/E ${medianPe} from ${history.length} month-ends` : "", "not enough price history with four reported quarters");
    add("pe_peer", "P/E on the peer median", bank ? 0.15 : 0.15, peers.medianPe ? epsTtm * peers.medianPe : null,
      peers.medianPe ? `EPS (TTM) ₹${round(epsTtm)} × peer median P/E ${peers.medianPe} (${peers.count} companies in ${peers.industry})` : "", "no peer valuations in this industry");
  } else {
    add("pe_history", "P/E on its own 5-year median", 0, null, "", epsTtm === null ? "fewer than four quarters of results parsed" : "earnings are negative, so P/E does not apply");
    add("pe_peer", "P/E on the peer median", 0, null, "", epsTtm === null ? "fewer than four quarters of results parsed" : "earnings are negative, so P/E does not apply");
  }

  // --- book value (the primary measure for lenders) -----------------------------------------------
  add("pb_peer", "P/B on the peer median", bank ? 0.3 : 0.05, bvps && peers.medianPb ? bvps * peers.medianPb : null,
    bvps && peers.medianPb ? `Book value ₹${round(bvps)} per share × peer median P/B ${peers.medianPb}` : "", bvps ? "no peer P/B available" : "book value per share unavailable");

  // --- enterprise value (not meaningful for lenders) ----------------------------------------------
  if (!bank) {
    const mult = ASSUMPTIONS.evEbitdaMultiple;
    const evEbitda = ebitdaTtm && shares && netDebt !== null ? ((ebitdaTtm * mult) - netDebt) / shares : null;
    add("ev_ebitda", `EV/EBITDA at ${mult}× (assumed)`, 0.2, evEbitda,
      evEbitda ? `EBITDA (TTM) ₹${round(ebitdaTtm! / CR)} Cr × ${mult}, less net debt ₹${round(netDebt! / CR)} Cr, over ${round(shares! / 1e7, 2)} Cr shares` : "",
      ebitdaTtm === null ? "EBITDA needs four parsed quarters" : netDebt === null ? "no balance sheet parsed yet" : "share count unavailable");

    const growth = Math.min(ASSUMPTIONS.maxGrowth, Math.max(ASSUMPTIONS.terminalGrowth, (revenueCagr ?? ASSUMPTIONS.defaultGrowth * 100) / 100));
    const dcf = fcfBase && shares && netDebt !== null ? discountedCashFlow(fcfBase, growth, shares, netDebt) : null;
    add("dcf", "Discounted cash flow", 0.25, dcf,
      dcf ? `Free cash flow ₹${round(fcfBase! / CR)} Cr growing ${round(growth * 100, 1)}% fading to ${ASSUMPTIONS.terminalGrowth * 100}%, discounted at ${ASSUMPTIONS.discountRate * 100}% over ${ASSUMPTIONS.years} years` : "",
      fcfBase === null ? "no annual cash flow statement parsed yet" : fcfBase <= 0 ? "free cash flow is negative, so a discounted model is not meaningful" : "share count or balance sheet unavailable");

    const fcfYield = fcfBase && fcfBase > 0 && shares ? (fcfBase / ASSUMPTIONS.targetFcfYield) / shares : null;
    add("fcf_yield", `Free cash flow at a ${ASSUMPTIONS.targetFcfYield * 100}% yield`, 0.05, fcfYield,
      fcfYield ? `Free cash flow ₹${round(fcfBase! / CR)} Cr priced to yield ${ASSUMPTIONS.targetFcfYield * 100}%` : "", "free cash flow unavailable or negative");
  }

  // --- dividends: only where the payout is large enough for dividends to drive the value -----------
  const payout = dps && epsTtm && epsTtm > 0 ? dps / epsTtm : null;
  const ddmGrowth = roe && payout !== null ? Math.min(0.06, Math.max(0, (roe / 100) * (1 - payout))) : 0.04;
  const ddmApplies = dps !== null && payout !== null && payout >= ASSUMPTIONS.minPayoutForDdm;
  const ddm = ddmApplies ? (dps! * (1 + ddmGrowth)) / (ASSUMPTIONS.discountRate - ddmGrowth) : null;
  add("ddm", "Dividend discount", bank ? 0.1 : 0.05, ddm,
    ddm ? `Dividend ₹${round(dps!)} per share (payout ${round(payout! * 100, 0)}%) growing ${round(ddmGrowth * 100, 1)}%, discounted at ${ASSUMPTIONS.discountRate * 100}%` : "",
    dps === null ? "the company pays no dividend on record" : payout === null ? "earnings unavailable, so the payout ratio is unknown" : `only ${round(payout * 100, 0)}% of earnings is paid out, too little for a dividend-based valuation`);

  // --- weighted fair value ------------------------------------------------------------------------
  const usable = models.filter((x) => x.fairValue !== null && x.weight > 0);
  const totalWeight = usable.reduce((s, x) => s + x.weight, 0);
  const fairValue = usable.length ? round(usable.reduce((s, x) => s + x.fairValue! * x.weight, 0) / totalWeight) : null;
  // The range comes from the models that carry real weight; the small ones are supporting evidence.
  const core = usable.filter((x) => x.weight >= ASSUMPTIONS.coreWeight);
  const values = (core.length ? core : usable).map((x) => x.fairValue!).sort((a, b) => a - b);
  const spread = values.length > 1 && fairValue ? (values[values.length - 1] - values[0]) / fairValue : 0;
  const counted = core.length ? core : usable;
  const confidence = !usable.length ? "none" : counted.length >= 3 && spread < 0.4 ? "high" : counted.length >= 2 && spread < 0.8 ? "medium" : "low";
  const confidenceWhy = !usable.length
    ? "No model could be calculated from the data on record."
    : `${usable.length} of ${models.length} models produced a value; the ${counted.length} main ones span ${round(spread * 100, 0)}% of the weighted fair value.`;

  const mos = fairValue && price ? (fairValue - price) / fairValue : null;
  const upside = fairValue && price ? (fairValue - price) / price : null;
  const z = ASSUMPTIONS.zones;
  const zones: Zone[] = fairValue ? [
    { key: "strong_buy", label: "Strong buy zone", from: null, to: round(fairValue * z.strongBuy), meaning: "At least 30% below the estimated fair value." },
    { key: "buy", label: "Buy zone", from: round(fairValue * z.strongBuy), to: round(fairValue * z.buy), meaning: "15–30% below fair value: a usable margin of safety." },
    { key: "fair", label: "Fair value zone", from: round(fairValue * z.buy), to: round(fairValue * z.fair), meaning: "Priced around the estimate; little margin for error." },
    { key: "overvalued", label: "Overvalued", from: round(fairValue * z.fair), to: round(fairValue * z.overvalued), meaning: "Above the estimate; the price already assumes more than the models do." },
    { key: "extreme", label: "High risk", from: round(fairValue * z.overvalued), to: null, meaning: "Far above the estimate; the models cannot support this price." },
  ] : [];

  const reasons: string[] = [];
  const cautions: string[] = [];
  if (mos !== null && mos >= 0.15) reasons.push(`Priced ${round(mos * 100, 0)}% below the weighted fair value of ₹${fairValue}.`);
  if (mos !== null && mos <= -0.1) cautions.push(`Priced ${round(-mos * 100, 0)}% above the weighted fair value of ₹${fairValue}.`);
  if (currentPe && medianPe) {
    const cheaper = currentPe < medianPe;
    (cheaper ? reasons : cautions).push(`P/E of ${round(currentPe, 1)} is ${cheaper ? "below" : "above"} its own 5-year median of ${medianPe}${percentile !== null ? ` (${ordinal(percentile)} percentile of the last ${ASSUMPTIONS.historyYears} years)` : ""}.`);
  }
  if (currentPe && peers.medianPe) {
    const cheaper = currentPe < peers.medianPe;
    (cheaper ? reasons : cautions).push(`P/E of ${round(currentPe, 1)} is ${cheaper ? "below" : "above"} the ${peers.industry} median of ${peers.medianPe} across ${peers.count} companies.`);
  }
  if (fcfBase !== null && fcfBase <= 0) cautions.push("Free cash flow was negative in recent years, so cash-flow based models do not apply.");
  if (confidence === "low") cautions.push("Few models agree, so treat the fair value as a rough range rather than a number.");
  if (qs.length && qs.length < 8) cautions.push(`Only ${qs.length} quarters of results are parsed so far, which limits growth and valuation history.`);

  const sources: Source[] = [];
  if (m?.trade_date) sources.push({ label: "Price and market cap", origin: "NSE bhavcopy", asOf: String(m.trade_date), period: null, url: null });
  if (ttm.length) sources.push({ label: "Earnings (trailing four quarters)", origin: `NSE XBRL results, ${ttm[0].consolidated ? "consolidated" : "standalone"}`, period: `${ttm[3]?.period_end} to ${ttm[0]?.period_end}`, url: String(ttm[0].xbrl_url ?? "") || null });
  if (bs) sources.push({ label: "Balance sheet", origin: "NSE XBRL filing", period: String(bs.period_end), url: String(bs.xbrl_url ?? "") || null });
  if (cf.length) sources.push({ label: "Cash flow", origin: "NSE XBRL filing", period: String(cf[0].period_end), url: String(cf[0].xbrl_url ?? "") || null });
  if (peers.count) sources.push({ label: "Peer valuations", origin: `company_metrics, ${peers.count} companies in ${peers.industry}`, asOf: String(m?.updated_at ?? ""), url: null });

  return {
    symbol: sym,
    company: (m?.company as string | null) ?? null,
    kind: bank ? "bank" : "corporate",
    price: { close: price, session: (m?.trade_date as string | null) ?? null, exchange: price ? "NSE" : null },
    inputs: {
      epsTtm: round(epsTtm), bvps: round(bvps), sharesCr: round(shares ? shares / CR : null), dividendPerShare: round(dps),
      ebitdaTtmCr: round(ebitdaTtm ? ebitdaTtm / CR : null), netDebtCr: round(netDebt !== null ? netDebt / CR : null),
      freeCashFlowCr: round(fcfBase !== null ? fcfBase / CR : null), revenueCagr3y: round(revenueCagr), currentPe: round(currentPe, 1),
      quartersParsed: qs.length, reportFormat: format,
    },
    models,
    fairValue,
    range: { bear: round(values[0] ?? null), base: fairValue, bull: round(values[values.length - 1] ?? null) },
    confidence,
    confidenceWhy,
    upsidePct: round(upside !== null ? upside * 100 : null, 1),
    marginOfSafety: round(mos !== null ? mos * 100 : null, 1),
    status: statusFor(mos),
    zones,
    history: { years: ASSUMPTIONS.historyYears, medianPe, minPe: round(pes.length ? Math.min(...pes) : null), maxPe: round(pes.length ? Math.max(...pes) : null), percentile, points: history },
    peers,
    reasons,
    cautions,
    sources,
    generatedAt: new Date().toISOString(),
  };
}
