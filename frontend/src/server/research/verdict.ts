// The valuation verdict: Peter Lynch's method plus four other lenses, each with its inputs on show.
//
// The point is not to hand anyone a signal. It is to say what several independent, published methods make of
// the price, where they disagree, and which inputs the answer is sensitive to - the growth rate above all. So:
//   - every input carries where it came from, and a missing input is reported, never filled in;
//   - the growth rate is adjustable, and the default is the median of the histories we can actually measure;
//   - the models that do not apply to this company (a loss-maker's P/E, a bank's Lynch ratio) are suppressed
//     with the reason, rather than quietly producing a number.
import type { Db, Row } from "../db";
import { quoteFor, type PriceQuote } from "../core/price";
import { cagr, median, toNum } from "../util";
import { combine, dcfPerShare, graham, GROWTH_CAP_PCT, LYNCH_BANDS, lynch, peg, relativeVerdict, verdictVsFairValue, type LynchResult, type Verdict } from "@/lib/valuationMath";
import { valuation, type Valuation } from "./valuation";

export type GrowthBasis = "blended" | "analyst" | "eps3y" | "eps5y" | "profit3y" | "manual";

export interface GrowthOption {
  key: GrowthBasis;
  label: string;
  valuePct: number | null;
  source: string;
  unavailable?: string;
}

export interface ModelLine {
  key: string;
  label: string;
  verdict: Verdict | null;
  reading: string;            // what the model says, in one line
  fairValue: number | null;   // per share, when the model produces one
  inputs: string;             // the arithmetic, so a reader can check it
  unavailable?: string;
}

export interface ValuationVerdict {
  symbol: string;
  company: string | null;
  kind: "bank" | "corporate";
  price: PriceQuote | null;
  inputs: {
    price: number | null; epsTtm: number | null; bvps: number | null; pe: number | null; pb: number | null;
    dividendYieldPct: number | null; growthPct: number | null; growthBasis: GrowthBasis; growthCapPct: number;
    growthCapped: boolean; sharesCr: number | null; freeCashFlowCr: number | null; netDebtCr: number | null;
    discountRate: number; terminalGrowth: number;
  };
  growthOptions: GrowthOption[];
  lynch: LynchResult & { bands: typeof LYNCH_BANDS };
  models: ModelLine[];
  combined: { verdict: Verdict; counts: Record<string, number>; total: number; summary: string };
  peers: Valuation["peers"];
  history: Valuation["history"];
  caveats: string[];
  sources: Valuation["sources"];
  generatedAt: string;
}

const round = (v: number | null | undefined, d = 2) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d : null);
const positive = (v: number | null | undefined) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null);
const CYCLICAL = /metal|steel|aluminium|mining|cement|auto|automobile|tyre|oil|gas|petro|energy|power|shipping|sugar|fertili|chemical|realty|construction/i;
const FINANCIAL = /bank|financial|finance|nbfc|insur/i;

/** Quarterly EPS on one basis, newest first, for the growth histories. */
function epsQuarters(db: Db, symbol: string): { period: string; eps: number | null }[] {
  const rows = db.all<Row>(
    "SELECT period_end, consolidated, eps_basic FROM nse_fundamental WHERE symbol = ? AND quality IN ('ok','suspect') ORDER BY period_end DESC, CASE lower(consolidated) WHEN 'consolidated' THEN 0 ELSE 1 END LIMIT 60", [symbol]);
  const seen = new Set<string>();
  return rows.filter((r) => (seen.has(r.period_end) ? false : (seen.add(r.period_end), true)))
    .map((r) => ({ period: String(r.period_end), eps: toNum(r.eps_basic) }));
}

/** Compound annual growth of trailing-twelve-month EPS over `years`, or null when the quarters are not there. */
function epsCagr(qs: { eps: number | null }[], years: number): number | null {
  const window = (from: number) => {
    const slice = qs.slice(from, from + 4);
    if (slice.length < 4 || slice.some((q) => q.eps === null)) return null;
    return slice.reduce((s, q) => s + (q.eps ?? 0), 0);
  };
  const now = window(0);
  const then = window(years * 4);
  if (now === null || then === null || then <= 0 || now <= 0) return null;
  return round(cagr(now, then, years));
}

