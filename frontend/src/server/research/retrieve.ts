// Finds the filings behind an answer: full-text search across NSE and BSE announcements for one company,
// falling back to the most recent ones when the question has no distinctive words.
import type { Db, Row } from "../db";
import { available as ftsAvailable, matchQuery } from "../core/searchIndex";
import { ensureSchema as ensureKb } from "./kb";

export interface Passage {
  id: number;
  kind: string;            // "filing" for an exchange announcement, else the knowledge base document kind
  exchange: "NSE" | "BSE" | null;
  when: string;
  title: string;
  detail: string | null;
  url: string | null;
}

/** Knowledge base documents for this company that match the question. */
export function knowledge(db: Db, symbol: string, question: string, limit = 5): Passage[] {
  if (!db.hasTable("kb_doc")) return [];
  const words = terms(question);
  const rows: Row[] = words.length
    ? db.all("SELECT rowid AS id, kind, title, text, period, as_of, url FROM kb_doc WHERE symbol = ? AND rowid IN (SELECT rowid FROM kb_doc_fts WHERE kb_doc_fts MATCH ?) ORDER BY as_of DESC LIMIT ?",
      [symbol, matchQuery(words.join(" ")), limit])
    : [];
  const fallback = rows.length ? [] : db.all<Row>("SELECT rowid AS id, kind, title, text, period, as_of, url FROM kb_doc WHERE symbol = ? ORDER BY CASE kind WHEN 'profile' THEN 0 WHEN 'results' THEN 1 ELSE 2 END, as_of DESC LIMIT ?", [symbol, limit]);
  return [...rows, ...fallback].map((r) => ({
    id: Number(r.id), kind: String(r.kind), exchange: null, when: String(r.as_of ?? r.period ?? ""),
    title: String(r.title), detail: String(r.text).slice(0, 700), url: (r.url as string) ?? null,
  }));
}

const STOP = new Set(["what", "why", "how", "when", "should", "the", "this", "that", "is", "are", "was", "were", "for", "and", "with", "about", "does", "did", "can", "could", "would", "will", "from", "into", "over", "their", "there", "company", "stock", "share", "price", "tell", "give", "show", "me", "my", "please", "explain", "buy", "sell", "invest"]);

const terms = (q: string) => (q.match(/[\p{L}\p{N}]{3,}/gu) ?? []).map((w) => w.toLowerCase()).filter((w) => !STOP.has(w));

/** Filings for this company that match the question, newest first. */
export function passages(db: Db, symbol: string, bseCode: string | null, question: string, limit = 8): Passage[] {
  ensureKb(db);
  const words = terms(question);
  const out: Passage[] = [];
  const fts = ftsAvailable(db) && words.length > 0;
  const match = fts ? matchQuery(words.join(" ")) : "";

  const nse: Row[] = fts
    ? db.all("SELECT rowid AS id, ann_dt, subject, details, pdf_url FROM nse_announcement WHERE symbol = ? AND rowid IN (SELECT rowid FROM nse_announcement_fts WHERE nse_announcement_fts MATCH ?) ORDER BY ann_dt DESC LIMIT ?", [symbol, match, limit])
    : [];
  const recentNse = db.all("SELECT rowid AS id, ann_dt, subject, details, pdf_url FROM nse_announcement WHERE symbol = ? ORDER BY ann_dt DESC LIMIT ?", [symbol, limit]);
  for (const r of [...nse, ...recentNse]) {
    if (out.some((p) => p.id === Number(r.id) && p.exchange === "NSE")) continue;
    out.push({ id: Number(r.id), kind: "filing", exchange: "NSE", when: String(r.ann_dt), title: String(r.subject ?? ""), detail: (r.details as string) ?? null, url: (r.pdf_url as string) ?? null });
  }

  if (bseCode) {
    const bse: Row[] = fts
      ? db.all("SELECT rowid AS id, news_dt, headline, category, pdf_url FROM announcement WHERE scrip_cd = ? AND rowid IN (SELECT rowid FROM announcement_fts WHERE announcement_fts MATCH ?) ORDER BY news_dt DESC LIMIT ?", [bseCode, match, limit])
      : db.all("SELECT rowid AS id, news_dt, headline, category, pdf_url FROM announcement WHERE scrip_cd = ? ORDER BY news_dt DESC LIMIT ?", [bseCode, limit]);
    for (const r of bse) out.push({ id: Number(r.id), kind: "filing", exchange: "BSE", when: String(r.news_dt), title: String(r.headline ?? ""), detail: (r.category as string) ?? null, url: (r.pdf_url as string) ?? null });
  }

  // Prefer matches, then recency; keep both exchanges represented.
  const scored = out.map((p) => ({ p, hits: words.filter((w) => `${p.title} ${p.detail ?? ""}`.toLowerCase().includes(w)).length }));
  scored.sort((a, b) => b.hits - a.hits || b.p.when.localeCompare(a.p.when));
  return scored.slice(0, limit).map((s) => s.p);
}
