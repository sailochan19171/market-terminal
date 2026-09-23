// Personas and scoring weights, read from config/ (spec §3.9, §4.7).
//
// A persona is a YAML file: dropping a new one into config/personas/ adds it to the picker with no code change.
// The files use a small, predictable subset of YAML - maps, lists of scalars, and `|` blocks - which the reader
// below handles without a dependency.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

export interface Persona {
  id: string;
  name: string;
  inspiredBy: string;
  tagline: string;
  systemPrompt: string;
  keyMetrics: string[];
  weights: { fundamental: number; valuation: number; technical: number; qualitative: number };
  dcfGrowthCap: number;
  requiredMarginOfSafety: number;
  thresholds: Record<string, number>;
  researchQuestions: string[];
}

export interface Scoring {
  categories: Record<"fundamental" | "growth" | "valuation" | "financialHealth", Record<string, number>>;
  /** Replacements for fundamental and financialHealth when the company uses the financial-sector set. */
  financial: Record<"fundamental" | "financialHealth", Record<string, number>>;
  lowerIsBetter: string[];
}

type Yaml = string | number | boolean | null | Yaml[] | { [k: string]: Yaml };

const scalar = (raw: string): Yaml => {
  const v = raw.replace(/\s+#.*$/, "").trim();
  if (v === "" || v === "~" || v === "null") return null;
  if (v === "true" || v === "false") return v === "true";
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  if (/^(["']).*\1$/.test(v)) return v.slice(1, -1);
  return v;
};

/** Parse the YAML subset the config files use. Throws on anything it does not understand. */
export function parseYaml(text: string): { [k: string]: Yaml } {
  const lines = text.split(/\r?\n/);
  let i = 0;
  const indentOf = (l: string) => l.length - l.trimStart().length;
  const skip = () => {
    while (i < lines.length && (!lines[i].trim() || lines[i].trimStart().startsWith("#"))) i++;
  };

  function block(indent: number): Yaml {
    skip();
    if (i >= lines.length) return null;
    if (lines[i].trimStart().startsWith("- ")) {
      const list: Yaml[] = [];
      while (i < lines.length) {
        skip();
        if (i >= lines.length || indentOf(lines[i]) !== indent || !lines[i].trimStart().startsWith("- ")) break;
        list.push(scalar(lines[i].trimStart().slice(2)));
        i++;
      }
      return list;
    }
    const map: { [k: string]: Yaml } = {};
    while (i < lines.length) {
      skip();
      if (i >= lines.length || indentOf(lines[i]) < indent) break;
      if (indentOf(lines[i]) > indent) throw new Error(`unexpected indentation on line ${i + 1}`);
      const m = lines[i].trim().match(/^([A-Za-z0-9_]+):(.*)$/);
      if (!m) throw new Error(`cannot read line ${i + 1}: ${lines[i].trim()}`);
      const [, key, rest] = m;
      i++;
      if (rest.trim() === "|" || rest.trim() === ">") {
        const folded = rest.trim() === ">";
        const body: string[] = [];
        let inner = -1;
        while (i < lines.length && (!lines[i].trim() || indentOf(lines[i]) > indent)) {
          if (lines[i].trim()) inner = inner < 0 ? indentOf(lines[i]) : inner;
          body.push(lines[i].slice(Math.max(0, inner)));
          i++;
        }
        map[key] = body.join(folded ? " " : "\n").trim();
      } else if (rest.trim() === "") {
        skip();
        map[key] = i < lines.length && indentOf(lines[i]) > indent ? block(indentOf(lines[i])) : null;
      } else {
        map[key] = scalar(rest);
      }
    }
    return map;
  }
  const out = block(0);
  if (!out || Array.isArray(out) || typeof out !== "object") throw new Error("a config file must be a map at the top level");
  return out;
}

const CONFIG_DIR = path.join(process.cwd(), "config");
const num = (v: Yaml, fallback: number) => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
const strs = (v: Yaml) => (Array.isArray(v) ? v.map(String) : []);
const map = (v: Yaml): { [k: string]: Yaml } => (v && typeof v === "object" && !Array.isArray(v) ? v : {});

function toPersona(y: { [k: string]: Yaml }, file: string): Persona {
  const w = map(y.weights);
  const weights = { fundamental: num(w.fundamental, 0.25), valuation: num(w.valuation, 0.25), technical: num(w.technical, 0.25), qualitative: num(w.qualitative, 0.25) };
  const total = weights.fundamental + weights.valuation + weights.technical + weights.qualitative;
  if (Math.abs(total - 1) > 0.01) throw new Error(`${file}: weights add up to ${total.toFixed(2)}, not 1`);
  if (!y.id || !y.system_prompt) throw new Error(`${file}: id and system_prompt are required`);
  return {
    id: String(y.id),
    name: String(y.name ?? y.id),
    inspiredBy: String(y.inspired_by ?? y.name ?? y.id),
    tagline: String(y.tagline ?? ""),
    systemPrompt: String(y.system_prompt),
    keyMetrics: strs(y.key_metrics),
    weights,
    // Clamped: a config file cannot ask the DCF for 40% growth or a negative margin of safety.
    dcfGrowthCap: Math.min(0.25, Math.max(0, num(y.dcf_growth_cap, 0.08))),
    requiredMarginOfSafety: Math.min(0.6, Math.max(0, num(y.required_margin_of_safety, 0.25))),
    thresholds: Object.fromEntries(Object.entries(map(y.thresholds)).filter(([, v]) => typeof v === "number")) as Record<string, number>,
    researchQuestions: strs(y.research_questions),
  };
}

/** Used only if the config folder is missing from a deployment, so the feature degrades rather than breaks. */
const FALLBACK: Persona = {
  id: "buffett", name: "Buffett-style value", inspiredBy: "Warren Buffett",
  tagline: "Durable returns, little debt, and a price below what the business is worth",
  systemPrompt: "You write an educational analysis inspired by the investing principles of Warren Buffett: durable returns on capital, little debt, honest cash earnings, a moat, and a margin of safety. You are not Warren Buffett and never quote him.",
  keyMetrics: ["roe", "roce", "debtToEquity", "freeCashFlow", "marginOfSafety"],
  weights: { fundamental: 0.4, valuation: 0.35, technical: 0.05, qualitative: 0.2 },
  dcfGrowthCap: 0.08, requiredMarginOfSafety: 0.25,
  thresholds: { roe: 0.15, roce: 0.15, debtToEquity: 0.5 }, researchQuestions: [],
};

let personasCache: Persona[] | null = null;

export function personas(): Persona[] {
  if (personasCache) return personasCache;
  const dir = path.join(CONFIG_DIR, "personas");
  const found: Persona[] = [];
  if (existsSync(dir)) {
    for (const file of readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort()) {
      found.push(toPersona(parseYaml(readFileSync(path.join(dir, file), "utf8")), file));
    }
  }
  personasCache = found.length ? found : [FALLBACK];
  return personasCache;
}

export const persona = (id: string | null | undefined): Persona =>
  personas().find((p) => p.id === id) ?? personas().find((p) => p.id === "buffett") ?? personas()[0];

const DEFAULT_SCORING: Scoring = {
  categories: {
    fundamental: { roe: 0.3, roce: 0.2, netMargin: 0.2, cashConversion: 0.15, assetTurnover: 0.15 },
    growth: { revenueCagr5y: 0.4, epsCagr5y: 0.4, fcfCagr5y: 0.2 },
    valuation: { pe: 0.4, pb: 0.2, fcfYield: 0.2, dividendYield: 0.2 },
    financialHealth: { debtToEquity: 0.35, interestCoverage: 0.3, currentRatio: 0.2, netDebtToEbitda: 0.15 },
  },
  financial: {
    fundamental: { roe: 0.3, roa: 0.3, netInterestMargin: 0.25, costToIncome: 0.15 },
    financialHealth: { creditToDeposit: 0.5, payoutRatio: 0.5 },
  },
  lowerIsBetter: ["pe", "pb", "debtToEquity", "netDebtToEbitda", "costToIncome", "creditToDeposit", "payoutRatio"],
};

let scoringCache: Scoring | null = null;

export function scoring(): Scoring {
  if (scoringCache) return scoringCache;
  const file = path.join(CONFIG_DIR, "scoring.yaml");
  if (!existsSync(file)) return (scoringCache = DEFAULT_SCORING);
  const y = parseYaml(readFileSync(file, "utf8"));
  const weights = (k: string) =>
    Object.fromEntries(Object.entries(map(y[k])).filter(([, v]) => typeof v === "number")) as Record<string, number>;
  scoringCache = {
    categories: {
      fundamental: weights("fundamental"), growth: weights("growth"), valuation: weights("valuation"), financialHealth: weights("financialHealth"),
    },
    financial: {
      fundamental: weights("financial_fundamental"), financialHealth: weights("financial_health"),
    },
    lowerIsBetter: strs(y.lower_is_better),
  };
  return scoringCache;
}

// --- per-agent settings (spec §7.3) ---------------------------------------------------------

export interface AgentSetting { model: string | null; temperature: number | null; timeoutMs: number | null; maxRetries: number | null }
export interface Settings {
  agents: Record<string, AgentSetting>;
  request: { targetSeconds: number; maxLlmCalls: number; maxLoops: number };
  smallModels: Record<string, string>;
  /** Retry a rate-limited strong-model call on the small tier before writing the answer from data alone. */
  fallbackToSmall: boolean;
}

let settingsCache: Settings | null = null;

export function settings(): Settings {
  if (settingsCache) return settingsCache;
  const file = path.join(CONFIG_DIR, "settings.yaml");
  const y = existsSync(file) ? parseYaml(readFileSync(file, "utf8")) : {};
  const agents: Record<string, AgentSetting> = {};
  for (const [name, v] of Object.entries(y)) {
    if (name === "request" || name === "small_models" || name === "fallback_to_small_model") continue;
    const m = map(v);
    agents[name] = {
      model: typeof m.model === "string" ? m.model : null,
      temperature: typeof m.temperature === "number" ? m.temperature : null,
      timeoutMs: typeof m.timeout_ms === "number" ? m.timeout_ms : null,
      maxRetries: typeof m.max_retries === "number" ? m.max_retries : null,
    };
  }
  const r = map(y.request);
  settingsCache = {
    agents,
    // Clamped so a config file cannot lift the spec's hard limits (§3.2: 12 calls, 2 loops).
    request: { targetSeconds: num(r.target_seconds, 60), maxLlmCalls: Math.min(12, num(r.max_llm_calls, 12)), maxLoops: Math.min(2, num(r.max_loops, 2)) },
    smallModels: Object.fromEntries(Object.entries(map(y.small_models)).map(([k, v]) => [k, String(v)])),
    fallbackToSmall: y.fallback_to_small_model !== false,
  };
  return settingsCache;
}

export const agentSetting = (agent: string): AgentSetting =>
  settings().agents[agent] ?? { model: null, temperature: null, timeoutMs: null, maxRetries: null };

// --- field mapping (spec §5.0: config/field_mapping/) ---------------------------------------

export type FieldMap = Record<string, Record<string, string[]> | string[]>;
const mappingCache = new Map<string, FieldMap>();

/** A vendor's line items mapped to the internal schema, e.g. fieldMapping("us_gaap").duration.revenue. */
export function fieldMapping(name: "in_xbrl" | "us_gaap"): FieldMap {
  const hit = mappingCache.get(name);
  if (hit) return hit;
  const file = path.join(CONFIG_DIR, "field_mapping", `${name}.yaml`);
  if (!existsSync(file)) throw new Error(`field mapping ${name}.yaml is missing from config/field_mapping`);
  const y = parseYaml(readFileSync(file, "utf8"));
  const out: FieldMap = {};
  for (const [section, v] of Object.entries(y)) {
    out[section] = Array.isArray(v) ? strs(v) : Object.fromEntries(Object.entries(map(v)).map(([k, list]) => [k, strs(list)]));
  }
  mappingCache.set(name, out);
  return out;
}
