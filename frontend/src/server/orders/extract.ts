// Reading an order win out of the PDF the company filed.
//
// The pipeline is deliberately two-stage. Rules first: currency amounts, durations and the customer are found
// with patterns, so every order has figures even with no model key and no quota left. Then, when a model is
// available, it reads the same text and fills what the rules could not - the customer's full name, the kind of
// order, the scope - and is checked against the rules: a value the document does not contain is dropped.
//
// A PDF that is a scan, or that turns out not to be an order at all, is recorded as such and not fetched again.
import type { Db, Row } from "../db";
import { logger } from "../log";
import { BSEClient } from "../bse/client";
import { NSEClient } from "../nse/client";
import { extract as extractText } from "../docs/extract";
import { config } from "../config";
import { settings } from "../agents/config";
import { chat } from "../research/llm";
import { available as llmAvailable } from "../research/llm";
import { markSeen, save, seenIds, type OrderRow } from "./store";

const log = logger("orders");

export interface Candidate {
  id: string; exchange: "NSE" | "BSE"; symbol: string | null; scripCd: string | null;
  company: string | null; announcedAt: string; headline: string; pdfUrl: string;
}

const NSE_SUBJECT = "Bagging/Receiving of orders/contracts";
const BSE_SUBCATEGORY = "Award of Order / Receipt of Order";

