// Risk flags: the handful of disclosures that most often precede trouble, each tied to the filing that raised it.
//
// Every check reports one of three states - raised, clear, or unknown - and never guesses between them. "Clear"
// means the check ran against data that exists; "unknown" means the filing needed is not on record, which is
// itself worth knowing. A raised flag always carries the document behind it so a reader can go and look.
import type { Db, Row } from "../db";
import { resolve, type Identity } from "../core/analysis";
import { addDays, toNum, todayIso } from "../util";

export type FlagLevel = "high" | "medium" | "low";
export type FlagStatus = "raised" | "clear" | "unknown";

export interface RiskFlag {
  key: string;
  label: string;
  status: FlagStatus;
  level: FlagLevel;
  detail: string;
  source: { label: string; when: string | null; url: string | null } | null;
}

export interface RiskFlags {
  symbol: string;
  company: string | null;
  bank: boolean;
  flags: RiskFlag[];
  raised: number;
  checked: number;
  summary: string;
  generatedAt: string;
}

const pp = (v: number) => `${v > 0 ? "+" : ""}${v.toFixed(2)} percentage points`;
const crore = (v: number) => `₹${(v / 1e7).toLocaleString("en-IN", { maximumFractionDigits: 2 })} Cr`;

/** Announcements whose subject matches a pattern, newest first. */
function filings(db: Db, identity: Identity, re: RegExp, sinceDays: number, limit = 200): { when: string; title: string; url: string | null; source: string }[] {
  const since = addDays(todayIso(), -sinceDays);
  const out: { when: string; title: string; url: string | null; source: string }[] = [];
  if (identity.symbol) {
    for (const r of db.all<Row>("SELECT ann_dt, subject, details, pdf_url FROM nse_announcement WHERE symbol = ? AND ann_dt >= ? ORDER BY ann_dt DESC LIMIT ?", [identity.symbol, since, limit])) {
      const text = `${r.subject ?? ""} ${r.details ?? ""}`;
      if (re.test(text)) out.push({ when: String(r.ann_dt), title: String(r.subject ?? "").trim() || "Exchange filing", url: (r.pdf_url as string) ?? null, source: "NSE announcement" });
    }
  }
  if (identity.bseCode) {
    for (const r of db.all<Row>("SELECT news_dt, headline, category, pdf_url FROM announcement WHERE scrip_cd = ? AND news_dt >= ? ORDER BY news_dt DESC LIMIT ?", [identity.bseCode, since, limit])) {
      const text = `${r.headline ?? ""} ${r.category ?? ""}`;
      if (re.test(text)) out.push({ when: String(r.news_dt), title: String(r.headline ?? "").trim() || "Exchange filing", url: (r.pdf_url as string) ?? null, source: "BSE filing" });
    }
  }
  return out.sort((a, b) => b.when.localeCompare(a.when));
}

const PLEDGE = /\b(pledg|encumbran|creation of encumbrance|invocation)/i;
const AUDITOR = /\b(auditor)\b.*\b(resign|cessation|change|appoint|removal)|\b(resignation|cessation) of (the )?(statutory )?auditor/i;
const ACTION = /\b(penalt|show cause|adjudicat|prosecution|sebi order|search and seizure|fraud|default in payment|insolvenc|nclt|winding up)/i;
const QUALIFIED = /\b(qualified opinion|audit qualification|emphasis of matter|adverse opinion|disclaimer of opinion)/i;

