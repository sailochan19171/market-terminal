// Who owns the company, and what they have been doing with their holding.
//
// The pipeline has collected quarterly shareholding patterns and insider dealings for a long time; until now no
// agent read them. A balance sheet says what the business owns; this says who owns the business - and institutions
// leaving over a year, or a lender invoking a pledge, is the kind of thing a reader wants named. Everything here
// is read from the exchange filings already on record: the categories come from the SEBI shareholding-pattern
// XBRL, the dealings from the insider-trading disclosures under the PIT regulations.
//
// Nothing is projected and nothing is scored. Each figure is a filed percentage, and each change is the
// difference between two filed percentages, so the validator can find every number in the reports.
import type { Db, Row } from "../db";
import type { QualitativeItem, Unavailable } from "./state";

/** One quarter of the shareholding pattern, as filed. Percentages are percents, not fractions. */
export interface OwnershipQuarter {
  asOf: string;
  promoter: number | null;
  fii: number | null;
  dii: number | null;
  government: number | null;
  publicHolding: number | null;
  shareholders: number | null;
}

/** What an insider disclosure says was done. A pledge is not a sale and is counted separately. */
export type DealingKind = "buy" | "sell" | "pledge" | "pledge released" | "pledge invoked" | "other";

/** One disclosed dealing by a promoter, director or designated person. */
export interface InsiderDealing {
  when: string;
  who: string;
  kind: DealingKind;
  type: string | null;
  quantity: number | null;
  value: number | null;
}

export interface OwnershipReport {
  symbol: string;
  /** Newest first, up to 12 quarters. */
  quarters: OwnershipQuarter[];
  latest: OwnershipQuarter | null;
  /** True when a promoter category is reported at all: a professionally held company files 0. */
  hasPromoter: boolean;
  /** Change in each category over four quarters, in percentage points, where both ends are on record. */
  yearChange: { promoter: number | null; fii: number | null; dii: number | null; institutions: number | null };
  /** Consecutive quarters, from the latest backwards, in which the promoter stake fell. */
  promoterFallingQuarters: number;
  /** Disclosures inside the window below, newest first. */
  insiderDealings: InsiderDealing[];
  /** How far back the dealings were read, in days. */
  insiderWindowDays: number;
  /** Whether anything at all is on record, however old, when the window is empty. */
  lastDealingBefore: string | null;
  insiderNet: { buys: number; sells: number; netValue: number | null; pledgesInvoked: number };
  unavailable: Unavailable[];
}

/** Disclosures older than this say nothing about who is buying now. */
const INSIDER_WINDOW_DAYS = 365;

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * The categories of one filing, read at the scale that filing used. The rows are percents that sum to 100, but
 * older XBRL files hold fractions of 1 summing to 1, and a single small value cannot tell the two apart - 0.1 is
 * a tenth of a percent in one and ten percent in the other. So the scale is decided by the row as a whole.
 */
function scaleRow(parts: (number | null)[]): (number | null)[] {
  const present = parts.filter((v): v is number => v !== null && v >= 0);
  const sum = present.reduce((t, v) => t + v, 0);
  const factor = present.length && sum > 0 && sum <= 1.5 ? 100 : 1;
  return parts.map((v) => {
    if (v === null || v < 0) return null;
    const p = v * factor;
    return p > 100.5 ? null : round2(p);
  });
}

/** The two figures a year apart, in percentage points, or null when either end is missing. */
function change(newer: number | null, older: number | null): number | null {
  return newer === null || older === null ? null : round2(newer - older);
}