/** Announcements filed under the exchanges' own order categories that have not been read yet. */
export function candidates(db: Db, opts: { days?: number; limit?: number; symbol?: string | null; redo?: boolean } = {}): Candidate[] {
  const days = opts.days ?? 180;
  const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  const limit = opts.limit ?? 40;

  const nse = db.all<Row>(
    `SELECT a.ann_id AS id, a.symbol, a.company, a.ann_dt, a.subject, a.pdf_url
       FROM nse_announcement a
      WHERE a.subject = ? AND a.ann_dt >= ? AND a.pdf_url LIKE 'http%'
      ${opts.symbol ? "AND a.symbol = ?" : ""}
      ORDER BY a.ann_dt DESC LIMIT ?`,
    opts.symbol ? [NSE_SUBJECT, since, opts.symbol, limit * 3] : [NSE_SUBJECT, since, limit * 3]);

  const bse = db.all<Row>(
    `SELECT b.news_id AS id, b.scrip_cd, b.headline, b.news_dt, b.pdf_url, m.symbol, m.company
       FROM announcement b
       LEFT JOIN company_metrics m ON m.bse_code = b.scrip_cd
      WHERE b.subcategory = ? AND b.news_dt >= ? AND b.pdf_url LIKE 'http%'
      ${opts.symbol ? "AND m.symbol = ?" : ""}
      ORDER BY b.news_dt DESC LIMIT ?`,
    opts.symbol ? [BSE_SUBCATEGORY, since, opts.symbol, limit * 3] : [BSE_SUBCATEGORY, since, limit * 3]);

  const all: Candidate[] = [
    ...nse.map((r) => ({
      id: `NSE:${String(r.id)}`, exchange: "NSE" as const, symbol: r.symbol ? String(r.symbol) : null, scripCd: null,
      company: r.company ? String(r.company) : null, announcedAt: String(r.ann_dt), headline: String(r.subject ?? NSE_SUBJECT), pdfUrl: String(r.pdf_url),
    })),
    ...bse.map((r) => ({
      id: `BSE:${String(r.id)}`, exchange: "BSE" as const, symbol: r.symbol ? String(r.symbol) : null, scripCd: r.scrip_cd ? String(r.scrip_cd) : null,
      company: r.company ? String(r.company) : (r.headline ? String(r.headline).split(" - ")[0] : null),
      announcedAt: String(r.news_dt), headline: String(r.headline ?? BSE_SUBCATEGORY), pdfUrl: String(r.pdf_url),
    })),
  ].sort((a, b) => b.announcedAt.localeCompare(a.announcedAt));

  // The same order is filed with both exchanges, so a BSE filing is left out only once the company's order for
  // that day has actually been read - otherwise a day whose NSE filing was never read (it arrived late, or its
  // PDF was a scan) would lose the order from both sides. Two copies that do get read are collapsed when the
  // dashboard asks for them, by company, day and value.
  const read = new Set<string>();
  const since10 = all.map((c) => c.announcedAt.slice(0, 10)).sort()[0] ?? "0000";
  for (const r of db.all<Row>("SELECT symbol, company, substr(announced_at,1,10) d FROM company_order WHERE announced_at >= ?", [since10])) {
    if (r.symbol) read.add(`${String(r.symbol)}|${String(r.d)}`);
    if (r.company) read.add(`${String(r.company)}|${String(r.d)}`);
  }
  const fresh = opts.redo ? new Set<string>() : seenIds(db, all.map((c) => c.id));
  const out: Candidate[] = [];
  for (const c of all) {
    if (fresh.has(c.id)) continue;
    const day = c.announcedAt.slice(0, 10);
    if (c.exchange === "BSE" && (read.has(`${c.symbol}|${day}`) || read.has(`${c.company}|${day}`))) continue;
    out.push(c);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * A BSE filing carries only the scrip code, and a company listed on BSE alone has no NSE symbol at all. Without
 * a symbol there is no revenue to measure the order against, so the company name is matched as well.
 */
const plain = (s: string) => s.toLowerCase().replace(/\b(limited|ltd|private|pvt|company|corporation|corp|india|the)\b/g, "").replace(/[^a-z0-9]+/g, "");

let nameIndex: Map<string, string> | null = null;
export function resolveSymbol(db: Db, company: string | null, symbol: string | null): string | null {
  if (symbol || !company) return symbol;
  if (!nameIndex) {
    nameIndex = new Map();
    for (const r of db.all<Row>("SELECT symbol, company FROM company_metrics WHERE company IS NOT NULL")) {
      const key = plain(String(r.company));
      if (key && !nameIndex.has(key)) nameIndex.set(key, String(r.symbol));
    }
  }
  return nameIndex.get(plain(company)) ?? null;
}

// --- reading the figures with rules ---------------------------------------------------------------

const CRORE_PER: Record<string, number> = { crore: 1, cr: 1, lakh: 0.01, lac: 0.01, lakhs: 0.01, million: 0.1, mn: 0.1, billion: 100, bn: 100, thousand: 0.0001 };

/** One amount, in crore: the unit the filing used, or plain rupees when it wrote the whole number out. */
function toCrore(digits: string, unit?: string): number | null {
  const raw = Number(digits.replace(/,/g, ""));
  if (!Number.isFinite(raw) || raw <= 0) return null;
  const key = (unit ?? "").toLowerCase().replace(/s$/, "").replace(/\./g, "");
  if (key) {
    const factor = CRORE_PER[key];
    return factor ? raw * factor : null;
  }
  // No unit: "Rs. 23,74,01,563" is rupees written out, which is 23.74 crore. Anything under ten lakh is too
  // small to be an order value written this way, so it is left alone rather than guessed at.
  return raw >= 1_000_000 ? raw / 1e7 : null;
}

/** Every rupee amount in the text, in crore, with the phrase it came from. */
export function amountsInCrore(text: string): { value: number; unit: string; phrase: string }[] {
  const out: { value: number; unit: string; phrase: string }[] = [];
  const re = /(?:rs\.?|inr|₹|usd|us\$|\$|eur|€)\s*([\d,]+(?:\.\d+)?)\s*(?:\/-)?\s*(crores?|cr\b|lakhs?|lacs?|millions?|mn\b|billions?|bn\b|thousand)?/gi;
  for (const m of text.matchAll(re)) {
    const raw = Number(m[1].replace(/,/g, ""));
    if (!Number.isFinite(raw) || raw <= 0) continue;
    const unit = (m[2] ?? "").toLowerCase().replace(/s$/, "").replace(/\./g, "");
    const symbol = m[0].toLowerCase();
    const foreign = /usd|us\$|\$|eur|€/.test(symbol);
    // A foreign-currency contract is left to the model to convert; the rules only report rupee amounts.
    if (foreign) continue;
    // With a unit word the filing has said what it means; without one it is rupees written out in full
    // ("Rs. 220,66,33,332/-"), which only counts when it is large enough to be an order value.
    const value = toCrore(m[1], unit);
    if (value === null) continue;
    out.push({ value, unit: unit || "rupees", phrase: m[0].trim() });
  }
  return out;
}

const UNIT_WORD = "(crores?|cr\\b|lakhs?|lacs?|millions?|mn\\b|billions?|bn\\b)";
// The lookbehind keeps a match from starting in the middle of a number: without it "220.66" can be read as "6".
const MONEY = `(?:rs\\.?|inr|₹)?\\s*(?<![\\d.,])([\\d,]+(?:\\.\\d+)?)\\s*(?:\\/-)?\\s*${UNIT_WORD}?`;

/**
 * The order's own value, taken from the sentence that states it. A press release often carries other, larger
 * figures - the order book, the year's wins - so the largest amount in the document is not the order: one
 * filing said "Bags Order Valued at ₹ 483.72 Crore" and also mentioned a ₹4,992 Crore order book.
 */
const VALUE_LABELS = [
  new RegExp(`size of the order[^:\\n]{0,80}[:\\-]\\s*${MONEY}`, "i"),
  new RegExp(`(?:order|contract|loa|work order)s?[^.\\n]{0,60}?(?:valued at|value(?:d)? (?:at|is|of)|worth|amounting to|aggregating to|for a value of)\\s*(?:approx(?:imately)?\\.?\\s*)?${MONEY}`, "i"),
  new RegExp(`(?:total |aggregate )?(?:order|contract) value[^:\\n]{0,40}?[:\\-]?\\s*(?:is\\s*)?${MONEY}`, "i"),
  new RegExp(`value of the (?:order|contract|work)[^:\\n]{0,40}?[:\\-]?\\s*(?:is\\s*)?${MONEY}`, "i"),
];

function valueFromRules(text: string): { value: number | null; phrase: string | null } {
  for (const re of VALUE_LABELS) {
    const m = text.match(re);
    if (!m) continue;
    const value = toCrore(m[1], m[2]);
    if (value !== null) return { value, phrase: m[0].trim().slice(0, 60) };
  }
  // Nothing labelled: fall back to the largest rupee amount in the filing.
  const amounts = amountsInCrore(text);
  if (!amounts.length) return { value: null, phrase: null };
  const best = amounts.reduce((a, b) => (b.value > a.value ? b : a));
  return { value: best.value, phrase: best.phrase };
}

/** "18 months", "two years", "completion period of 24 months" - in months. */
function durationFromRules(text: string): number | null {
  const words: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12 };
  const re = /(?:period|duration|tenure|completion|executed?|execution|delivery|completed)[^.]{0,60}?(\d{1,3}|one|two|three|four|five|six|seven|eight|nine|ten|twelve)[\s-]*(month|year|week|day)s?\b|\b(\d{1,3}|one|two|three|four|five|six|seven|eight|nine|ten|twelve)[\s-]*(month|year)s?\b[^.]{0,30}?(?:from|period|completion|execution)/gi;
  for (const m of text.matchAll(re)) {
    const n = m[1] ?? m[3];
    const unit = (m[2] ?? m[4] ?? "").toLowerCase();
    const count = Number(n) || words[String(n).toLowerCase()] || 0;
    if (!count) continue;
    if (unit === "year") return count * 12;
    if (unit === "month") return count;
    if (unit === "week") return Math.round((count / 4.345) * 10) / 10;
    if (unit === "day") return Math.round((count / 30.44) * 10) / 10;
  }
  return null;
}

/** The customer, as the filing names it: the phrase after "from", "by" or "awarded by". */
/**
 * SEBI's own disclosure format asks for the customer by name: "Name of the entity awarding the order(s)/
 * contract(s): <name>". The label often wraps across two lines in the PDF, so the value is taken from the colon
 * to the end of that line. This is tried first because it is the company's own answer to the question.
 */
const LABELLED = [
  /name of the (?:entity|part(?:y|ies)|client|customer)[^:\n]{0,80}:\s*([^\n]{3,110})/i,
  /(?:entity|part(?:y|ies)) awarding the (?:order|contract)[^:\n]{0,60}:\s*([^\n]{3,110})/i,
  /\b(?:customer|client|awarded by|awarding authority|order from)\s*[:\-]\s*([^\n]{3,110})/i,
];

const PROSE = [
  /(?:received (?:an? )?(?:work |purchase |supply )?order(?:s)? from|order received from|awarded by|awarded to the company by|letter of (?:award|intent|acceptance) from|bagged (?:an? )?(?:order|contract) from|contract from|work order from|from the client|issued by)\s+([A-Z][^.;]{3,110})/i,
  // "has secured an order valued at 5,400 crore from M/s National High Speed Rail Corporation Limited"
  // The gap may cross a full stop that belongs to an abbreviation or a number ("Rs. 5,400 crore from ..."),
  // but not the end of a sentence.
  /\b(?:order|contract|loa|tender)(?:[^.\n]|\.(?=\s*\d)){0,90}?\bfrom\s+((?:M\/s\.?\s*)?[A-Z][^.;]{3,110})/i,
];

/** Tidy a captured name: one sentence, no trailing clause, no trailing punctuation. */
const tidy = (raw: string) => raw
  .replace(/\s+/g, " ")
  // The name ends where its sentence does; "M/s." is part of a name, not the end of one.
  .replace(/(?<=.{6})\.\s+[A-Z][\s\S]*$/, "")
  .replace(/\b(for|towards|to (?:supply|execute|carry)|amounting|valued|worth|dated|vide|having|with a|under|significant terms)\b[\s\S]*$/i, "")
  .replace(/[,;:\-–\s]+$/, "")
  .trim()
  .slice(0, 90);

function customerFromRules(text: string): string | null {
  for (const re of LABELLED) {
    const m = text.match(re);
    const name = m ? tidy(m[1]) : "";
    if (isRealCustomer(name)) return name;
  }
  for (const re of PROSE) {
    const m = text.match(re);
    const name = m ? tidy(m[1]) : "";
    if (isRealCustomer(name)) return name;
  }
  return null;
}

const DOMESTIC = /\b(domestic|india|indian)\b/i;
const EXPORT = /\b(export|overseas|international|abroad)\b/i;

function typeFromRules(text: string): string | null {
  if (/\b(letter of award|loa)\b/i.test(text)) return "Letter of award";
  if (/\bletter of intent|loi\b/i.test(text)) return "Letter of intent";
  if (/\bwork order\b/i.test(text)) return "Work order";
  if (/\bpurchase order\b/i.test(text)) return "Purchase order";
  if (/\bepc\b/i.test(text)) return "EPC contract";
  if (/\bsupply (?:order|contract)\b/i.test(text)) return "Supply order";
  if (EXPORT.test(text) && !DOMESTIC.test(text)) return "Export order";
  if (/\bcontract\b/i.test(text)) return "Contract";
  if (/\border\b/i.test(text)) return "Order";
  return null;
}

/**
 * The SEBI disclosure form asks "whether domestic or international", and its own words are not a customer.
 * A row whose customer reads like the form rather than a party is left empty, which is honest.
 */
// The form's own labels, wherever they appear: a value that opens with one of them, or carries another of the
// form's questions inside it, is the template bleeding through rather than the party that placed the order.
const FORM_START = /^(whether\s+)?(domestic|international|overseas|export|name of|identity of|not applicable|not disclosed|not mentioned|not specified|confidential|n\.?a\.?$)/i;
const FORM_PHRASE = /(nature of order|name of the (entity|party)|whether domestic|size of the order|time period|order value|awarding (entity|authority)\s*:?\s*$)/i;

// A party's name starts with the name, not with a pronoun or an article: "the Company in this regard…" and
// "a Global EPC Company that specialises in…" are sentences the pattern ran into, not customers.
const NOT_A_NAME = /^(the|a|an|its|their|our|this|that|such|one|various|certain|all)\b/i;

export const isRealCustomer = (name: string | null): boolean => {
  const s = (name ?? "").trim();
  return s.length > 3 && /[A-Z]/.test(s) && !FORM_START.test(s) && !FORM_PHRASE.test(s) && !NOT_A_NAME.test(s);
};

/** Filings under this category that are really something else (a court order, a penalty). */
const NOT_AN_ORDER = /\b(court|tribunal|nclt|adjudicat|penalty order|demand order|assessment order|show cause|gst order|income tax)\b/i;

export interface Parsed {
  customer: string | null; orderType: string | null; contractValueCr: number | null; currency: string | null;
  durationMonths: number | null; workScope: string | null; location: string | null; summary: string | null;
  isOrder: boolean; confidence: number; extractedBy: "rules" | "model"; model: string | null; note: string | null;
}

export function parseByRules(text: string): Parsed {
  const value = valueFromRules(text);
  const duration = durationFromRules(text);
  const named = customerFromRules(text);
  const customer = isRealCustomer(named) ? named : null;
  const orderType = typeFromRules(text);
  const isOrder = !(NOT_AN_ORDER.test(text.slice(0, 2500)) && !/\b(work order|purchase order|letter of award|bagged|awarded)\b/i.test(text));
  const missing = [!value.value && "contract value", !duration && "duration", !customer && "customer"].filter(Boolean);
  return {
    customer, orderType, contractValueCr: value.value, currency: value.value === null ? null : "INR",
    durationMonths: duration, workScope: null, location: null, summary: null, isOrder,
    confidence: [value.value, duration, customer, orderType].filter((v) => v !== null).length / 4,
    extractedBy: "rules", model: null,
    note: missing.length ? `not stated in the filing: ${missing.join(", ")}` : null,
  };
}

// --- the model reads the same text ----------------------------------------------------------------

const SYSTEM = [
  "You read one Indian listed company's exchange filing about an order or contract it has received.",
  "Report only what the document states. Never estimate, never infer a value from a percentage, never carry over knowledge about the company.",
  "Return JSON only, with these keys:",
  '{"is_order": true if the company has received/bagged an order or contract, false if the document is about something else (a court or tax order, a clarification);',
  '"customer": the name of the party that placed the order exactly as written, or null;',
  '"order_type": a short phrase such as "Work order", "Letter of award", "EPC contract", "Supply order", "Export order", or null;',
  '"contract_value_cr": the total value of the order in CRORE rupees as a number (convert: 1 lakh = 0.01 crore, 1 million = 0.1 crore, 1 billion = 100 crore), or null if the document does not state a value;',
  '"currency": the currency the document states ("INR", "USD", ...), or null;',
  '"value_as_stated": the amount exactly as the document writes it, e.g. "Rs. 483.70 crore", or null;',
  '"duration_months": the execution or completion period in months as a number, or null;',
  '"work_scope": one short phrase for what the work is, or null;',
  '"location": where the work is, or null;',
  '"summary": one sentence of at most 30 words describing the order, using only the document\'s own facts.}',
  "If a foreign currency is stated and the document also gives the rupee equivalent, use the rupee figure. If it gives no rupee figure, put the foreign amount in contract_value_cr only if the document states a conversion; otherwise null.",
].join(" ");

/**
 * Reading one filing is a small job, so it goes to the provider's small model: it leaves the strong model's
 * daily quota to the analyst agents, and the rules below check whatever comes back. ORDERS_MODEL overrides it.
 */
function orderModel(): string | undefined {
  return process.env.ORDERS_MODEL || settings().smallModels[config.LLM_PROVIDER] || undefined;
}

const shortLabel = (s: string | null) => (s && s.split(/\s+/).length <= 5 ? s : null);

/**
 * Free model tiers meter tokens by the minute, and reading a filing is a long prompt: sent as fast as the PDFs
 * arrive, most calls would come back rate-limited and the filing would fall back to the weaker rule reading.
 * So calls are spaced out. ORDERS_MODEL_RPM sets the pace (default four a minute, about 8k tokens).
 */
let lastCallAt = 0;
let queue: Promise<void> = Promise.resolve();
function pace(): Promise<void> {
  const rpm = Number(process.env.ORDERS_MODEL_RPM ?? 4);
  const gap = rpm > 0 ? 60_000 / rpm : 0;
  queue = queue.then(async () => {
    const wait = lastCallAt + gap - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastCallAt = Date.now();
  });
  return queue;
}

interface Draft {
  is_order?: unknown; customer?: unknown; order_type?: unknown; contract_value_cr?: unknown; currency?: unknown;
  value_as_stated?: unknown; duration_months?: unknown; work_scope?: unknown; location?: unknown; summary?: unknown;
}

const str = (v: unknown, max = 120) => {
  const s = typeof v === "string" ? v.trim() : "";
  return s && !/^(null|n\/?a|none|not (mentioned|stated|specified|disclosed))$/i.test(s) ? s.slice(0, max) : null;
};
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : typeof v === "string" && Number.isFinite(Number(v.replace(/,/g, ""))) && Number(v) > 0 ? Number(v.replace(/,/g, "")) : null);

