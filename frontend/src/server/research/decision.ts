// Turns the facts and the fair value into an explainable call: what the company scores, which investment
// conditions it meets, and what would stop someone buying it today.
//
// Nothing here is advice and nothing is predicted. Every line states a measured figure and the rule applied
// to it, so a reader can disagree with the rule rather than guess at the reasoning.
import type { Db } from "../db";
import { facts, industryMedian, type Facts } from "./facts";
import { valuation, type Valuation } from "./valuation";

/** How the company screens, stated as a finding rather than an instruction: SEBI treats buy, sell, hold and
 *  price targets as regulated research recommendations, which this platform does not issue. */
export type Verdict = "SCREENS UNDERVALUED" | "SCREENS FAIRLY VALUED" | "SCREENS EXPENSIVE" | "MIXED SIGNALS" | "DATA UNAVAILABLE";

export interface Condition { key: string; label: string; met: boolean | null; detail: string }
export interface Score { key: string; label: string; score: number | null; weight: number; detail: string }

export interface Decision {
  symbol: string;
  company: string | null;
  verdict: Verdict;
  score: number | null;
  confidence: "high" | "medium" | "low";
  risk: { level: "LOW" | "MODERATE" | "HIGH" | "VERY HIGH" | "UNKNOWN"; score: number | null; factors: { label: string; level: string; detail: string }[] };
  scores: Score[];
  conditions: Condition[];
  conditionsMet: string;
  whyInvest: string[];
  whyWait: string[];
  whatCouldGoWrong: string[];
  whatToWatch: string[];
  valuation: Valuation;
  facts: Facts;
}

/** Weights of the score, published rather than hidden. Change them here and every answer follows. */
export const WEIGHTS = { fundamentals: 25, valuation: 20, growth: 15, profitability: 10, balanceSheet: 10, cashFlow: 10, governance: 5, trend: 5 };

const band = (v: number | null, good: number, ok: number, invert = false): number | null => {
  if (v === null) return null;
  const better = invert ? v <= good : v >= good;
  const fine = invert ? v <= ok : v >= ok;
  return better ? 90 : fine ? 65 : 35;
};
const pctText = (v: number | null, digits = 1) => (v === null ? "Data unavailable" : `${v > 0 ? "+" : ""}${v.toFixed(digits)}%`);
const crText = (v: number | null) => (v === null ? "Data unavailable" : `₹${Math.round(v).toLocaleString("en-IN")} Cr`);

