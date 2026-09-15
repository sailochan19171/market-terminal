// Financial fundamentals, parsed from the XBRL behind each NSE result filing.
//
// `nse_financial_result` only carries metadata - company, period and a link to an XBRL document. The
// numbers (revenue, profit, EPS) live in that document, so this module fetches and parses it.
//
// NSE's Ind-AS XBRL uses ordered context ids rather than distinguishable dates: `OneD` is the reporting
// quarter, `FourD` the year-to-date figure, and both carry the same date range. We therefore key on the
// context id and take the filing's own fromDate/toDate as the authoritative period.
//
// Amounts are reported in rupees and stored as-is (divide by 1e7 for crore).
import { SaxesParser } from "saxes";
import { config } from "../config";
import { now, type Db, type Row } from "../db";
import { NotFound } from "../http";
import { logger } from "../log";
import { mapPool, sleep } from "../util";
import type { NSEClient } from "./client";
import { PARSER_VERSION } from "./companySync";
import { pyStrip } from "./py";

export { PARSER_VERSION };

const log = logger("nse.fundamentals");

// --- XBRL reading (shared with shareholding and statements) ---------------------------------

/** The document is not well-formed XML (Python: xml.etree.ElementTree.ParseError). */
export class XbrlParseError extends Error {}

export interface XmlElement {
  /** Local name (namespace dropped, like `tag.split("}")[-1]`). */
  name: string;
  /** Unprefixed attributes only: ElementTree keys prefixed ones as `{uri}name`, which never match. */
  attrs: Map<string, string>;
  /** Text before the first child, null when there is none (ElementTree's `el.text`). */
  text: string | null;
  /** Index of the parent element in the list, -1 for the root. */
  parent: number;
}

const latin1 = (b: Uint8Array) => {
  let s = "";
  for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode(...b.subarray(i, i + 8192));
  return s;
};

/** Bytes to text the way expat picks the encoding: BOM, then the XML declaration, else UTF-8. */
function decodeXml(b: Uint8Array): string {
  const strict = (label: string) => {
    try {
      return new TextDecoder(label, { fatal: true }).decode(b);
    } catch (e) {
      throw new XbrlParseError(`malformed XBRL: ${(e as Error).message}`);
    }
  };
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return strict("utf-8");
  if ((b[0] === 0xfe && b[1] === 0xff) || (b[0] === 0x00 && b[1] === 0x3c)) return strict("utf-16be");
  if ((b[0] === 0xff && b[1] === 0xfe) || (b[0] === 0x3c && b[1] === 0x00)) return strict("utf-16le");
  const head = latin1(b.subarray(0, 200));
  const m = /^<\?xml[^>]*?encoding\s*=\s*["']([^"']+)["']/.exec(head);
  const enc = (m?.[1] ?? "utf-8").toLowerCase();
  // WHATWG maps latin1/ascii labels to windows-1252; expat decodes them byte-for-byte.
  if (["iso-8859-1", "iso8859-1", "latin-1", "latin1", "us-ascii", "ascii"].includes(enc)) return latin1(b);
  return strict(enc);
}

