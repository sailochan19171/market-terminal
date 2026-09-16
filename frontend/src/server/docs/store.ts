// The document library: what was uploaded or downloaded, split into passages a question can find.
//
// A document is stored as its text, never as the file, and always in pieces: a passage of about a thousand
// characters carrying its page number, so an answer can say "page 14 of the annual report" and the reader can
// go and look. Retrieval is full-text (the same FTS5 the announcements use) and, when an embedding key is
// configured, the shortlist is reordered by meaning.
import { createHash } from "node:crypto";
import type { Db, Row } from "../db";
import { now } from "../db";
import { logger } from "../log";
import { available as vectorsAvailable, embed, similarity, toBlob, fromBlob } from "./vectors";
import { extract, UnreadableDocument } from "./extract";

const log = logger("docs");

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS doc (
    id          TEXT PRIMARY KEY,
    symbol      TEXT,
    title       TEXT NOT NULL,
    kind        TEXT NOT NULL,          -- upload | filing | report
    source      TEXT,                   -- the file name, or the exchange it came from
    url         TEXT,
    pages       INTEGER NOT NULL DEFAULT 0,
    chars       INTEGER NOT NULL DEFAULT 0,
    chunks      INTEGER NOT NULL DEFAULT 0,
    note        TEXT,
    added_at    TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_doc_symbol ON doc(symbol, added_at);

CREATE TABLE IF NOT EXISTS doc_chunk (
    doc_id  TEXT NOT NULL,
    ord     INTEGER NOT NULL,
    page    INTEGER,
    text    TEXT NOT NULL,
    vec     BLOB,
    PRIMARY KEY (doc_id, ord)
);
CREATE INDEX IF NOT EXISTS ix_doc_chunk_doc ON doc_chunk(doc_id);

CREATE VIRTUAL TABLE IF NOT EXISTS doc_chunk_fts USING fts5(text, content='doc_chunk', content_rowid='rowid', tokenize='unicode61');
CREATE TRIGGER IF NOT EXISTS doc_chunk_ai AFTER INSERT ON doc_chunk BEGIN
  INSERT INTO doc_chunk_fts(rowid, text) VALUES (new.rowid, new.text);
END;
CREATE TRIGGER IF NOT EXISTS doc_chunk_ad AFTER DELETE ON doc_chunk BEGIN
  INSERT INTO doc_chunk_fts(doc_chunk_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
END;
CREATE TRIGGER IF NOT EXISTS doc_chunk_au AFTER UPDATE ON doc_chunk BEGIN
  INSERT INTO doc_chunk_fts(doc_chunk_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
  INSERT INTO doc_chunk_fts(rowid, text) VALUES (new.rowid, new.text);
END;
`;

let ready = false;
export function ensureSchema(db: Db) {
  if (ready) return;
  db.exec(SCHEMA);
  ready = true;
}

// A passage long enough to hold a whole point, short enough that several fit in one answer's context.
const CHUNK = 1100;
const OVERLAP = 150;
/** Uploads are capped so one file cannot fill the database or stall a request. */
export const MAX_BYTES = 12 * 1024 * 1024;

export interface Passage {
  docId: string;
  title: string;
  kind: string;
  page: number | null;
  url: string | null;
  text: string;
  /** The part of the passage that answers the question, for quoting without the surrounding page. */
  snippet: string;
  score: number;
}

/** A window of `len` characters around the first word of the question that appears in the passage. */
function snippetFor(text: string, words: string[], len = 320): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const lower = flat.toLowerCase();
  let at = -1;
  for (const w of words) {
    const i = lower.indexOf(w);
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  if (at < 0 || flat.length <= len) return flat.slice(0, len);
  const start = Math.max(0, at - Math.floor(len / 3));
  const cut = flat.slice(start, start + len);
  return `${start > 0 ? "…" : ""}${cut}${start + len < flat.length ? "…" : ""}`;
}

export interface Document {
  id: string; symbol: string | null; title: string; kind: string; source: string | null;
  url: string | null; pages: number; chars: number; chunks: number; note: string | null; added_at: string;
}

/** Split a page into overlapping passages, breaking at sentence ends rather than mid-word. */
function passages(text: string): string[] {
  const clean = text.replace(/[ \t]+/g, " ").trim();
  if (clean.length <= CHUNK) return clean ? [clean] : [];
  const out: string[] = [];
  let at = 0;
  while (at < clean.length) {
    let end = Math.min(at + CHUNK, clean.length);
    if (end < clean.length) {
      const stop = Math.max(clean.lastIndexOf(". ", end), clean.lastIndexOf("\n", end));
      if (stop > at + CHUNK / 2) end = stop + 1;
    }
    out.push(clean.slice(at, end).trim());
    if (end >= clean.length) break;
    at = end - OVERLAP;
  }
  return out.filter((p) => p.length > 40);
}

export interface AddOptions {
  symbol?: string | null;
  title: string;
  kind?: "upload" | "filing" | "report";
  source?: string | null;
  url?: string | null;
  filename?: string;
}

/** Read a file, split it, index it. Re-adding the same bytes replaces the old copy rather than duplicating it. */
export async function add(db: Db, bytes: Uint8Array, opts: AddOptions): Promise<Document> {
  ensureSchema(db);
  if (bytes.length > MAX_BYTES) throw new UnreadableDocument(`That file is ${(bytes.length / 1024 / 1024).toFixed(1)} MB. The limit is ${MAX_BYTES / 1024 / 1024} MB.`);
  const read = await extract(bytes, opts.filename ?? opts.title);
  if (read.imageOnly) throw new UnreadableDocument("This PDF holds scanned images rather than text, so there is nothing to read from it. A text PDF or a Word file works.");

  const id = createHash("sha1").update(bytes).digest("hex").slice(0, 16);
  const chunks: { ord: number; page: number | null; text: string }[] = [];
  read.pages.forEach((page, i) => {
    for (const text of passages(page)) chunks.push({ ord: chunks.length, page: i + 1, text });
  });
  if (!chunks.length) throw new UnreadableDocument("No readable text was found in this file.");

  const vectors = vectorsAvailable() ? await embed(chunks.map((c) => c.text)).catch((e) => {
    log.warn(`embeddings unavailable, falling back to text search: ${(e as Error).message}`);
    return null;
  }) : null;

  const stamp = now();
  db.run("DELETE FROM doc_chunk WHERE doc_id = ?", [id]);
  db.run("DELETE FROM doc WHERE id = ?", [id]);
  db.upsert("doc", [{
    id, symbol: opts.symbol ?? null, title: opts.title.slice(0, 300), kind: opts.kind ?? "upload",
    source: opts.source ?? null, url: opts.url ?? null, pages: read.pages.length, chars: read.chars,
    chunks: chunks.length, note: read.kind, added_at: stamp, updated_at: stamp,
  }]);
  // One statement per passage would be one network round trip per passage against the hosted database; a
  // three-hundred-page report would never finish inside a request. upsert() sends them in batches.
  db.upsert("doc_chunk", chunks.map((c, i) => ({
    doc_id: id, ord: c.ord, page: c.page, text: c.text, vec: vectors ? toBlob(vectors[i]) : null,
  })));
  log.info(`${opts.title}: ${read.pages.length} pages, ${chunks.length} passages${vectors ? ", embedded" : ""}`);
  return db.get<Document>("SELECT * FROM doc WHERE id = ?", [id])!;
}

export function list(db: Db, symbol?: string | null): Document[] {
  ensureSchema(db);
  return symbol
    ? db.all<Document>("SELECT * FROM doc WHERE symbol = ? ORDER BY added_at DESC LIMIT 100", [symbol])
    : db.all<Document>("SELECT * FROM doc ORDER BY added_at DESC LIMIT 100");
}

export function remove(db: Db, id: string): boolean {
  ensureSchema(db);
  const had = db.get("SELECT id FROM doc WHERE id = ?", [id]);
  if (!had) return false;
  db.transaction(() => {
    db.run("DELETE FROM doc_chunk WHERE doc_id = ?", [id]);
    db.run("DELETE FROM doc WHERE id = ?", [id]);
  });
  return true;
}

const STOP = new Set(["what", "when", "where", "which", "why", "how", "does", "did", "the", "this", "that", "and", "for", "with", "about", "from", "they", "their", "have", "has", "was", "were", "are", "its", "it's", "company", "please", "tell", "show"]);

const terms = (q: string) => [...new Set((q.match(/[\p{L}\p{N}]{3,}/gu) ?? []).map((w) => w.toLowerCase()).filter((w) => !STOP.has(w)))];

/**
 * Passages that answer a question, newest documents preferred on a tie.
 *
 * Words find the candidates; when embeddings are configured, meaning reorders them - a question about
 * "how much did they borrow" then reaches a passage that says "term loans were availed" and never says debt.
 */
export async function search(db: Db, symbol: string | null, question: string, limit = 5): Promise<Passage[]> {
  ensureSchema(db);
  if (!db.get("SELECT id FROM doc LIMIT 1")) return [];
  const words = terms(question);
  const where = symbol ? "AND (d.symbol = ? OR d.symbol IS NULL)" : "";
  const args: (string | number)[] = [];
  let rows: Row[] = [];

  if (words.length) {
    const match = words.map((w) => `"${w.replace(/"/g, "")}"`).join(" OR ");
    args.push(match);
    if (symbol) args.push(symbol);
    rows = db.all(
      `SELECT c.doc_id, c.page, c.text, c.vec, d.title, d.kind, d.url, bm25(doc_chunk_fts) AS rank
       FROM doc_chunk_fts f JOIN doc_chunk c ON c.rowid = f.rowid JOIN doc d ON d.id = c.doc_id
       WHERE doc_chunk_fts MATCH ? ${where} ORDER BY rank LIMIT ?`, [...args, limit * 6]);
  }
  // No fallback when the question had words and none of them appear: an answer must not quote a passage that
  // has nothing to do with what was asked. Only a question with no searchable words gets the newest passages.
  if (!rows.length && !words.length) {
    rows = db.all(
      `SELECT c.doc_id, c.page, c.text, c.vec, d.title, d.kind, d.url, 0 AS rank
       FROM doc_chunk c JOIN doc d ON d.id = c.doc_id WHERE 1=1 ${where} ORDER BY d.added_at DESC, c.ord LIMIT ?`,
      symbol ? [symbol, limit] : [limit]);
  }

  let scored = rows.map((r) => ({
    docId: String(r.doc_id), title: String(r.title), kind: String(r.kind), page: (r.page as number) ?? null,
    url: (r.url as string) ?? null, text: String(r.text), score: -Number(r.rank ?? 0), vec: r.vec as Uint8Array | null,
  }));

  if (vectorsAvailable() && scored.some((s) => s.vec)) {
    try {
      const [q] = await embed([question]);
      scored = scored
        .map((s) => ({ ...s, score: s.vec ? similarity(q, fromBlob(s.vec)) : s.score / 100 }))
        .sort((a, b) => b.score - a.score);
    } catch (e) {
      log.warn(`re-ranking skipped: ${(e as Error).message}`);
    }
  }
  // The stored vector is an implementation detail; the caller sees the passage and where it came from.
  return scored.slice(0, limit).map((p) => ({
    docId: p.docId, title: p.title, kind: p.kind, page: p.page, url: p.url,
    text: p.text, snippet: snippetFor(p.text, words), score: p.score,
  }));
}

export function stats(db: Db): { documents: number; chunks: number; embedded: number } {
  ensureSchema(db);
  return {
    documents: db.scalar<number>("SELECT COUNT(*) FROM doc") ?? 0,
    chunks: db.scalar<number>("SELECT COUNT(*) FROM doc_chunk") ?? 0,
    embedded: db.scalar<number>("SELECT COUNT(*) FROM doc_chunk WHERE vec IS NOT NULL") ?? 0,
  };
}