export function ownershipReport(db: Db, symbol: string): OwnershipReport {
  const unavailable: Unavailable[] = [];
  const quarters: OwnershipQuarter[] = [];

  // The category detail from the XBRL where it parsed, and the summary feed - promoter and public only - for the
  // quarters where it did not. A quarter present in both is read once, from the detail.
  const detail = db.all<Row>(
    `SELECT as_of_date, promoter, fii, dii, government, public, shareholders
       FROM nse_shareholding_detail WHERE symbol = ? AND status = 'ok' ORDER BY as_of_date DESC LIMIT 12`, [symbol]);
  for (const r of detail) {
    const [promoter, fii, dii, government, publicHolding] =
      scaleRow([num(r.promoter), num(r.fii), num(r.dii), num(r.government), num(r.public)]);
    quarters.push({ asOf: String(r.as_of_date), promoter, fii, dii, government, publicHolding, shareholders: num(r.shareholders) });
  }
  const have = new Set(quarters.map((q) => q.asOf));
  for (const r of db.all<Row>(
    "SELECT as_of_date, promoter, public FROM nse_shareholding WHERE symbol = ? AND as_of_date <> '' ORDER BY as_of_date DESC LIMIT 12", [symbol])) {
    const asOf = String(r.as_of_date);
    if (have.has(asOf)) continue;
    const [promoter, publicHolding] = scaleRow([num(r.promoter), num(r.public)]);
    quarters.push({ asOf, promoter, fii: null, dii: null, government: null, publicHolding, shareholders: null });
  }
  quarters.sort((a, b) => b.asOf.localeCompare(a.asOf));
  quarters.length = Math.min(quarters.length, 12);

  if (!quarters.length) unavailable.push({ key: "shareholding", reason: "no shareholding pattern filed for this company on record" });

  const latest = quarters[0] ?? null;
  const yearAgo = quarters[4] ?? null;                      // four quarters back, when that far is on record
  // A company with no promoter files 0, which is a fact about how it is held, not a stake that has gone to nothing.
  const hasPromoter = (latest?.promoter ?? 0) > 0;
  const institutionsAt = (q: OwnershipQuarter | null) =>
    q === null || (q.fii === null && q.dii === null) ? null : round2((q.fii ?? 0) + (q.dii ?? 0));
  const yearChange = {
    promoter: hasPromoter ? change(latest?.promoter ?? null, yearAgo?.promoter ?? null) : null,
    fii: change(latest?.fii ?? null, yearAgo?.fii ?? null),
    dii: change(latest?.dii ?? null, yearAgo?.dii ?? null),
    institutions: change(institutionsAt(latest), institutionsAt(yearAgo)),
  };
  if (quarters.length && quarters.length < 5) unavailable.push({ key: "ownership_year_change", reason: `${quarters.length} quarter${quarters.length === 1 ? "" : "s"} of shareholding on record, not the five a year-on-year change needs` });
  if (quarters.length && !hasPromoter) unavailable.push({ key: "promoter_holding", reason: "no promoter holding is reported: the company is professionally held" });

  // A stake drifting down quarter after quarter is the signal; one quarter's move is noise. A gap in the
  // record ends the count rather than being read through.
  let falling = 0;
  if (hasPromoter) {
    for (let i = 0; i + 1 < quarters.length; i++) {
      const a = quarters[i].promoter, b = quarters[i + 1].promoter;
      if (a === null || b === null || a >= b) break;
      falling++;
    }
  }

  // Only disclosures from the last year: an ESOP sale eighteen months ago says nothing about who is selling now.
  const since = new Date(Date.now() - INSIDER_WINDOW_DAYS * 86_400_000).toISOString().slice(0, 10);
  const rows = db.all<Row>(
    `SELECT broadcast, acquirer, txn_type, quantity, value FROM nse_insider_trade
      WHERE symbol = ? AND broadcast <> '' ORDER BY broadcast DESC LIMIT 400`, [symbol]);
  const dealings: InsiderDealing[] = rows
    .filter((r) => String(r.broadcast).slice(0, 10) >= since)
    .slice(0, 25)
    .map((r) => {
      const type = (r.txn_type as string | null)?.trim() || null;
      return {
        when: String(r.broadcast).slice(0, 10), who: String(r.acquirer ?? "").trim(),
        kind: kindOf(type), type, quantity: num(r.quantity), value: num(r.value),
      };
    });
  const newest = rows[0] ? String(rows[0].broadcast).slice(0, 10) : null;
  const lastDealingBefore = !dealings.length && newest ? newest : null;
  const traded = dealings.filter((d) => (d.kind === "buy" || d.kind === "sell") && d.value !== null);
  const insiderNet = {
    buys: dealings.filter((d) => d.kind === "buy").length,
    sells: dealings.filter((d) => d.kind === "sell").length,
    netValue: traded.length ? traded.reduce((t, d) => t + (d.kind === "buy" ? d.value! : -d.value!), 0) : null,
    pledgesInvoked: dealings.filter((d) => d.kind === "pledge invoked").length,
  };
  if (!dealings.length) {
    unavailable.push({ key: "insider_dealings", reason: lastDealingBefore
      ? `no insider dealing disclosed in the last ${INSIDER_WINDOW_DAYS} days; the most recent on record is ${lastDealingBefore}`
      : "no insider dealings disclosed for this company on record" });
  }

  return { symbol, quarters, latest, hasPromoter, yearChange, promoterFallingQuarters: falling, insiderDealings: dealings, insiderWindowDays: INSIDER_WINDOW_DAYS, lastDealingBefore, insiderNet, unavailable };
}

