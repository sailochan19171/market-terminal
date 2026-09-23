// Contracts for every agent's output (spec §6, §10.1 "contract tests").
//
// The spec asks for Pydantic models so invalid data fails immediately. This is the same idea in TypeScript at
// runtime: each report is checked against its shape the moment a worker returns it, and a report that does not
// validate is treated as that worker failing - recorded as an AgentError, left out, and listed as missing -
// rather than passed on to the validator and the writer.

type Check = (v: unknown, path: string, problems: string[]) => void;

const is = {
  str: (nullable = false): Check => (v, p, out) => { if (!(typeof v === "string" || (nullable && v === null))) out.push(`${p}: expected ${nullable ? "string or null" : "string"}`); },
  num: (nullable = false): Check => (v, p, out) => {
    if (nullable && v === null) return;
    if (typeof v !== "number" || !Number.isFinite(v)) out.push(`${p}: expected a finite number${nullable ? " or null" : ""}, got ${JSON.stringify(v)}`);
  },
  bool: (nullable = false): Check => (v, p, out) => { if (!(typeof v === "boolean" || (nullable && v === null))) out.push(`${p}: expected boolean`); },
  oneOf: (values: (string | null)[]): Check => (v, p, out) => { if (!values.includes(v as string | null)) out.push(`${p}: expected one of ${values.join(", ")}, got ${JSON.stringify(v)}`); },
  arr: (item: Check): Check => (v, p, out) => {
    if (!Array.isArray(v)) { out.push(`${p}: expected an array`); return; }
    v.forEach((x, i) => item(x, `${p}[${i}]`, out));
  },
  obj: (shape: Record<string, Check>, optional: string[] = []): Check => (v, p, out) => {
    if (!v || typeof v !== "object" || Array.isArray(v)) { out.push(`${p}: expected an object`); return; }
    const o = v as Record<string, unknown>;
    for (const [k, check] of Object.entries(shape)) {
      if (o[k] === undefined) {
        if (!optional.includes(k)) out.push(`${p}.${k}: missing`);
        continue;
      }
      check(o[k], `${p}.${k}`, out);
    }
  },
  record: (value: Check): Check => (v, p, out) => {
    if (!v || typeof v !== "object" || Array.isArray(v)) { out.push(`${p}: expected an object`); return; }
    for (const [k, x] of Object.entries(v)) value(x, `${p}.${k}`, out);
  },
  score: (): Check => (v, p, out) => { if (v !== null && (typeof v !== "number" || v < 0 || v > 100)) out.push(`${p}: expected a 0-100 score or null`); },
  any: (): Check => () => {},
};

const unavailable = is.arr(is.obj({ key: is.str(), reason: is.str() }));
const point = is.obj({ year: is.num(), value: is.num(true), inputs: is.record(is.num(true)) }, ["reason"]);

const RatioReport = is.obj({
  symbol: is.str(), market: is.oneOf(["IN", "US"]), currency: is.oneOf(["INR", "USD"]), sectorSet: is.oneOf(["standard", "financial"]),
  years: is.arr(is.num()),
  categories: is.record(is.record(is.obj({
    formulaId: is.str(), label: is.str(), unit: is.oneOf(["ratio", "percent", "days", "times", "currency"]),
    series: is.arr(point), latest: is.num(true), median10y: is.num(true), min10y: is.num(true), max10y: is.num(true), std10y: is.num(true),
    trend: is.oneOf(["improving", "stable", "declining", null]), consistency: is.num(true), sectorMedian: is.num(true), percentileInSector: is.num(true),
  }, ["ttm"]))),
  qualityScores: is.obj({
    dupont: is.arr(is.obj({ year: is.num(), netMargin: is.num(true), assetTurnover: is.num(true), equityMultiplier: is.num(true), roe: is.num(true) })),
    piotroski: is.obj({ score: is.num(true), tests: is.arr(is.obj({ name: is.str(), passed: is.bool(true), detail: is.str() })) }),
    altmanZ: is.obj({ score: is.num(true), zone: is.oneOf(["safe", "grey", "distress", null]), variant: is.str() }, ["reason"]),
    beneishM: is.obj({ score: is.num(true), flag: is.bool(true) }, ["reason"]),
  }),
  categoryScores: is.obj({ fundamental: is.score(), growth: is.score(), valuation: is.score(), financialHealth: is.score() }),
  unavailable,
}, ["company", "industry", "peers"]);

