// The valuation formulas, written once and shared by the server and the browser.
//
// The company page lets a reader drag the growth and discount-rate sliders and see the verdict move, which only
// stays honest if the number under the slider is produced by the same code that produced the stored verdict.
// Nothing here touches a database or a request: give it inputs, it returns a value or null.

export type Verdict = "Undervalued" | "Fair to attractive" | "Fairly valued" | "Overvalued" | "Not applicable";

/** Growth above this is treated as unsustainable for valuation purposes, and the cap is disclosed to the reader. */
export const GROWTH_CAP_PCT = 25;

/**
 * Peter Lynch's dividend-adjusted rule, in the "higher is cheaper" form:
 *   Lynch ratio = (expected EPS growth % + dividend yield %) / P/E
 * The textbook PEGY is its reciprocal, P/E / (growth + yield), where lower is cheaper; both are returned so
 * neither reader is confused, and they always agree on the verdict.
 */
export const LYNCH_BANDS: { upTo: number; verdict: Verdict; meaning: string }[] = [
  { upTo: 1.0, verdict: "Overvalued", meaning: "The P/E is more than the growth and yield the company delivers." },
  { upTo: 1.5, verdict: "Fairly valued", meaning: "The P/E is about equal to growth plus yield, which is Lynch's definition of fair." },
  { upTo: 2.0, verdict: "Fair to attractive", meaning: "Growth and yield run ahead of the P/E - the cheap half of fair." },
  { upTo: Infinity, verdict: "Undervalued", meaning: "Growth and yield are more than twice the P/E." },
];

export const bandFor = (ratio: number): { upTo: number; verdict: Verdict; meaning: string } =>
  LYNCH_BANDS.find((b) => ratio < b.upTo) ?? LYNCH_BANDS[LYNCH_BANDS.length - 1];

export interface LynchInput {
  price: number | null;
  epsTtm: number | null;
  pe: number | null;
  growthPct: number | null;
  dividendYieldPct: number | null;
}

export interface LynchResult {
  applicable: boolean;
  ratio: number | null;        // (growth + yield) / P/E - higher is cheaper
  pegy: number | null;         // P/E / (growth + yield) - the textbook form, lower is cheaper
  fairPe: number | null;       // growth + yield
  fairValue: number | null;    // EPS x fair P/E
  upsidePct: number | null;
  verdict: Verdict;
  meaning: string;
  why: string;
}

const r2 = (v: number | null): number | null => (v === null || !Number.isFinite(v) ? null : Math.round(v * 100) / 100);

export function lynch(input: LynchInput): LynchResult {
  const na = (why: string): LynchResult => ({
    applicable: false, ratio: null, pegy: null, fairPe: null, fairValue: null, upsidePct: null,
    verdict: "Not applicable", meaning: why, why,
  });
  const { price, growthPct, dividendYieldPct } = input;
  const eps = input.epsTtm;
  // P/E from the price and earnings when it is not supplied, so the ratio and the fair value never disagree.
  const pe = input.pe ?? (price !== null && eps !== null && eps > 0 ? price / eps : null);
  if (eps === null || eps <= 0) return na("No positive trailing earnings, so P/E - and with it the Lynch ratio - does not apply. Price-to-sales, EV/EBITDA and the cash-flow model still do.");
  if (pe === null || pe <= 0) return na("P/E unavailable.");
  if (growthPct === null) return na("Expected earnings growth unavailable, and the model cannot be run without it.");
  const yieldPct = dividendYieldPct ?? 0; // a company that pays nothing has a yield of zero, not a missing input
  const fairPe = growthPct + yieldPct;
  if (fairPe <= 0) return na("Expected growth plus dividend yield is not positive, so the model implies no fair P/E. Earnings are shrinking on the growth basis chosen.");
  const ratio = fairPe / pe;
  const fairValue = eps * fairPe;
  const band = bandFor(ratio);
  return {
    applicable: true,
    ratio: r2(ratio), pegy: r2(pe / fairPe), fairPe: r2(fairPe), fairValue: r2(fairValue),
    upsidePct: price ? r2(((fairValue - price) / price) * 100) : null,
    verdict: band.verdict, meaning: band.meaning,
    why: `(${growthPct.toFixed(2)}% growth + ${yieldPct.toFixed(2)}% yield) / ${pe.toFixed(2)} P/E = ${ratio.toFixed(2)}`,
  };
}