/** Every element in document order (ElementTree's `root.iter()`), with local names and leading text. */
export function readXml(xml: string | Uint8Array): XmlElement[] {
  const text = typeof xml === "string" ? xml : decodeXml(xml);
  const out: XmlElement[] = [];
  // Stack entries: [element index, has a child started yet]
  const stack: [number, boolean][] = [];
  const parser = new SaxesParser({ xmlns: true, position: false });
  const onText = (t: string) => {
    const top = stack[stack.length - 1];
    // Text after a child is that child's tail, not the parent's text. Comments do not end the run.
    if (top && !top[1]) {
      const el = out[top[0]];
      el.text = (el.text ?? "") + t;
    }
  };
  parser.on("opentag", (tag) => {
    const attrs = new Map<string, string>();
    for (const a of Object.values(tag.attributes)) if (!a.prefix) attrs.set(a.local, a.value);
    const parent = stack.length ? stack[stack.length - 1] : null;
    if (parent) parent[1] = true;
    out.push({ name: tag.local, attrs, text: null, parent: parent ? parent[0] : -1 });
    stack.push([out.length - 1, false]);
  });
  parser.on("closetag", () => {
    stack.pop();
  });
  parser.on("doctype", (dt) => {
    // expat expands entities declared in the internal subset; saxes only knows the predefined ones.
    // Plain-text values cover real documents; values carrying markup or references stay undefined (an error).
    for (const m of dt.matchAll(/<!ENTITY\s+([^\s%"'<>]+)\s+(?:"([^"<&]*)"|'([^'<&]*)')\s*>/g)) {
      if (!(m[1] in parser.ENTITIES)) parser.ENTITIES[m[1]] = m[2] ?? m[3]; // the first declaration wins
    }
  });
  parser.on("text", onText);
  parser.on("cdata", onText);
  try {
    parser.write(text).close();
  } catch (e) {
    throw new XbrlParseError(`malformed XBRL: ${(e as Error).message}`);
  }
  if (!out.length) throw new XbrlParseError("malformed XBRL: no element found");
  return out;
}

/** `re.compile(r"-?\d+(?:\.\d+)?$").match(text)` on already stripped text (Python's \d is any Unicode decimal digit). */
export const NUM = /^-?\p{Nd}+(?:\.\p{Nd}+)?$/u;
const ND = /^\p{Nd}$/u;

/** Python float() of text that matched NUM. Decimal digits are encoded in runs of ten, 0 to 9, so a
 *  digit's value is its offset from the start of its run. */
export function xbrlNumber(text: string): number {
  if (/^[-.0-9]*$/.test(text)) return Number(text);
  let ascii = "";
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp < 0x80) {
      ascii += ch;
      continue;
    }
    let start = cp;
    while (ND.test(String.fromCodePoint(start - 1))) start--;
    ascii += String((cp - start) % 10);
  }
  return Number(ascii);
}

/** `(el.text or "").strip()` */
export const elText = (el: XmlElement) => pyStrip(el.text ?? "");

// --- extraction -------------------------------------------------------------------------------

// Our column -> XBRL tags, in priority order. Companies file in the Ind-AS corporate format; banks file in
// a separate banking format with different names for the same lines (interest earned is a bank's revenue,
// interest expended its finance cost). The first tag present wins.
export const COLUMN_TAGS: [string, string[]][] = [
  ["revenue", ["RevenueFromOperations", "InterestEarned"]],
  ["other_income", ["OtherIncome"]],
  ["total_income", ["Income"]],
  ["total_expenses", ["Expenses"]],
  ["finance_costs", ["FinanceCosts", "InterestExpended"]],
  ["depreciation", ["DepreciationDepletionAndAmortisationExpense"]],
  ["employee_cost", ["EmployeeBenefitExpense", "EmployeesCost"]],
  ["exceptional", ["ExceptionalItemsBeforeTax", "ExceptionalItems"]],
  ["pbt", ["ProfitBeforeTax", "ProfitLossFromOrdinaryActivitiesBeforeTax"]],
  ["tax", ["TaxExpense"]],
  ["pat", ["ProfitLossForPeriod", "ProfitLossForThePeriod"]],
  ["pat_continuing", ["ProfitLossForPeriodFromContinuingOperations", "ProfitLossFromOrdinaryActivitiesAfterTax"]],
  ["pat_owners", ["ProfitOrLossAttributableToOwnersOfParent", "ProfitLossAfterTaxesMinorityInterestAndShareOfProfitLossOfAssociates"]],
  ["eps_basic", ["BasicEarningsLossPerShareFromContinuingAndDiscontinuedOperations", "BasicEarningsPerShare", "BasicEarningsPerShareAfterExtraordinaryItems"]],
  ["eps_diluted", ["DilutedEarningsLossPerShareFromContinuingAndDiscontinuedOperations", "DilutedEarningsPerShare", "DilutedEarningsPerShareAfterExtraordinaryItems"]],
  ["equity_capital", ["PaidUpValueOfEquityShareCapital"]],
  ["face_value", ["FaceValueOfEquityShareCapital"]],
  // Cost of goods, for gross profit. Service businesses report these as zero.
  ["_materials", ["CostOfMaterialsConsumed"]],
  ["_purchases", ["PurchasesOfStockInTrade"]],
  ["_inventory_change", ["ChangesInInventoriesOfFinishedGoodsWorkInProgressAndStockInTrade"]],
  // Balance sheet (instant contexts), carried by half-yearly and annual filings.
  ["equity", ["EquityAttributableToOwnersOfParent", "Equity"]],
  ["total_assets", ["Assets"]],
  ["borrowings", ["Borrowings"]],
  ["_borrowings_current", ["BorrowingsCurrent"]],
  ["_borrowings_noncurrent", ["BorrowingsNoncurrent"]],
  // Banking format only: total expenses are reported in two parts, and shareholders' funds as capital plus reserves.
  ["_bank_expenditure", ["ExpenditureExcludingProvisionsAndContingencies"]],
  ["_bank_provisions", ["ProvisionsOtherThanTaxAndContingencies"]],
  ["_bank_capital", ["Capital"]],
  ["_bank_reserves", ["ReservesAndSurplus"]],
];

/** Columns stored per filing (besides keys and bookkeeping). */
export const VALUE_COLUMNS = [
  "revenue", "other_income", "total_income", "total_expenses", "pbt", "pat",
  "eps_basic", "eps_diluted", "equity_capital", "finance_costs", "depreciation",
  "employee_cost", "exceptional", "tax", "pat_owners",
  "face_value", "shares", "cogs", "gross_profit", "equity", "borrowings", "total_assets",
  "report_format",
] as const;

const TAGS = new Set(COLUMN_TAGS.flatMap(([, tags]) => tags));

/** Context id for the reporting quarter (vs FourD = cumulative YTD). */
export const QUARTER_CTX = "OneD";

export const RECENT_FILINGS = 12; // about six quarters of consolidated + standalone filings

export type Figures = Record<string, number | string | boolean | null>;

/** Extract the reporting-quarter figures from one XBRL document. Throws XbrlParseError on malformed XML. */
export function parseXbrl(xml: string | Uint8Array): Figures {
  // tag -> context id -> value (Map keeps first-seen context order, which the fallback below relies on)
  const facts = new Map<string, Map<string, number>>();
  for (const el of readXml(xml)) {
    if (!TAGS.has(el.name)) continue;
    const ctx = el.attrs.get("contextRef");
    const text = elText(el);
    if (!ctx || !NUM.test(text)) continue;
    let byCtx = facts.get(el.name);
    if (!byCtx) facts.set(el.name, (byCtx = new Map()));
    byCtx.set(ctx, xbrlNumber(text));
  }

  const quarterValue = (byCtx: Map<string, number>): number => {
    if (byCtx.has(QUARTER_CTX)) return byCtx.get(QUARTER_CTX)!;
    // Fall back to the first context that is not the YTD one.
    for (const [k, v] of byCtx) if (!k.startsWith("Four")) return v;
    return byCtx.values().next().value!;
  };

  const out: Figures = {};
  for (const [col, tags] of COLUMN_TAGS) {
    const tag = tags.find((t) => facts.has(t));
    if (tag) out[col] = quarterValue(facts.get(tag)!);
  }
  const has = (k: string) => Object.prototype.hasOwnProperty.call(out, k);
  const num = (k: string) => (has(k) ? (out[k] as number | null) : null);
  const pop = (k: string) => {
    const v = num(k);
    delete out[k];
    return v;
  };

  const bankExp = pop("_bank_expenditure");
  const bankProv = pop("_bank_provisions");
  const bankCapital = pop("_bank_capital");
  const bankReserves = pop("_bank_reserves");
  out._format = bankExp !== null ? "bank" : "corporate";
  // `x or 0.0` rather than `??`: a filed -0 is falsy in Python too.
  if (num("total_expenses") === null && bankExp !== null) out.total_expenses = bankExp + (bankProv || 0);

  if (out._format === "bank") {
    // Equity-style tags mean something else outside the banking taxonomy.
    out.equity = bankCapital !== null && bankReserves !== null ? bankCapital + bankReserves : null;
  }
  const bCur = pop("_borrowings_current");
  const bNon = pop("_borrowings_noncurrent");
  if (num("borrowings") === null && (bCur !== null || bNon !== null)) out.borrowings = (bCur || 0) + (bNon || 0);

  // Gross profit only where the filer reports a cost of goods. All-zero lines mean a services business,
  // where gross profit is not a reported figure.
  const parts = ["_materials", "_purchases", "_inventory_change"].map(pop);
  if (out._format === "corporate" && (parts[0] || parts[1]) && num("revenue") !== null) {
    out.cogs = parts.reduce<number>((s, v) => s + (v || 0), 0);
    out.gross_profit = (out.revenue as number) - out.cogs;
  }

  out.report_format = out._format;
  const fv = num("face_value");
  if (num("equity_capital") && fv && fv > 0) out.shares = (out.equity_capital as number) / fv;

  // Remember which totals the filer actually reported. A total we derive from PBT reconciles with PBT by
  // construction, so the quality check must only trust reported figures (the bank sum above is two reported lines).
  out._reported_totals = has("total_income") && has("total_expenses");

  // Derive what the filing omits, for display only.
  if (num("total_income") === null && num("revenue") !== null) out.total_income = (out.revenue as number) + (num("other_income") || 0);
  if (num("pat") === null && num("pat_continuing") !== null) out.pat = out.pat_continuing;
  if (num("total_expenses") === null && num("total_income") !== null && num("pbt") !== null) {
    out.total_expenses = (out.total_income as number) - (out.pbt as number);
  }
  return out;
}

/**
 * Judge whether a parsed filing can be trusted. Two independent checks, because either alone lets bad data
 * through: the filing must reconcile with itself (income - expenses + exceptional == PBT), and the implied
 * net margin must be sane (-100%..100%) - revenue tagging varies a lot between filers and yields absurd
 * margins while still reconciling. 'suspect' rows are kept but excluded from screening.
 */
export function quality(f: Figures): { quality: "ok" | "suspect"; net_margin: number | null } {
  const n = (k: string) => (f[k] === undefined ? null : (f[k] as number | null));
  const ti = n("total_income"), te = n("total_expenses"), pbt = n("pbt");
  const exceptional = n("exceptional") || 0;
  const reconciles = Boolean(f._reported_totals)
    && ti !== null && te !== null && pbt !== null
    && Math.abs(ti - te + exceptional - pbt) <= Math.max(1e5, Math.abs(pbt) * 0.02);

  const rev = n("revenue"), pat = n("pat");
  const margin = rev && pat !== null && rev > 0 ? (pat / rev) * 100 : null;
  const plausible = margin !== null && margin >= -100 && margin <= 100;
  return { quality: reconciles && plausible ? "ok" : "suspect", net_margin: margin };
}

// --- queue --------------------------------------------------------------------------------------

/**
 * Result filings with an XBRL link that still need parsing.
 *
 * ~130k filings go back to 2014 and each needs its own fetch, so ordering decides how soon pages fill in.
 * Breadth first: the latest RECENT_FILINGS filings of every company come before anyone's deep history.
 * Within that, never-parsed filings beat re-parses for a newer parser version, then index members and
 * larger companies go first. Filings that could not be parsed ('nodata' / 'unparsed') are not retried on a
 * parser upgrade; only rows that had figures are re-read.
 */
export function pending(db: Db, opts: { limit?: number | null; symbol?: string; priorityOnly?: boolean } = {}): Row[] {
  const hasMetrics = Boolean(db.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='company_metrics'"));
  const where = ["r.xbrl_url IS NOT NULL", "r.xbrl_url != ''"];
  const args: (string | number)[] = [PARSER_VERSION];
  if (opts.symbol) {
    where.push("r.symbol = ?");
    args.push(opts.symbol);
  }
  if (opts.priorityOnly) where.push("r.symbol IN (SELECT symbol FROM nse_index_constituent)");
  // Joins rather than per-row subqueries: this runs over every filing.
  let sql = "WITH ranked AS ("
    + "  SELECT r.symbol, r.period_end, r.consolidated, r.xbrl_url, r.company,"
    + "         f.symbol IS NOT NULL AS reparse,"
    + "         (f.symbol IS NULL OR (COALESCE(f.parser_version, 1) < ? "
    + "              AND f.quality IN ('ok', 'suspect'))) AS todo,"
    + "         ROW_NUMBER() OVER (PARTITION BY r.symbol ORDER BY r.period_end DESC, r.consolidated) AS rn"
    + "  FROM nse_financial_result r"
    + "  LEFT JOIN nse_fundamental f ON f.symbol = r.symbol AND f.period_end = r.period_end"
    + "        AND f.consolidated = r.consolidated"
    + "  WHERE " + where.join(" AND ")
    + "), idx AS (SELECT DISTINCT symbol FROM nse_index_constituent) "
    + "SELECT t.symbol, t.period_end, t.consolidated, t.xbrl_url, t.company, t.rn, "
    + "       idx.symbol IS NOT NULL AS in_index "
    + "FROM ranked t LEFT JOIN idx ON idx.symbol = t.symbol "
    + (hasMetrics ? "LEFT JOIN company_metrics m ON m.symbol = t.symbol " : "")
    + "WHERE t.todo "
    + "ORDER BY (t.rn > ?) ASC, t.reparse ASC, in_index DESC, "
    + (hasMetrics ? "COALESCE(m.market_cap_cr, 0) DESC, " : "")
    + "t.symbol ASC, t.period_end DESC";
  args.push(RECENT_FILINGS);
  if (opts.limit) sql += ` LIMIT ${Math.trunc(opts.limit)}`;
  return db.all(sql, args);
}

/** How many filings still need parsing (cheap: no ordering). */
export function pendingCount(db: Db, opts: { priorityOnly?: boolean } = {}): number {
  const extra = opts.priorityOnly ? "AND r.symbol IN (SELECT symbol FROM nse_index_constituent) " : "";
  return db.scalar<number>(
    "SELECT COUNT(*) FROM nse_financial_result r "
    + "LEFT JOIN nse_fundamental f ON f.symbol = r.symbol AND f.period_end = r.period_end "
    + "     AND f.consolidated = r.consolidated "
    + "WHERE r.xbrl_url IS NOT NULL AND r.xbrl_url != '' " + extra
    + "AND (f.symbol IS NULL OR (COALESCE(f.parser_version, 1) < ? AND f.quality IN ('ok', 'suspect')))",
    [PARSER_VERSION]) || 0;
}

// --- sync -----------------------------------------------------------------------------------------

type Outcome = "ok" | "nodata" | "unparsed" | "retry";

/** Downloads keep failing on the network: the batch was cut short (rows already parsed are saved). */
export class NetworkStall extends Error {}

/** Download and parse one filing. */
async function fetchParse(client: NSEClient, row: Row): Promise<[Figures | null, Outcome]> {
  try {
    return [parseXbrl(await client.archive(row.xbrl_url)), "ok"];
  } catch (e) {
    if (e instanceof NotFound) return [null, "nodata"];
    if (e instanceof XbrlParseError) { // malformed XBRL: retrying will not help
      log.debug(`fundamentals ${row.symbol} ${row.period_end}: ${e.message}`);
      return [null, "unparsed"];
    }
    // Network trouble: leave it pending for a later batch.
    log.warn(`fundamentals ${row.symbol} ${row.period_end}: ${(e as Error).message}`);
    return [null, "retry"];
  }
}

/** The nse_fundamental row for one filing. Every row has identical keys: upsert takes columns from the first. */
export function record(row: Row, figures: Figures | null, outcome: string): Row {
  const base = {
    symbol: row.symbol, period_end: row.period_end, consolidated: row.consolidated, company: row.company,
    parser_version: PARSER_VERSION, xbrl_url: row.xbrl_url, fetched_at: now(),
  };
  const values: Row = {};
  for (const c of VALUE_COLUMNS) values[c] = figures?.[c] ?? null;
  if (figures) return { ...base, ...values, ...quality(figures) };
  return { ...base, ...values, quality: outcome, net_margin: null };
}

export interface SyncOptions {
  limit?: number | null;
  symbol?: string;
  priorityOnly?: boolean;
  progress?: (done: number, total: number) => void;
  workers?: number;
  commitEvery?: number;
}

/**
 * Fetch and parse outstanding XBRL documents. Resumable.
 *
 * Downloads run concurrently through the client's throttle, so the request rate stays capped while slow
 * responses no longer stall the queue. fetch is safe to share, so one client (one cookie warm-up) serves
 * every worker. Database writes happen between awaits, so they never interleave.
 */
export async function sync(client: NSEClient, db: Db, opts: SyncOptions = {}): Promise<number> {
  const todo = pending(db, { limit: opts.limit, priorityOnly: opts.priorityOnly, symbol: opts.symbol });
  // On-demand runs show figures as soon as they are parsed.
  const commitEvery = opts.symbol ? 4 : opts.commitEvery ?? 25;
  if (!todo.length) {
    log.info("fundamentals: nothing pending");
    return 0;
  }
  const workers = Math.max(1, opts.workers || config.FUNDAMENTALS_WORKERS);
  log.info(`fundamentals: ${todo.length} filings to parse (${workers} workers)`);

  let written = 0;
  let done = 0;
  let batch: Row[] = [];
  // A long-lived process can end up with connections that hang until they time out; after this many network
  // failures in a row the rest of the batch is skipped, so the caller can start over with fresh connections.
  let networkFailures = 0;
  const STALL_AFTER = 20;
  const flush = () => {
    written += db.upsert("nse_fundamental", batch);
    batch = [];
  };
  await mapPool(todo, workers, async (row) => {
    if (networkFailures >= STALL_AFTER) return;
    const [figures, outcome] = await fetchParse(client, row);
    networkFailures = outcome === "retry" ? networkFailures + 1 : 0;
    done += 1;
    if (outcome !== "retry") batch.push(record(row, figures, figures || outcome !== "ok" ? outcome : "nodata"));
    if (batch.length >= commitEvery) {
      flush();
      log.info(`fundamentals: ${done}/${todo.length}`);
    }
    opts.progress?.(done, todo.length);
  });
  if (batch.length) flush();
  log.info(`fundamentals -> ${written} rows`);
  if (networkFailures >= STALL_AFTER) throw new NetworkStall(`${STALL_AFTER} downloads in a row failed on the network`);
  return written;
}

/** Parse every outstanding filing, surviving individual batch failures. */
export async function runUntilDone(client: NSEClient, db: Db, opts: { priorityOnly?: boolean; batch?: number; maxRounds?: number } = {}): Promise<number> {
  const { priorityOnly = false, batch = 400, maxRounds = 2000 } = opts;
  let total = 0;
  let stalled = 0;
  for (let round = 1; round <= maxRounds; round++) {
    const left = pending(db, { priorityOnly }).length;
    if (!left) {
      log.info("fundamentals: complete, nothing pending");
      break;
    }
    log.info(`fundamentals: round ${round}, ${left} pending`);
    let written: number;
    try {
      written = await sync(client, db, { limit: batch, priorityOnly });
    } catch (e) {
      log.warn(`fundamentals: batch failed (${(e as Error).message}), backing off`);
      await sleep(30_000);
      continue;
    }
    total += written;
    // Unparseable filings are recorded too, so `left` strictly decreases every round; if not, something is wrong.
    if (pending(db, { priorityOnly }).length >= left) {
      stalled += 1;
      if (stalled >= 3) {
        log.error("fundamentals: queue not shrinking, stopping");
        break;
      }
    } else {
      stalled = 0;
    }
  }
  return total;
}