/** The model's reading, kept only where the document backs it up. */
export async function parseWithModel(text: string, rules: Parsed, opts: { model?: string; chatFn?: typeof chat } = {}): Promise<Parsed> {
  if (!opts.chatFn) await pace();
  const res = await (opts.chatFn ?? chat)({
    system: SYSTEM,
    user: `FILING TEXT\n${text.slice(0, 12_000)}`,
    model: opts.model ?? orderModel(),
    json: true, temperature: 0, maxTokens: 500, timeoutMs: 30_000, maxRetries: 3, maxWaitMs: 30_000,
  });
  if (!res.text) return { ...rules, note: [rules.note, `model unavailable: ${res.error ?? "no reply"}`].filter(Boolean).join("; ") };
  let draft: Draft;
  try {
    draft = JSON.parse(res.text.replace(/^```(?:json)?|```$/g, "").trim()) as Draft;
  } catch {
    return { ...rules, note: [rules.note, "model reply was not JSON"].filter(Boolean).join("; ") };
  }

  const lower = text.toLowerCase();
  const grounded = (s: string | null) => {
    if (!s) return null;
    // Every name the model reports must appear in the document, allowing for line breaks and spacing.
    const words = s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter((w) => w.length > 3);
    if (!words.length) return lower.includes(s.toLowerCase()) ? s : null;
    const hits = words.filter((w) => lower.includes(w)).length;
    return hits / words.length >= 0.6 ? s : null;
  };

  const modelValue = num(draft.contract_value_cr);
  const stated = str(draft.value_as_stated, 60);
  // A value the rules also found, or one whose stated phrase is in the document, is kept; anything else is not.
  const valueOk = modelValue !== null
    && (rules.contractValueCr === null
      || Math.abs(modelValue - rules.contractValueCr) / Math.max(modelValue, rules.contractValueCr) < 0.02
      || (stated !== null && lower.includes(stated.toLowerCase().slice(0, 12))));
  const value = valueOk ? modelValue : rules.contractValueCr;
  const duration = num(draft.duration_months) ?? rules.durationMonths;
  const fromModel = grounded(str(draft.customer, 90));
  const customer = (isRealCustomer(fromModel) ? fromModel : null) ?? rules.customer;
  const isOrder = draft.is_order === false ? false : rules.isOrder;
  const missing = [!value && "contract value", !duration && "duration", !customer && "customer"].filter(Boolean);

  return {
    // The kind of order is a label, not a description: a long phrase is the scope of work, so the rules' label wins.
    customer, orderType: shortLabel(str(draft.order_type, 40)) ?? rules.orderType, contractValueCr: value,
    currency: str(draft.currency, 8) ?? (value === null ? null : "INR"),
    durationMonths: duration, workScope: grounded(str(draft.work_scope, 120)), location: grounded(str(draft.location, 60)),
    summary: str(draft.summary, 300), isOrder,
    confidence: [value, duration, customer, str(draft.order_type)].filter((v) => v !== null).length / 4,
    extractedBy: "model", model: res.model,
    note: missing.length ? `not stated in the filing: ${missing.join(", ")}` : null,
  };
}