/** The growth rate the Lynch model runs on, with every candidate shown so the reader can switch. */
export function growthOptions(db: Db, symbol: string, m: Row): GrowthOption[] {
  const qs = epsQuarters(db, symbol);
  const eps3 = epsCagr(qs, 3);
  const eps5 = epsCagr(qs, 5);
  const profit3 = round(toNum(m.profit_growth_3y));
  const parts = [eps3, eps5].filter((v): v is number => v !== null);
  return [
    {
      key: "blended", label: "Blended default",
      valuePct: parts.length ? round(median(parts)) : profit3,
      source: parts.length ? `Median of ${parts.length === 2 ? "3-year and 5-year EPS growth" : "the available EPS history"}` : "3-year net-profit CAGR (no usable EPS history)",
      unavailable: parts.length || profit3 !== null ? undefined : "No measurable earnings history.",
    },
    {
      key: "analyst", label: "Analyst consensus", valuePct: null,
      source: "Forward estimates from a licensed vendor",
      unavailable: "Analyst forecasts need a licensed data vendor, which this platform does not subscribe to. Historical growth is used instead.",
    },
    { key: "eps3y", label: "3-year EPS CAGR", valuePct: eps3, source: "Reported quarterly EPS, XBRL filings", unavailable: eps3 === null ? "Fewer than three years of comparable quarterly EPS." : undefined },
    { key: "eps5y", label: "5-year EPS CAGR", valuePct: eps5, source: "Reported quarterly EPS, XBRL filings", unavailable: eps5 === null ? "Fewer than five years of comparable quarterly EPS." : undefined },
    { key: "profit3y", label: "3-year net-profit CAGR", valuePct: profit3, source: "Quarterly results", unavailable: profit3 === null ? "Not enough annual profit history." : undefined },
  ];
}

export interface VerdictOptions {
  /** Which growth input to run on (default: blended). */
  growth?: GrowthBasis;
  /** The rate itself, for growth = "manual" or a slider. */
  growthPct?: number | null;
  discountRate?: number;
}

