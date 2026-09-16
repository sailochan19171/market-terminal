// "Undervalued IT stocks with ROE over 20%" - turned into a screen, shown to the reader, then run.
//
// The rule that matters: no free-form SQL ever reaches the database. A question becomes a list of
// {field, operator, value} triples drawn from the screener's own allow-listed columns, and those triples are
// shown on screen before the results, so a reader can see what was asked on their behalf and change it.
//
// The words are read first; a model is only asked when the words leave nothing usable, and its reply is put
// through the same allow-list as everything else.
import type { Db } from "../db";
import { SCREEN_COLUMNS, runScreen } from "../api/v2";
import * as llm from "./llm";

export type Op = "gt" | "gte" | "lt" | "lte" | "eq";
export interface Filter { field: string; op: Op; value: number; label: string }
export interface Screen {
  question: string;
  understood: boolean;
  filters: Filter[];
  sector: string | null;
  index: string | null;
  sort: string;
  order: "asc" | "desc";
  readBy: "words" | "model";
  note: string | null;
}

// The phrasing readers actually use, against the columns the screener already exposes. Each entry says which
// direction "more" means, so "high ROE" and "low P/E" both land the right way round.
const TERMS: { re: RegExp; field: string; better: "high" | "low" }[] = [
  { re: /\b(p\s?\/?\s?e|price[- ]to[- ]earnings|earnings multiple)\b/i, field: "pe", better: "low" },
  { re: /\b(p\s?\/?\s?b|price[- ]to[- ]book|book value multiple)\b/i, field: "pb", better: "low" },
  { re: /\broe\b|return on equity/i, field: "roe", better: "high" },
  { re: /\bdividend\b|\byield\b/i, field: "div_yield", better: "high" },
  { re: /\bmarket ?cap\b|\blarge ?cap\b|\bsmall ?cap\b/i, field: "market_cap_cr", better: "high" },
  { re: /\bdebt\b|\bleverage\b|\bborrowing/i, field: "debt_to_equity", better: "low" },
  { re: /\b(sales|revenue) growth\b/i, field: "sales_growth_3y", better: "high" },
  { re: /\bprofit growth\b/i, field: "profit_growth_3y", better: "high" },
  { re: /\boperating margin\b|\bopm\b/i, field: "opm_ttm", better: "high" },
  { re: /\bnet margin\b|\bnpm\b/i, field: "net_margin_ttm", better: "high" },
  { re: /\bgross margin\b|\bgpm\b/i, field: "gpm_ttm", better: "high" },
  { re: /\bpromoter\b/i, field: "promoter", better: "high" },
  { re: /\b(one|1)[- ]year return\b|\breturn over a year\b|\byearly return\b/i, field: "ret_1y", better: "high" },
  { re: /\bturnover\b|\bliquidity\b|\btraded value\b/i, field: "turnover", better: "high" },
  { re: /\b52[- ]?week high\b/i, field: "from_high", better: "high" },
  { re: /\b52[- ]?week low\b/i, field: "from_low", better: "low" },
];

const WORD_NUMBERS: Record<string, number> = { crore: 1, cr: 1, lakh: 0.01, thousand: 0.00001 };

// String.raw, because these are regular-expression source: a plain "\d" inside a string literal is only "d".
const MORE = String.raw`above|over|more than|greater than|at least|higher than|min(?:imum)?|>=|>`;
const LESS = String.raw`below|under|less than|lower than|at most|max(?:imum)?|cheaper than|<=|<`;
const AMOUNT = String.raw`(-?\d+(?:\.\d+)?)\s*(%|per ?cent|crore|cr\b|lakh|thousand)?`;

const HIGH_WORDS = /\b(high|strong|good|best|top|healthy)\b/;
const LOW_WORDS = /\b(low|cheap|small|least|no|free|zero|minimal)\b/;

/** "under 15", "> 20%", "over 1000 crore" - the comparison sitting beside a measure, in that column's units. */
function comparison(clause: string): { op: Op; value: number } | null {
  const more = clause.match(new RegExp(String.raw`(?:${MORE})\s*${AMOUNT}`, "i"));
  const less = clause.match(new RegExp(String.raw`(?:${LESS})\s*${AMOUNT}`, "i"));
  const pick = (m: RegExpMatchArray, op: Op) => {
    const n = Number(m[1]);
    if (!Number.isFinite(n)) return null;
    const unit = (m[2] ?? "").toLowerCase().replace(/[\s.]/g, "");
    return { op, value: unit in WORD_NUMBERS ? n * WORD_NUMBERS[unit] : n };
  };
  // Whichever comparison comes first in the clause is the one that belongs to its measure.
  if (more && less) return (more.index ?? 0) < (less.index ?? 0) ? pick(more, "gt") : pick(less, "lt");
  if (more) return pick(more, "gt");
  if (less) return pick(less, "lt");
  return null;
}