// --- one announcement, end to end -----------------------------------------------------------------

let nseClient: NSEClient | null = null;
let bseClient: BSEClient | null = null;
const nse = () => (nseClient ??= new NSEClient({ rps: 1.5, maxRetries: 2, timeoutS: 45 }));
const bse = () => (bseClient ??= new BSEClient({ rps: 1.5, maxRetries: 2, timeoutS: 45 }));

export async function readOne(db: Db, c: Candidate, opts: { useModel?: boolean } = {}): Promise<OrderRow | null> {
  let text = "";
  try {
    const bytes = c.exchange === "NSE" ? await nse().archive(c.pdfUrl) : await bse().getBytes(c.pdfUrl);
    const doc = await extractText(bytes, c.pdfUrl);
    text = doc.pages.join("\n").replace(/ /g, " ").replace(/[ \t]+/g, " ");
    if (doc.imageOnly || text.replace(/\s/g, "").length < 200) {
      markSeen(db, c.id, "unreadable", doc.imageOnly ? "the filing is a scan with no text" : "the filing has almost no text");
      return null;
    }
  } catch (e) {
    markSeen(db, c.id, "failed", (e as Error).message.slice(0, 200));
    log.warn(`could not read ${c.id}: ${(e as Error).message}`);
    return null;
  }

  const rules = parseByRules(text);
  const parsed = opts.useModel !== false && llmAvailable() ? await parseWithModel(text, rules) : rules;
  const row: OrderRow = {
    id: c.id, exchange: c.exchange, symbol: resolveSymbol(db, c.company, c.symbol), scripCd: c.scripCd, company: c.company,
    announcedAt: c.announcedAt, customer: parsed.customer, orderType: parsed.orderType,
    contractValueCr: parsed.contractValueCr, currency: parsed.currency, durationMonths: parsed.durationMonths,
    workScope: parsed.workScope, location: parsed.location, isOrder: parsed.isOrder, confidence: parsed.confidence,
    extractedBy: parsed.extractedBy, model: parsed.model, headline: c.headline, summary: parsed.summary,
    pdfUrl: c.pdfUrl, pdfChars: text.length, note: parsed.note,
  };
  save(db, row);
  markSeen(db, c.id, parsed.isOrder ? "extracted" : "not_an_order", parsed.note);
  return row;
}