/** Every red-flag check for one company, raised or otherwise. */
export function riskFlags(db: Db, ident: string): RiskFlags | null {
  let identity: Identity;
  try {
    identity = resolve(db, ident);
  } catch {
    return null;
  }
  const sym = identity.symbol ?? identity.key;
  const m = db.get<Row>("SELECT * FROM company_metrics WHERE symbol = ?", [sym]) ?? {};
  const bank = /bank|financial|finance|nbfc|insur/i.test(String(m.industry ?? ""));
  const flags: RiskFlag[] = [];
  const add = (f: RiskFlag) => flags.push(f);

  // --- promoter pledging ------------------------------------------------------------------
  const pledges = filings(db, identity, PLEDGE, 730);
  const recentPledges = pledges.filter((p) => p.when >= addDays(todayIso(), -365));
  add(recentPledges.length
    ? {
      key: "pledge", label: "Promoter pledging", status: "raised",
      level: recentPledges.length >= 3 ? "high" : "medium",
      detail: `${recentPledges.length} encumbrance disclosure${recentPledges.length > 1 ? "s" : ""} in the last year${pledges.length > recentPledges.length ? ` (${pledges.length} in two years)` : ""}. Repeated pledging by promoters is the single most reliable warning in Indian filings; open the disclosures to see whether the pledged share is rising.`,
      source: { label: recentPledges[0].source, when: recentPledges[0].when, url: recentPledges[0].url },
    }
    : { key: "pledge", label: "Promoter pledging", status: "clear", level: "low", detail: "No encumbrance disclosure filed in the last two years.", source: null });

  // --- promoter holding ------------------------------------------------------------------
  const holdings = db.all<Row>("SELECT as_of_date, promoter, xbrl_url FROM nse_shareholding_detail WHERE symbol = ? AND promoter IS NOT NULL ORDER BY as_of_date DESC LIMIT 6", [sym]);
  if (holdings.length && (toNum(holdings[0].promoter) ?? 0) === 0) {
    add({
      key: "promoter-holding", label: "Promoter holding", status: "clear", level: "low",
      detail: "No promoter holding is reported: the company is professionally managed with no promoter group, so there is no promoter trend to read.",
      source: { label: `Shareholding pattern, ${holdings[0].as_of_date}`, when: String(holdings[0].as_of_date), url: (holdings[0].xbrl_url as string) ?? null },
    });
  } else if (holdings.length >= 2) {
    const now = toNum(holdings[0].promoter)!;
    const prev = toNum(holdings[1].promoter)!;
    const yearAgo = toNum(holdings[Math.min(4, holdings.length - 1)].promoter);
    const qChange = now - prev;
    const yChange = yearAgo === null ? null : now - yearAgo;
    const falling = holdings.length >= 3 && toNum(holdings[1].promoter)! > toNum(holdings[2].promoter)! && qChange < 0;
    const raised = qChange <= -1 || (yChange !== null && yChange <= -2) || falling;
    add({
      key: "promoter-holding", label: "Promoter holding", status: raised ? "raised" : "clear",
      level: qChange <= -3 || (yChange ?? 0) <= -5 ? "high" : "medium",
      detail: raised
        ? `Promoter holding is ${now.toFixed(2)}%, ${pp(qChange)} on the quarter${yChange === null ? "" : ` and ${pp(yChange)} over the year`}${falling ? ", falling for two quarters running" : ""}.`
        : `Promoter holding is ${now.toFixed(2)}%, ${pp(qChange)} on the quarter${yChange === null ? "" : ` and ${pp(yChange)} over the year`}.`,
      source: { label: `Shareholding pattern, ${holdings[0].as_of_date}`, when: String(holdings[0].as_of_date), url: (holdings[0].xbrl_url as string) ?? null },
    });
  } else {
    add({ key: "promoter-holding", label: "Promoter holding", status: "unknown", level: "medium", detail: "Fewer than two shareholding patterns are on record, so a trend cannot be read.", source: null });
  }

  // --- auditor ---------------------------------------------------------------------------
  const auditor = filings(db, identity, AUDITOR, 730);
  add(auditor.length
    ? { key: "auditor", label: "Auditor change", status: "raised", level: /resign|cessation|removal/i.test(auditor[0].title) ? "high" : "medium",
      detail: `${auditor.length} auditor-related filing${auditor.length > 1 ? "s" : ""} in two years. An auditor leaving before the end of a term is worth reading in full.`,
      source: { label: auditor[0].source, when: auditor[0].when, url: auditor[0].url } }
    : { key: "auditor", label: "Auditor change", status: "clear", level: "low", detail: "No auditor resignation or change filed in the last two years.", source: null });

  const qualified = filings(db, identity, QUALIFIED, 730);
  add(qualified.length
    ? { key: "audit-opinion", label: "Audit opinion", status: "raised", level: /adverse|disclaimer|qualified/i.test(qualified[0].title) ? "high" : "medium",
      detail: `${qualified.length} filing${qualified.length > 1 ? "s" : ""} referring to a qualification or emphasis of matter in the audit report.`,
      source: { label: qualified[0].source, when: qualified[0].when, url: qualified[0].url } }
    : { key: "audit-opinion", label: "Audit opinion", status: "clear", level: "low", detail: "No qualified opinion or emphasis of matter disclosed in two years.", source: null });

  // --- insider selling -------------------------------------------------------------------
  const insider = db.all<Row>("SELECT broadcast, acquirer, txn_type, quantity, value FROM nse_insider_trade WHERE symbol = ? AND broadcast >= ? ORDER BY broadcast DESC LIMIT 100", [sym, addDays(todayIso(), -180)]);
  if (insider.length) {
    const sells = insider.filter((t) => /dispos|sell|sale|pledge/i.test(String(t.txn_type ?? "")));
    const sold = sells.reduce((s, t) => s + (toNum(t.value) ?? 0), 0);
    const bought = insider.filter((t) => !sells.includes(t)).reduce((s, t) => s + (toNum(t.value) ?? 0), 0);
    const raised = sells.length > 0 && sold > bought;
    add({
      key: "insider", label: "Insider selling", status: raised ? "raised" : "clear",
      level: sold > bought * 3 && sells.length >= 3 ? "high" : "medium",
      detail: raised
        ? `${sells.length} insider disposal${sells.length > 1 ? "s" : ""} worth ${crore(sold)} in six months against ${crore(bought)} bought.`
        : `${insider.length} insider disclosures in six months; purchases (${crore(bought)}) match or exceed sales (${crore(sold)}).`,
      source: { label: "NSE insider trading disclosures", when: String(insider[0].broadcast), url: null },
    });
  } else {
    add({ key: "insider", label: "Insider selling", status: "clear", level: "low", detail: "No insider trades disclosed in the last six months.", source: null });
  }

  // --- balance sheet ---------------------------------------------------------------------
  const de = toNum(m.debt_to_equity);
  const bs = db.get<Row>("SELECT period_end, xbrl_url FROM nse_statement WHERE symbol = ? AND kind = 'balance_sheet' ORDER BY period_end DESC LIMIT 1", [sym]);
  if (bank) {
    add({ key: "leverage", label: "Leverage", status: "unknown", level: "low", detail: "Not applicable: a lender funds itself with deposits and borrowings by design. Read capital adequacy and asset quality instead.", source: null });
  } else if (de === null) {
    add({ key: "leverage", label: "Debt to equity", status: "unknown", level: "medium", detail: "No balance sheet has been parsed for this company yet.", source: null });
  } else {
    add({
      key: "leverage", label: "Debt to equity", status: de > 1 ? "raised" : "clear", level: de > 2 ? "high" : "medium",
      detail: `Debt to equity is ${de.toFixed(2)}${de > 1 ? ", above the 1.0 a lender usually treats as comfortable" : ", within the range usually treated as comfortable"}.`,
      source: bs ? { label: `Balance sheet, ${bs.period_end}`, when: String(bs.period_end), url: (bs.xbrl_url as string) ?? null } : null,
    });
  }

  // --- regulatory action -----------------------------------------------------------------
  const actions = filings(db, identity, ACTION, 365);
  add(actions.length
    ? { key: "regulatory", label: "Regulatory or legal action", status: "raised", level: /fraud|insolvenc|nclt|winding up|default/i.test(actions[0].title) ? "high" : "medium",
      detail: `${actions.length} filing${actions.length > 1 ? "s" : ""} in a year mentioning a penalty, notice or proceeding. Many are routine tax or listing matters; read the document before drawing a conclusion.`,
      source: { label: actions[0].source, when: actions[0].when, url: actions[0].url } }
    : { key: "regulatory", label: "Regulatory or legal action", status: "clear", level: "low", detail: "No penalty, notice or proceeding disclosed in the last year.", source: null });

  const raisedFlags = flags.filter((f) => f.status === "raised");
  const highs = raisedFlags.filter((f) => f.level === "high").length;
  const summary = raisedFlags.length === 0
    ? `Nothing was raised by ${flags.length} checks against the filings on record.`
    : `${raisedFlags.length} of ${flags.length} checks raised something${highs ? `, ${highs} of them serious` : ""}: ${raisedFlags.map((f) => f.label.toLowerCase()).join(", ")}.`;

  return {
    symbol: sym, company: identity.company, bank, flags,
    raised: raisedFlags.length, checked: flags.length, summary,
    generatedAt: new Date().toISOString(),
  };
}