const SIGN: Record<Op, string> = { gt: ">", gte: "≥", lt: "<", lte: "≤", eq: "=" };

/**
 * What the words alone say. Good enough for most questions and costs nothing.
 *
 * The question is split into clauses first - "banks with P/E under 15 and yield above 2%" is three separate
 * statements - because a comparison belongs to the measure beside it, not to any measure in the sentence.
 */
export function fromWords(db: Db, question: string): Screen {
  const q = question.toLowerCase();
  const filters: Filter[] = [];
  const add = (field: string, op: Op, value: number) => {
    if (!(field in SCREEN_COLUMNS) || !Number.isFinite(value)) return;
    if (filters.some((f) => f.field === field && f.op === op)) return;
    filters.push({ field, op, value, label: `${SCREEN_COLUMNS[field]} ${SIGN[op]} ${value}` });
  };

  // Whole ideas first, so "debt free" settles the debt filter before a loose "free" reads as merely low.
  if (/\bdebt[- ]free\b|\bno debt\b|\bzero debt\b/.test(q)) add("debt_to_equity", "lt", 0.1);
  if (/\bprofitable\b|\bmaking (a )?profit\b/.test(q)) add("np_ttm_cr", "gt", 0);

  for (const clause of q.split(/\band\b|\bwith\b|\bwhich have\b|\bhaving\b|[,;]/)) {
    const term = TERMS.find((t) => t.re.test(clause));
    if (!term) continue;
    const cmp = comparison(clause);
    if (cmp) {
      add(term.field, cmp.op, cmp.value);
      continue;
    }
    // No number given: read the adjective, with a defensible default for that measure.
    if (HIGH_WORDS.test(clause) && term.better === "high") {
      add(term.field, "gt", term.field === "roe" ? 15 : term.field === "div_yield" ? 3 : term.field === "promoter" ? 50 : 0);
    } else if (LOW_WORDS.test(clause) && term.better === "low") {
      add(term.field, "lt", term.field === "pe" ? 15 : term.field === "pb" ? 3 : term.field === "debt_to_equity" ? 0.5 : 0);
    }
  }

  // "Undervalued" and "expensive" bind only when no clause already set a P/E of its own.
  if (/\bundervalued\b|\bcheap\b/.test(q) && !filters.some((f) => f.field === "pe")) {
    add("pe", "gt", 0);
    add("pe", "lt", 20);
  }
  if (/\bovervalued\b|\bexpensive\b/.test(q)) add("pe", "gt", 40);

  const sector = matchSector(db, q);
  const index = /\bnifty ?50\b/.test(q) ? "nifty50" : /\bnifty ?100\b/.test(q) ? "nifty100" : /\bnifty ?500\b/.test(q) ? "nifty500" : null;

  const sorted = filters.find((f) => f.field !== "np_ttm_cr");
  const sort = sorted?.field ?? "market_cap_cr";
  const order: "asc" | "desc" = sort === "pe" || sort === "pb" || sort === "debt_to_equity" ? "asc" : "desc";
  return {
    question, understood: filters.length > 0,
    filters, sector, index, sort, order, readBy: "words", note: null,
  };
}

// The industries as the exchanges actually name them on file, not as one might guess: there is no "Banks"
// industry here, and pharmaceutical companies sit under Healthcare.
const SECTOR_WORDS: Record<string, RegExp> = {
  "Information Technology": /\b(it|tech|technology|software|information technology)\b/,
  "Financial Services": /\bbank(s|ing)?\b|\bnbfc\b|\bfinancial\b|\binsur\w*/,
  Healthcare: /\bpharma\w*|\bdrug\w*|\bbiotech\w*|\bhealthcare\b|\bhospital\w*/,
  "Automobile and Auto Components": /\bauto\w*|\bcar makers?\b|\btyres?\b/,
  "Metals & Mining": /\bmetals?\b|\bsteel\b|\bmining\b/,
  "Fast Moving Consumer Goods": /\bfmcg\b|\bconsumer goods\b/,
  "Oil Gas & Consumable Fuels": /\boil\b|\bgas\b|\brefin\w*/,
  Realty: /\brealty\b|\breal estate\b|\bproperty\b/,
  "Construction Materials": /\bcement\b/,
  Power: /\bpower\b|\belectricity\b|\butilit\w*/,
  "Capital Goods": /\bcapital goods\b|\bengineering\b|\bmachinery\b/,
  Chemicals: /\bchemicals?\b/,
  Telecommunication: /\btelecom\w*/,
  Textiles: /\btextiles?\b|\bapparel\b|\bgarments?\b/,
  "Consumer Durables": /\bconsumer durables?\b|\bappliances?\b/,
};