export function decide(db: Db, symbol: string): Decision {
  const fx = facts(db, symbol);
  const val = valuation(db, symbol);
  const industryPe = industryMedian(db, fx.industry, "pe");
  const industryRoe = industryMedian(db, fx.industry, "roe");

  const mos = val.marginOfSafety;
  const scores: Score[] = [
    {
      key: "fundamentals", label: "Business fundamentals", weight: WEIGHTS.fundamentals,
      score: band(fx.returns.roe.value, 18, 12),
      detail: fx.returns.roe.value === null ? "Return on equity unavailable." : `Return on equity ${pctText(fx.returns.roe.value)}${industryRoe !== null ? ` against an industry median of ${pctText(industryRoe)}` : ""}.`,
    },
    {
      key: "valuation", label: "Valuation", weight: WEIGHTS.valuation,
      score: mos === null ? null : mos >= 20 ? 90 : mos >= 5 ? 70 : mos >= -10 ? 50 : mos >= -30 ? 30 : 10,
      detail: mos === null ? "No fair value could be calculated." : `Priced ${mos >= 0 ? `${mos.toFixed(1)}% below` : `${(-mos).toFixed(1)}% above`} the weighted fair value of ₹${val.fairValue}.`,
    },
    {
      key: "growth", label: "Growth", weight: WEIGHTS.growth,
      score: band(fx.growth.patCagr3y.value ?? fx.growth.patYoY.value, 15, 7),
      detail: `Profit ${fx.growth.patCagr3y.value !== null ? `grew ${pctText(fx.growth.patCagr3y.value)} a year over three years` : `changed ${pctText(fx.growth.patYoY.value)} against the same quarter last year`}; revenue ${pctText(fx.growth.revenueCagr3y.value ?? fx.growth.revenueYoY.value)}.`,
    },
    {
      key: "profitability", label: "Profitability", weight: WEIGHTS.profitability,
      score: band(fx.margins.net.value, 12, 6),
      detail: `Net margin ${pctText(fx.margins.net.value)}${fx.margins.operating.value !== null ? `, operating margin ${pctText(fx.margins.operating.value)}` : ""}.`,
    },
    {
      key: "balanceSheet", label: "Balance sheet", weight: WEIGHTS.balanceSheet,
      score: fx.bank ? band(fx.returns.roe.value, 15, 10) : band(fx.balance.debtToEquity.value, 0.3, 1, true),
      detail: fx.bank
        ? "Lenders carry deposits and borrowings by design, so debt ratios are not comparable with other companies."
        : `Debt ${crText(fx.balance.debtCr.value)}, net debt ${crText(fx.balance.netDebtCr.value)}, debt to equity ${fx.balance.debtToEquity.value ?? "unavailable"}${fx.balance.interestCover.value !== null ? `, operating profit covers interest ${fx.balance.interestCover.value.toFixed(1)}×` : ""}.`,
    },
    {
      key: "cashFlow", label: "Cash flow", weight: WEIGHTS.cashFlow,
      score: fx.cash.conversion.value === null ? null : band(fx.cash.conversion.value, 80, 50),
      detail: fx.cash.conversion.value === null
        ? "No annual cash flow statement parsed yet."
        : `Operating cash flow ${crText(fx.cash.cfoCr.value)} against profit ${crText(fx.cash.patCr.value)} (${fx.cash.conversion.value.toFixed(0)}% conversion); free cash flow ${crText(fx.cash.fcfCr.value)}.`,
    },
    {
      key: "governance", label: "Ownership signals", weight: WEIGHTS.governance,
      score: fx.shareholding.promoter.value === null ? null : fx.shareholding.promoter.value >= 50 ? 85 : fx.shareholding.promoter.value >= 25 ? 65 : 50,
      detail: fx.shareholding.promoter.value === null
        ? "No shareholding pattern parsed yet."
        : fx.shareholding.promoter.value === 0
          ? `Widely held: no promoter is identified in the filing; institutions hold ${pctText((fx.shareholding.fii.value ?? 0) + (fx.shareholding.dii.value ?? 0))}.`
          : `Promoters hold ${pctText(fx.shareholding.promoter.value)}${fx.shareholding.promoterChange.value ? ` (${pctText(fx.shareholding.promoterChange.value, 2)} last quarter)` : ""}; institutions hold ${pctText((fx.shareholding.fii.value ?? 0) + (fx.shareholding.dii.value ?? 0))}.`,
    },
    {
      key: "trend", label: "Price trend", weight: WEIGHTS.trend,
      score: band(fx.returns.ret1y.value, 10, -10),
      detail: `Price ${pctText(fx.returns.ret1y.value)} over a year, ${pctText(fx.returns.ret1m.value)} over a month.`,
    },
  ];

  const scored = scores.filter((s) => s.score !== null);
  const total = scored.reduce((sum, s) => sum + s.score! * s.weight, 0);
  const weight = scored.reduce((sum, s) => sum + s.weight, 0);
  const score = weight ? Math.round(total / weight) : null;

  // --- risk ----------------------------------------------------------------------------------------
  const riskFactors: { label: string; level: string; detail: string }[] = [];
  const addRisk = (label: string, bad: boolean | null, badText: string, okText: string, unknownText = "Data unavailable") =>
    riskFactors.push({ label, level: bad === null ? "unknown" : bad ? "high" : "low", detail: bad === null ? unknownText : bad ? badText : okText });
  addRisk("Valuation", mos === null ? null : mos < -10, `Priced above fair value by ${mos !== null ? (-mos).toFixed(0) : "?"}%.`, "Priced at or below the estimated fair value.");
  addRisk("Debt", fx.bank ? null : fx.balance.debtToEquity.value === null ? null : fx.balance.debtToEquity.value > 1, `Debt to equity ${fx.balance.debtToEquity.value}.`, `Debt to equity ${fx.balance.debtToEquity.value}.`,
    fx.bank ? "Not applicable: a lender funds itself with deposits and borrowings by design." : "No balance sheet parsed yet.");
  addRisk("Earnings quality", fx.cash.conversion.value === null ? null : fx.cash.conversion.value < 60, "Reported profit is not fully backed by operating cash flow.", "Operating cash flow covers reported profit.");
  addRisk("Growth", fx.growth.patYoY.value === null ? null : fx.growth.patYoY.value < 0, `Profit fell ${pctText(fx.growth.patYoY.value)} against the same quarter last year.`, `Profit ${pctText(fx.growth.patYoY.value)} against the same quarter last year.`);
  addRisk("Ownership", fx.shareholding.promoterChange.value === null ? null : fx.shareholding.promoterChange.value < -1, `Promoter holding fell ${pctText(fx.shareholding.promoterChange.value, 2)} last quarter.`, "Promoter holding is steady or rising.");
  addRisk("Data coverage", val.inputs.quartersParsed === null ? null : Number(val.inputs.quartersParsed) < 8, `Only ${val.inputs.quartersParsed} quarters of results are on record.`, `${val.inputs.quartersParsed} quarters of results on record.`);
  const highs = riskFactors.filter((r) => r.level === "high").length;
  const unknowns = riskFactors.filter((r) => r.level === "unknown").length;
  const riskLevel = unknowns >= 4 ? "UNKNOWN" : highs >= 4 ? "VERY HIGH" : highs >= 3 ? "HIGH" : highs >= 1 ? "MODERATE" : "LOW";

  // --- the eight investment conditions ---------------------------------------------------------------
  const cond = (key: string, label: string, met: boolean | null, detail: string): Condition => ({ key, label, met, detail });
  const conditions: Condition[] = [
    cond("fundamentals", "Fundamentals are healthy", fx.returns.roe.value === null ? null : fx.returns.roe.value >= 12, scores[0].detail),
    cond("growth", "Revenue and profit are growing", fx.growth.patCagr3y.value === null && fx.growth.patYoY.value === null ? null : (fx.growth.patCagr3y.value ?? fx.growth.patYoY.value)! > 0, scores[2].detail),
    cond("cash", "Cash flow supports reported profit", fx.cash.conversion.value === null ? null : fx.cash.conversion.value >= 60, scores[5].detail),
    cond("debt", "Debt is manageable", fx.bank ? null : fx.balance.debtToEquity.value === null ? null : fx.balance.debtToEquity.value <= 1, scores[4].detail),
    cond("valuation", "Valuation is reasonable", mos === null ? null : mos >= -10, scores[1].detail),
    cond("mos", "Margin of safety is sufficient", mos === null ? null : mos >= 15, mos === null ? "No fair value available." : `Margin of safety ${mos.toFixed(1)}%, against a 15% threshold.`),
    cond("ownership", "No ownership red flags", fx.shareholding.promoterChange.value === null ? null : fx.shareholding.promoterChange.value >= -1, scores[6].detail),
    cond("coverage", "Enough data to judge", Number(val.inputs.quartersParsed ?? 0) >= 8 && val.fairValue !== null, `${val.inputs.quartersParsed ?? 0} quarters parsed; ${val.models.filter((x) => x.fairValue !== null).length} of ${val.models.length} valuation models produced a value.`),
  ];
  const met = conditions.filter((c) => c.met === true).length;
  const known = conditions.filter((c) => c.met !== null).length;

  // --- the call ---------------------------------------------------------------------------------------
  let verdict: Verdict = "DATA UNAVAILABLE";
  if (score !== null && mos !== null) {
    const sound = score >= 60;
    if (mos >= 15 && sound) verdict = "SCREENS UNDERVALUED";
    else if (mos <= -15 || score < 45) verdict = "SCREENS EXPENSIVE";
    else if (mos >= -10 && sound) verdict = "SCREENS FAIRLY VALUED";
    else verdict = "MIXED SIGNALS";
  }
  const confidence = val.confidence === "high" && known >= 7 ? "high" : val.confidence === "none" || known <= 4 ? "low" : "medium";

  const whyInvest = [...val.reasons];
  if ((fx.returns.roe.value ?? 0) >= 15) whyInvest.push(`Return on equity of ${pctText(fx.returns.roe.value)} is high for a business of this size.`);
  if ((fx.growth.patCagr3y.value ?? 0) >= 12) whyInvest.push(`Profit has compounded ${pctText(fx.growth.patCagr3y.value)} a year over three years.`);
  if ((fx.cash.conversion.value ?? 0) >= 80) whyInvest.push(`Operating cash flow covers ${fx.cash.conversion.value!.toFixed(0)}% of reported profit, so earnings are backed by cash.`);
  if (!fx.bank && (fx.balance.netDebtCr.value ?? 1) < 0) whyInvest.push(`Net cash of ${crText(-(fx.balance.netDebtCr.value ?? 0))} rather than net debt.`);
  if ((fx.dividend.yield.value ?? 0) >= 2) whyInvest.push(`Dividend yield ${pctText(fx.dividend.yield.value)} at the current price.`);

  const whyWait = [...val.cautions];
  if (mos !== null && mos < 15 && mos > -10) whyWait.push("The price sits close to the estimated fair value, leaving little room for error.");
  if (industryPe && val.inputs.currentPe && Number(val.inputs.currentPe) > industryPe) whyWait.push(`P/E of ${val.inputs.currentPe} is above the ${fx.industry} median of ${industryPe}.`);
  if ((fx.cash.conversion.value ?? 100) < 60) whyWait.push("Reported profit is not fully supported by operating cash flow.");
  if (conditions.find((c) => c.key === "coverage")?.met === false) whyWait.push("Parts of the record are still missing, so the estimate rests on fewer quarters than it should.");

  const whatCouldGoWrong = [
    fx.bank ? "Loan losses rise or margins compress, which hits book value and earnings together." : "Margins fall back to their historical average, which would lower every earnings-based value here.",
    "Growth slows below the rate the discounted cash flow assumes, which lowers fair value directly.",
    ...(fx.shareholding.promoterChange.value !== null && fx.shareholding.promoterChange.value < 0 ? ["Promoters keep reducing their holding."] : []),
    ...((fx.balance.debtToEquity.value ?? 0) > 1 ? ["Interest costs rise on borrowings that are already large relative to equity."] : []),
    "The valuation multiples used here reflect today's market mood, which can change quickly.",
  ];

  const whatToWatch = [
    `Next quarterly result${fx.quarters[0] ? ` (last one: ${fx.quarters[0].period})` : ""}: revenue, margin and whether profit is backed by cash.`,
    "Shareholding pattern each quarter: promoter holding, pledge, and institutional flows.",
    ...(fx.bank ? ["Asset quality and provisions disclosed with results."] : ["Free cash flow and capital spending in the annual cash flow statement."]),
    `Price against the discount band: ${val.zones[1]?.from ? `₹${val.zones[1].from} – ₹${val.zones[1].to}` : "unavailable"}.`,
  ];

  return {
    symbol: fx.symbol,
    company: fx.company,
    verdict,
    score,
    confidence,
    risk: { level: riskLevel, score: highs === 0 ? 15 : Math.min(95, 25 * highs), factors: riskFactors },
    scores,
    conditions,
    conditionsMet: `${met} of ${known} testable conditions met${known < conditions.length ? ` (${conditions.length - known} could not be tested)` : ""}`,
    whyInvest: whyInvest.slice(0, 5),
    whyWait: whyWait.slice(0, 5),
    whatCouldGoWrong: whatCouldGoWrong.slice(0, 5),
    whatToWatch,
    valuation: val,
    facts: fx,
  };
}