/** Benjamin Graham's number: the most a defensive investor should pay, sqrt(22.5 x EPS x book value per share). */
export function graham(epsTtm: number | null, bvps: number | null): number | null {
  if (epsTtm === null || bvps === null || epsTtm <= 0 || bvps <= 0) return null;
  return r2(Math.sqrt(22.5 * epsTtm * bvps));
}

/** Price/earnings to growth. Below 1 is the classic "cheap"; undefined without positive growth. */
export function peg(pe: number | null, growthPct: number | null): number | null {
  if (pe === null || growthPct === null || pe <= 0 || growthPct <= 0) return null;
  return r2(pe / growthPct);
}

export const DCF_DEFAULTS = { discountRate: 0.12, terminalGrowth: 0.04, years: 10 };

/**
 * Present value per share of a cash-flow stream whose growth fades linearly to the terminal rate.
 * `baseCash`, `netDebt` and `shares` must share one unit (rupees, or crore).
 */
export function dcfPerShare(baseCash: number | null, growth: number, shares: number | null, netDebt: number,
  opts: Partial<typeof DCF_DEFAULTS> = {}): number | null {
  const { discountRate: r, terminalGrowth: g, years } = { ...DCF_DEFAULTS, ...opts };
  if (baseCash === null || shares === null || !(baseCash > 0) || !(shares > 0) || r <= g) return null;
  let pv = 0;
  let cash = baseCash;
  for (let y = 1; y <= years; y++) {
    const rate = growth + ((g - growth) * (y - 1)) / (years - 1);
    cash *= 1 + rate;
    pv += cash / (1 + r) ** y;
  }
  pv += (cash * (1 + g)) / (r - g) / (1 + r) ** years;
  return r2((pv - netDebt) / shares);
}

/**
 * Where a measure sits against a reference (a sector median, the company's own history, a fair value).
 * `lowerIsCheaper` is true for multiples (P/E against a median) and false for values (price against fair value).
 */
export function relativeVerdict(value: number | null, reference: number | null, lowerIsCheaper = true, cheap = 0.85, rich = 1.15): Verdict | null {
  if (value === null || reference === null || !(reference > 0) || !(value > 0)) return null;
  const x = value / reference;
  const low = lowerIsCheaper ? x < cheap : x > 1 / cheap;
  const high = lowerIsCheaper ? x > rich : x < 1 / rich;
  return low ? "Undervalued" : high ? "Overvalued" : "Fairly valued";
}

/** Price against a model's fair value: cheap when the price is well below it. */
export const verdictVsFairValue = (price: number | null, fairValue: number | null): Verdict | null =>
  price === null || fairValue === null || !(price > 0) || !(fairValue > 0)
    ? null
    : price < fairValue * 0.85 ? "Undervalued" : price > fairValue * 1.15 ? "Overvalued" : "Fairly valued";

/** "3 of 5 models screen overvalued" - the headline that no single model gets to own. */
export function combine(verdicts: (Verdict | null)[]): { verdict: Verdict; counts: Record<string, number>; total: number; summary: string } {
  const usable = verdicts.filter((v): v is Verdict => v !== null && v !== "Not applicable");
  const counts: Record<string, number> = { Undervalued: 0, "Fair to attractive": 0, "Fairly valued": 0, Overvalued: 0 };
  for (const v of usable) counts[v] = (counts[v] ?? 0) + 1;
  if (!usable.length) return { verdict: "Not applicable", counts, total: 0, summary: "No model has the inputs it needs." };
  // "Fair to attractive" counts as cheap-leaning fair: it never outvotes a clear majority either way.
  const cheap = counts.Undervalued + counts["Fair to attractive"];
  const rich = counts.Overvalued;
  const fair = counts["Fairly valued"];
  const verdict: Verdict = cheap > rich && cheap > fair ? "Undervalued" : rich > cheap && rich > fair ? "Overvalued" : "Fairly valued";
  const lead = verdict === "Undervalued" ? cheap : verdict === "Overvalued" ? rich : fair;
  const word = verdict === "Undervalued" ? "undervalued" : verdict === "Overvalued" ? "overvalued" : "fairly valued";
  return { verdict, counts, total: usable.length, summary: `${lead} of ${usable.length} models screen ${word}` };
}