/** Everything the valuation-verdict panel shows for one company. */
export function valuationVerdict(db: Db, symbol: string, opts: VerdictOptions = {}): ValuationVerdict {
  const sym = symbol.toUpperCase();
  const m = db.get<Row>("SELECT * FROM company_metrics WHERE symbol = ?", [sym]) ?? {};
  const v = valuation(db, sym); // reuses the cash-flow, EV/EBITDA and peer work already done there
  const pq = quoteFor(db, sym);
  const industry = (m.industry as string | null) ?? null;
  const bank = v.kind === "bank" || FINANCIAL.test(String(industry ?? ""));
  const cyclical = CYCLICAL.test(String(industry ?? ""));

  const price = positive(pq?.lastPrice ?? toNum(m.close));
  const epsTtm = toNum(m.eps_ttm);
  const bvps = positive(toNum(m.bvps));
  const pe = price !== null && epsTtm !== null && epsTtm > 0 ? round(price / epsTtm) : null;
  const pb = price !== null && bvps !== null ? round(price / bvps) : null;
  const divYield = round(toNum(m.div_yield)) ?? 0;

  const options = growthOptions(db, sym, m);
  const basis: GrowthBasis = opts.growth ?? "blended";
  const chosen = options.find((o) => o.key === basis);
  const rawGrowth = basis === "manual" ? (opts.growthPct ?? null) : (opts.growthPct ?? chosen?.valuePct ?? null);
  const capped = rawGrowth !== null && rawGrowth > GROWTH_CAP_PCT;
  const growthPct = rawGrowth === null ? null : capped ? GROWTH_CAP_PCT : round(rawGrowth);

  const l = lynch({ price, epsTtm, pe, growthPct, dividendYieldPct: divYield });

  // --- the other lenses -----------------------------------------------------------------
  const models: ModelLine[] = [];
  const add = (line: ModelLine) => models.push(line);

  add({
    key: "lynch", label: "Lynch ratio (dividend-adjusted PEG)",
    verdict: l.applicable ? l.verdict : null,
    reading: l.applicable ? `Ratio ${l.ratio} (PEGY ${l.pegy}) · fair P/E ${l.fairPe}` : "Not applicable",
    fairValue: l.fairValue, inputs: l.why, unavailable: l.applicable ? undefined : l.why,
  });

  const pegValue = peg(pe, growthPct);
  add({
    key: "peg", label: "PEG",
    verdict: pegValue === null ? null : pegValue < 1 ? "Undervalued" : pegValue > 2 ? "Overvalued" : "Fairly valued",
    reading: pegValue === null ? "Not applicable" : `PEG ${pegValue} (below 1 is the classic cheap, above 2 dear)`,
    fairValue: null,
    inputs: pe !== null && growthPct !== null ? `P/E ${pe} / growth ${growthPct}%` : "",
    unavailable: pegValue === null ? (pe === null ? "P/E unavailable (no positive earnings)." : "Growth is not positive, so PEG has no meaning.") : undefined,
  });

  const g = graham(epsTtm, bvps);
  add({
    key: "graham", label: "Graham number",
    verdict: verdictVsFairValue(price, g),
    reading: g === null ? "Not applicable" : `₹${g} against a price of ₹${price ?? "—"}`,
    fairValue: g,
    inputs: epsTtm !== null && bvps !== null ? `√(22.5 × EPS ${epsTtm} × book value ${bvps})` : "",
    unavailable: g === null ? "Needs positive trailing earnings and a positive book value per share." : undefined,
  });

  // P/E against the sector and against the company's own five-year history.
  const peerPe = v.peers.medianPe;
  const ownPe = v.history.medianPe;
  const peReference = peerPe !== null && ownPe !== null ? round((peerPe + ownPe) / 2) : (ownPe ?? peerPe);
  add({
    key: "relative-pe", label: "P/E against sector and own history",
    verdict: relativeVerdict(pe, peReference),
    reading: pe === null ? "Not applicable"
      : `P/E ${pe} · sector median ${peerPe ?? "—"}${v.peers.count ? ` (${v.peers.count} peers)` : ""} · own 5-year median ${ownPe ?? "—"}`,
    fairValue: epsTtm !== null && epsTtm > 0 && peReference !== null ? round(epsTtm * peReference) : null,
    inputs: peReference !== null ? `Reference P/E ${peReference}, cheap below 0.85× and dear above 1.15×` : "",
    unavailable: pe === null ? "No positive trailing earnings." : peReference === null ? "No sector or historical P/E to compare against." : undefined,
  });

  const evModel = v.models.find((x) => x.key === "ev_ebitda");
  add({
    key: "ev-ebitda", label: bank ? "Price to book against ROE" : "EV/EBITDA",
    verdict: bank ? relativeVerdict(pb, v.peers.medianPb) : verdictVsFairValue(price, evModel?.fairValue ?? null),
    reading: bank
      ? `P/B ${pb ?? "—"} · sector median ${v.peers.medianPb ?? "—"} · ROE ${round(toNum(m.roe), 1) ?? "—"}%`
      : evModel?.fairValue !== null && evModel?.fairValue !== undefined ? `Enterprise value at ${evModel.basis}` : "Not applicable",
    fairValue: bank ? null : evModel?.fairValue ?? null,
    inputs: bank ? "Banks are valued on book value and the return earned on it, not on enterprise value." : evModel?.basis ?? "",
    unavailable: bank ? (pb === null || v.peers.medianPb === null ? "No comparable book-value multiples." : undefined) : evModel?.unavailable,
  });

  const dcfModel = v.models.find((x) => x.key === "dcf");
  const dcfFair = opts.discountRate && v.inputs.freeCashFlowCr && v.inputs.sharesCr
    ? dcfPerShare(Number(v.inputs.freeCashFlowCr), (growthPct ?? 8) / 100, Number(v.inputs.sharesCr), Number(v.inputs.netDebtCr ?? 0), { discountRate: opts.discountRate })
    : dcfModel?.fairValue ?? null;
  add({
    key: "dcf", label: "Discounted cash flow",
    verdict: verdictVsFairValue(price, dcfFair),
    reading: dcfFair === null ? "Not applicable" : `₹${dcfFair} per share at a ${((opts.discountRate ?? 0.12) * 100).toFixed(0)}% discount rate`,
    fairValue: dcfFair,
    inputs: dcfModel?.basis ?? "",
    unavailable: dcfModel?.unavailable,
  });

  const combined = combine(models.map((x) => x.verdict));

  // --- what a reader has to know before trusting any of it ------------------------------
  const caveats: string[] = [];
  if (bank) caveats.push("This is a bank or finance company. Lynch's rule and enterprise-value multiples fit them poorly; price to book against return on equity is the better lens, and it is shown above.");
  if (cyclical) caveats.push(`${industry} is cyclical. Trailing earnings at the top or bottom of a cycle make the P/E look wrong in both directions - read the multi-year history alongside.`);
  if (epsTtm !== null && epsTtm <= 0) caveats.push("The company has no positive trailing earnings, so every earnings-based model above is suppressed rather than estimated.");
  if (capped) caveats.push(`Growth was capped at ${GROWTH_CAP_PCT}% a year. The measured rate was ${round(rawGrowth)}%, which no company sustains for long, and leaving it uncapped would produce a fair value nobody should act on.`);
  if (growthPct !== null && growthPct >= GROWTH_CAP_PCT - 5) caveats.push("High assumed growth: the fair value is very sensitive to this input. Move the slider to see how much.");
  if (pe !== null && pe > 80) caveats.push("A P/E above 80 means the market is pricing years of growth that has not been reported yet.");
  if (options.find((o) => o.key === "analyst")?.unavailable) caveats.push("Growth here is measured from filed results, not forecast. Past growth is not a prediction.");
  if (!v.peers.count) caveats.push("No sector peers with comparable data, so the relative check carries less weight.");

  return {
    symbol: sym,
    company: (m.company as string | null) ?? v.company,
    kind: bank ? "bank" : "corporate",
    price: pq,
    inputs: {
      price, epsTtm: round(epsTtm), bvps: round(bvps), pe, pb, dividendYieldPct: divYield,
      growthPct, growthBasis: basis, growthCapPct: GROWTH_CAP_PCT, growthCapped: capped,
      sharesCr: (v.inputs.sharesCr as number | null) ?? null,
      freeCashFlowCr: (v.inputs.freeCashFlowCr as number | null) ?? null,
      netDebtCr: (v.inputs.netDebtCr as number | null) ?? null,
      discountRate: opts.discountRate ?? 0.12, terminalGrowth: 0.04,
    },
    growthOptions: options,
    lynch: { ...l, bands: LYNCH_BANDS },
    models,
    combined,
    peers: v.peers,
    history: v.history,
    caveats,
    sources: v.sources,
    generatedAt: new Date().toISOString(),
  };
}