const ValuationReport = is.obj({
  symbol: is.str(), currentPrice: is.num(true),
  scenarios: is.arr(is.obj({ name: is.oneOf(["bear", "base", "bull"]), intrinsicValuePerShare: is.num(true), assumptions: is.any() })),
  marginOfSafety: is.num(true), requiredMarginOfSafety: is.num(), meetsRequirement: is.bool(true),
  relativeMultiples: is.obj({ pe: is.num(true), peOwnMedian: is.num(true), peSector: is.num(true), pb: is.num(true), pbSector: is.num(true), evEbitda: is.num(true), evEbitdaReference: is.num(true) }),
  models: is.arr(is.obj({ key: is.str(), label: is.str(), fairValue: is.num(true), basis: is.str() }, ["unavailable"])),
  assumptionNotes: is.arr(is.str()),
  unavailable,
});

const TechnicalReport = is.obj({
  symbol: is.str(), ma50: is.num(true), ma200: is.num(true), priceVsMa50: is.num(true), priceVsMa200: is.num(true),
  high52w: is.num(true), low52w: is.num(true), returns: is.obj({ "1y": is.num(true), "3y": is.num(true), "5y": is.num(true) }),
  volatility: is.num(true), rsi14: is.num(true), trendLabel: is.oneOf(["uptrend", "downtrend", "sideways", null]), asOf: is.str(true), unavailable,
});

const item = is.obj({ summary: is.str(), sentiment: is.oneOf(["positive", "negative", "neutral"]), sourceUrl: is.str(true), sourceLabel: is.str(), date: is.str(true) });
const QualitativeReport = is.obj({ symbol: is.str(), moatSignals: is.arr(item), managementSignals: is.arr(item), risks: is.arr(item), unavailable });

const issue = is.obj({ check: is.str(), severity: is.oneOf(["warning", "failure"]), detail: is.str() }, ["worker"]);
const ValidationReport = is.obj({ passed: is.bool(), warnings: is.arr(issue), failedItems: is.arr(issue), lowConfidence: is.arr(is.str()) });

const FinalAnalysis = is.obj({
  personaId: is.str(), personaName: is.str(), summary: is.str(), strengths: is.arr(is.str()), concerns: is.arr(is.str()),
  keyNumbers: is.arr(is.obj({ label: is.str(), value: is.str(), source: is.str() }, ["url"])),
  categoryScores: is.obj({ fundamental: is.score(), valuation: is.score(), technical: is.score(), qualitative: is.score() }),
  personaFit: is.score(), missingData: is.arr(is.str()), writtenBy: is.oneOf(["data", "model"]), removed: is.arr(is.str()), disclaimer: is.str(),
}, ["model", "note", "sections"]);

const ResearchPlan = is.obj({
  symbol: is.str(), reasoning: is.str(), plannedBy: is.oneOf(["model", "default"]),
  tasks: is.arr(is.obj({ worker: is.oneOf(["ratio_engine", "valuation_agent", "technical_agent", "news_moat_agent"]) }, ["focus", "years", "methods", "questions", "priority", "growthSuggestion"])),
});

const RawData = is.obj({
  symbol: is.str(), market: is.oneOf(["IN", "US"]), currency: is.oneOf(["INR", "USD"]), exchange: is.str(), ticker: is.str(),
  sectorSet: is.oneOf(["standard", "financial"]), marketCap: is.num(true), sharesOutstanding: is.num(true),
  annual: is.arr(is.obj({ year: is.num(), periodEnd: is.str(), revenue: is.num(true), netIncome: is.num(true), totalAssets: is.num(true), shareholdersEquity: is.num(true) }, [])),
  quarterly: is.arr(is.obj({ periodEnd: is.str(), revenue: is.num(true), netIncome: is.num(true), epsDiluted: is.num(true) }, ["operatingIncome", "source"])),
  prices: is.arr(is.obj({ t: is.str(), c: is.num() })),
  filings: is.arr(is.obj({ when: is.str(), title: is.str(), url: is.str(true), source: is.str() }, ["detail"])),
  sources: is.arr(is.obj({ dataset: is.str(), source: is.str(), fetchedAt: is.str() })),
  unavailable,
}, ["company", "industry", "quote", "fiscalYearEnd", "ttm", "referencePe", "bookValuePerShare", "dividendPerShare", "yearEndPrices", "peerMultiples", "peers", "fetchedAt"]);

export const CONTRACTS = { RawData, ResearchPlan, RatioReport, ValuationReport, TechnicalReport, QualitativeReport, ValidationReport, FinalAnalysis } as const;
export type Contract = keyof typeof CONTRACTS;

/** The problems with a value against its contract; an empty list means it validates. */
export function validateContract(name: Contract, value: unknown): string[] {
  const problems: string[] = [];
  CONTRACTS[name](value, name, problems);
  return problems.slice(0, 20);
}

/** Throw when a value does not validate - used where an invalid report must stop at once. */
export function assertContract<T>(name: Contract, value: T): T {
  const problems = validateContract(name, value);
  if (problems.length) throw new Error(`${name} failed its contract: ${problems.slice(0, 3).join("; ")}`);
  return value;
}