export interface RunResult { read: number; orders: number; skipped: number; pending: number; customersFilled?: number }

/**
 * Filings already read whose customer is still empty - usually because the model had no quota left that day, so
 * only the patterns ran. Reading them again fills in the party that placed the order, which is what the
 * dashboard's customer filter is built from. Stops at `limit` so a day's run stays inside its budget.
 */
export async function fillMissingCustomers(db: Db, opts: { limit?: number; days?: number; deadlineMs?: number } = {}): Promise<number> {
  if (!llmAvailable()) return 0;
  const missing = new Set(db.all<Row>("SELECT id FROM company_order WHERE customer IS NULL").map((r) => String(r.id)));
  if (!missing.size) return 0;
  const todo = candidates(db, { days: opts.days ?? 400, limit: 5000, redo: true }).filter((c) => missing.has(c.id)).slice(0, opts.limit ?? 40);
  const deadline = Date.now() + (opts.deadlineMs ?? 20 * 60_000);
  let filled = 0;
  for (const c of todo) {
    if (Date.now() > deadline) break;
    const row = await readOne(db, c);
    if (row?.customer) filled++;
  }
  if (todo.length) log.info(`orders: filled the customer on ${filled} of ${todo.length} filings that had none`);
  return filled;
}

/** Read the announcements waiting to be read, a few at a time, within a time budget. */
export async function runOrders(db: Db, opts: { days?: number; limit?: number; concurrency?: number; deadlineMs?: number; useModel?: boolean; symbol?: string | null; redo?: boolean } = {}): Promise<RunResult> {
  const pending = candidates(db, { days: opts.days, limit: opts.limit ?? 25, symbol: opts.symbol, redo: opts.redo });
  const deadline = Date.now() + (opts.deadlineMs ?? 300_000);
  const concurrency = Math.max(1, opts.concurrency ?? 3);
  let read = 0, orders = 0, skipped = 0, next = 0;

  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= pending.length || Date.now() > deadline) return;
      const row = await readOne(db, pending[i], { useModel: opts.useModel });
      read++;
      if (row?.isOrder) orders++;
      else skipped++;
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, pending.length) }, worker));
  log.info(`orders: read ${read} filings, ${orders} order wins, ${skipped} skipped`);
  return { read, orders, skipped, pending: Math.max(0, pending.length - read) };
}