/** What the exchange's transaction type means. A pledge moves no shares; invoking one means the lender took them. */
export function kindOf(type: string | null): DealingKind {
  const t = (type ?? "").toLowerCase();
  if (/pledge\s*invoke|invocation/.test(t)) return "pledge invoked";
  if (/pledge\s*(revoke|release)/.test(t)) return "pledge released";
  if (/pledge|encumbr/.test(t)) return "pledge";
  if (/^sell|sale|dispos/.test(t)) return "sell";
  if (/^buy|purchase|acquisition/.test(t)) return "buy";
  return "other";
}

const pct = (v: number) => `${v.toFixed(2)}%`;
/** A change of less than half a basis point is not a move, and must not be described as one. */
const points = (v: number) => (Math.abs(v) < 0.005 ? "unchanged" : `${v > 0 ? "up" : "down"} ${Math.abs(v).toFixed(2)} percentage points`);
const overYear = (v: number | null) => (v === null ? "" : `, ${points(v)} over four quarters`);

/**
 * The ownership picture as signals for the qualitative report: what is worth naming, each with the quarter it
 * was filed for. Only what the filings say - a stake that has not moved is not a finding.
 */
export function ownershipSignals(o: OwnershipReport): { management: QualitativeItem[]; risks: QualitativeItem[] } {
  const management: QualitativeItem[] = [], risks: QualitativeItem[] = [];
  const at = o.latest;
  if (!at) return { management, risks };
  const label = `NSE shareholding pattern, quarter ended ${at.asOf}`;
  const item = (summary: string, sentiment: QualitativeItem["sentiment"]): QualitativeItem =>
    ({ summary, sentiment, sourceUrl: null, sourceLabel: label, date: at.asOf });
  const moved = (v: number | null, good: "up" | "down" = "up") =>
    v === null || Math.abs(v) <= 0.5 ? "neutral" : (v > 0) === (good === "up") ? "positive" : "negative";

  // The promoter trend and any encumbrance disclosure are already raised as risk flags from the same filings
  // (research/flags.ts), so the stake is stated here as a fact and not raised a second time as a concern.
  if (o.hasPromoter && at.promoter !== null) {
    management.push(item(`Promoters held ${pct(at.promoter)} of the company at ${at.asOf}${overYear(o.yearChange.promoter)}.`, moved(o.yearChange.promoter)));
  } else if (o.quarters.length) {
    management.push(item(`No promoter holding is reported: the company is professionally held, with the public and institutions owning all of it.`, "neutral"));
  }
  const inst = at.fii === null && at.dii === null ? null : round2((at.fii ?? 0) + (at.dii ?? 0));
  if (inst !== null) {
    const split = at.fii !== null && at.dii !== null ? ` (foreign ${pct(at.fii)}, domestic ${pct(at.dii)})`
      : at.fii !== null ? ` (foreign ${pct(at.fii)})` : ` (domestic ${pct(at.dii!)})`;
    management.push(item(`Institutions held ${pct(inst)}${split} at ${at.asOf}${overYear(o.yearChange.institutions)}.`, moved(o.yearChange.institutions)));
  }
  // Institutions leaving in size is the one thing here the risk flags do not already cover.
  if (o.yearChange.institutions !== null && o.yearChange.institutions < -2 && inst !== null) {
    risks.push(item(`Institutional holding is ${points(o.yearChange.institutions)} over four quarters, to ${pct(inst)} at ${at.asOf}.`, "negative"));
  }
  if (at.shareholders !== null && at.shareholders > 0) {
    management.push(item(`${at.shareholders.toLocaleString("en-IN")} shareholders on record at ${at.asOf}.`, "neutral"));
  }
  if (o.insiderDealings.length) {
    const d = o.insiderDealings[0];
    const n = o.insiderNet;
    const counted = n.buys + n.sells;
    management.push({
      summary: counted
        ? `${counted} insider dealing${counted === 1 ? "" : "s"} disclosed in the last year, ${n.buys} on the buy side and ${n.sells} on the sell side; the most recent was ${d.who || "an insider"} on ${d.when}${d.type ? ` (${d.type.toLowerCase()})` : ""}.`
        : `${o.insiderDealings.length} insider disclosure${o.insiderDealings.length === 1 ? "" : "s"} in the last year, none of them a purchase or sale of shares; the most recent was ${d.who || "an insider"} on ${d.when}${d.type ? ` (${d.type.toLowerCase()})` : ""}.`,
      sentiment: n.buys > n.sells ? "positive" : n.sells > n.buys ? "negative" : "neutral",
      sourceUrl: null, sourceLabel: `NSE insider trading disclosures (SEBI PIT regulations), last ${o.insiderWindowDays} days`, date: d.when,
    });
    if (n.pledgesInvoked) {
      risks.push({
        summary: `${n.pledgesInvoked} pledge invocation${n.pledgesInvoked === 1 ? "" : "s"} disclosed in the last year: a lender took possession of pledged shares.`,
        sentiment: "negative", sourceUrl: null, sourceLabel: "NSE insider trading disclosures (SEBI PIT regulations)", date: o.insiderDealings.find((x) => x.kind === "pledge invoked")?.when ?? null,
      });
    }
  }
  return { management, risks };
}