/** A sector named in the question, matched against the industries actually on file. */
function matchSector(db: Db, q: string): string | null {
  const industries = db.all<{ industry: string }>("SELECT DISTINCT industry FROM company_metrics WHERE industry IS NOT NULL")
    .map((i) => i.industry);
  const words = q.toLowerCase();
  const named = industries.find((i) => words.includes(i.toLowerCase()));
  if (named) return named;
  for (const [industry, re] of Object.entries(SECTOR_WORDS)) {
    if (re.test(words) && industries.includes(industry)) return industry;
  }
  return null;
}

const SYSTEM = [
  "You turn a question about Indian listed companies into a stock screen.",
  'Reply with JSON only, no prose: {"filters":[{"field":"pe","op":"lt","value":15}],"sector":null,"sort":"pe","order":"asc"}.',
  `Allowed fields: ${Object.keys(SCREEN_COLUMNS).join(", ")}.`,
  "Allowed operators: gt, gte, lt, lte, eq. Values are plain numbers; a percentage is the number itself (20, not 0.2); money is in crore.",
  'Use sector only when the question names an industry. Never invent a field. If the question is not a screen, reply {"filters":[]}.',
].join(" ");

/** When the words leave nothing usable, ask the model - and put its answer through the same allow-list. */
export async function fromModel(db: Db, question: string): Promise<Screen | null> {
  if (!llm.available()) return null;
  const said = await llm.complete(question, SYSTEM);
  if (!said.text) return null;
  const json = said.text.match(/\{[\s\S]*\}/);
  if (!json) return null;
  try {
    const parsed = JSON.parse(json[0]) as { filters?: { field?: string; op?: string; value?: unknown }[]; sector?: string | null; sort?: string; order?: string };
    const filters: Filter[] = [];
    for (const f of parsed.filters ?? []) {
      const field = String(f.field ?? "");
      const op = String(f.op ?? "") as Op;
      const value = Number(f.value);
      if (!(field in SCREEN_COLUMNS) || !(op in SIGN) || !Number.isFinite(value)) continue;
      if (filters.some((x) => x.field === field && x.op === op)) continue;
      filters.push({ field, op, value, label: `${SCREEN_COLUMNS[field]} ${SIGN[op]} ${value}` });
    }
    if (!filters.length) return null;
    const sort = parsed.sort && parsed.sort in SCREEN_COLUMNS ? parsed.sort : filters[0].field;
    return {
      question, understood: true, filters,
      sector: parsed.sector ? matchSector(db, String(parsed.sector)) : matchSector(db, question),
      index: null, sort, order: parsed.order === "asc" ? "asc" : "desc", readBy: "model", note: null,
    };
  } catch {
    return null;
  }
}

export interface ScreenResult { screen: Screen; total: number; items: unknown[]; columns: Record<string, string> }

const NOTHING_READ = 'No filter could be read from that. Name a measure and a level - "P/E under 15", "ROE above 20%", '
  + '"dividend yield over 3%" - and a sector if you want one.';

/** Read the question, show what was understood, and run it. */
export async function screen(db: Db, question: string, pageSize = 15): Promise<ScreenResult> {
  let plan = fromWords(db, question);
  // A sector on its own is a screen worth running; nothing at all is worth asking the model about.
  if (!plan.understood && !plan.sector) plan = (await fromModel(db, question)) ?? plan;
  if (!plan.understood && !plan.sector) {
    return { screen: { ...plan, note: NOTHING_READ }, total: 0, items: [], columns: SCREEN_COLUMNS };
  }
  const run = runScreen(db, {
    filters: plan.filters.map((f) => ({ field: f.field, op: f.op, value: f.value })),
    sector: plan.sector, index: plan.index, sort: plan.sort, order: plan.order, page: 1, pageSize,
  }) as unknown as { total: number; results: unknown[] };
  return { screen: plan, total: Number(run.total ?? 0), items: run.results ?? [], columns: SCREEN_COLUMNS };
}