/** The lines the writer and both sides of the debate may quote, or an empty list when nothing was filed. */
export function ownershipFacts(o: OwnershipReport): string[] {
  const at = o.latest;
  if (!at) return [];
  const lines: string[] = [];
  if (o.hasPromoter && at.promoter !== null) lines.push(`Promoter holding ${pct(at.promoter)} at ${at.asOf}${o.yearChange.promoter === null ? "" : ` (${points(o.yearChange.promoter)} over four quarters)`}.`);
  else if (o.quarters.length) lines.push(`No promoter holding reported at ${at.asOf}: the company is professionally held.`);
  if (at.fii !== null) lines.push(`Foreign institutional holding ${pct(at.fii)}${o.yearChange.fii !== null ? ` (${points(o.yearChange.fii)} over four quarters)` : ""}.`);
  if (at.dii !== null) lines.push(`Domestic institutional holding ${pct(at.dii)}${o.yearChange.dii !== null ? ` (${points(o.yearChange.dii)} over four quarters)` : ""}.`);
  if (at.publicHolding !== null) lines.push(`Public and other holding ${pct(at.publicHolding)}.`);
  if (at.government !== null && at.government > 0) lines.push(`Government holding ${pct(at.government)}.`);
  if (o.promoterFallingQuarters >= 3) lines.push(`The promoter holding has fallen in each of the last ${o.promoterFallingQuarters} quarters on record.`);
  if (o.insiderNet.buys || o.insiderNet.sells) {
    const n = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
    lines.push(`In the last year insiders disclosed ${n(o.insiderNet.buys, "purchase")} and ${n(o.insiderNet.sells, "sale")}.`);
  }
  if (o.insiderNet.pledgesInvoked) lines.push(`${o.insiderNet.pledgesInvoked} pledge invocations disclosed in the last year.`);
  return lines;
}
