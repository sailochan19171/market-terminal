// A record of everything the platform generated, and what it was generated from.
//
// Two reasons this exists. The SEBI Research Analyst rules require an entity to keep its research records - and
// to be answerable for AI output - so every answer is stored with the question, the sources it cited, the model
// that phrased it and what that cost. And a claim about quality is worth nothing without measurement: the
// grounding rate, the helpfulness ratings and the token spend on the quality page are read straight from here.
//
// Records are kept, not rotated: the retention the rules expect is five years.
import { createHash, randomUUID } from "node:crypto";
import type { Db } from "../db";
import { now } from "../db";
import { logger } from "../log";

const log = logger("audit");

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS ai_generation (
    id            TEXT PRIMARY KEY,
    at            TEXT NOT NULL,
    kind          TEXT NOT NULL,        -- answer | move | summary | screen
    symbol        TEXT,
    question      TEXT,
    answer        TEXT NOT NULL,
    written_by    TEXT NOT NULL,        -- data | model
    model         TEXT,
    citations     TEXT,                 -- JSON: what the answer was allowed to draw on
    context_hash  TEXT,                 -- identifies the retrieved material without storing it twice
    figures       INTEGER DEFAULT 0,    -- numbers the answer printed
    ungrounded    INTEGER DEFAULT 0,    -- of those, ones not present in the retrieved material
    prompt_tokens INTEGER,
    completion_tokens INTEGER,
    latency_ms    INTEGER,
    error         TEXT,
    rating        TEXT,                 -- helpful | unhelpful, from the reader
    rated_at      TEXT,
    reviewed_at   TEXT,                 -- the daily human sample
    review        TEXT                  -- ok | wrong | unclear
);
CREATE INDEX IF NOT EXISTS ix_ai_gen_at ON ai_generation(at);
CREATE INDEX IF NOT EXISTS ix_ai_gen_symbol ON ai_generation(symbol, at);
`;

let ready = false;
export function ensureSchema(db: Db) {
  if (ready) return;
  db.exec(SCHEMA);
  ready = true;
}

/** Figures a reader would check: rupee amounts, percentages and decimals. */
const claimed = (text: string): number[] =>
  (text.match(/₹\s?-?[\d,]+(?:\.\d+)?|-?[\d,]+(?:\.\d+)?\s?%|\b-?\d[\d,]*\.\d+\b/g) ?? [])
    .map((n) => Math.abs(Number(n.replace(/[₹%,\s]/g, ""))))
    .filter((n) => Number.isFinite(n) && n !== 0);

/** Every number in the material the answer was built from, read liberally. */
const present = (text: string): number[] =>
  (text.match(/-?[\d,]+(?:\.\d+)?/g) ?? []).map((n) => Math.abs(Number(n.replace(/,/g, "")))).filter(Number.isFinite);

const traces = (want: number, pool: number[]) =>
  pool.some((v) => v === want || Math.abs(v - want) <= Math.max(0.011, Math.abs(want) * 0.001) || (Math.abs(want) >= 100 && Math.round(v) === Math.round(want)));

/** How many of the answer's figures appear in what it was given. This is the grounding rate, measured. */
export function grounding(answer: string, source: string): { figures: number; ungrounded: number } {
  const pool = present(source);
  const numbers = claimed(answer);
  return { figures: numbers.length, ungrounded: numbers.filter((n) => !traces(n, pool)).length };
}

export interface Record {
  kind: "answer" | "move" | "summary" | "screen";
  symbol?: string | null;
  question?: string | null;
  answer: string;
  writtenBy: "data" | "model";
  model?: string | null;
  citations?: unknown;
  context?: string;
  promptTokens?: number | null;
  completionTokens?: number | null;
  latencyMs?: number | null;
  error?: string | null;
}

/** Store one generation. Never throws: an audit failure must not cost a reader their answer. */
export function record(db: Db, r: Record): string | null {
  try {
    ensureSchema(db);
    const id = randomUUID();
    const { figures, ungrounded } = r.context ? grounding(r.answer, `${r.context} ${JSON.stringify(r.citations ?? [])}`) : { figures: 0, ungrounded: 0 };
    db.run(
      `INSERT INTO ai_generation (id, at, kind, symbol, question, answer, written_by, model, citations, context_hash,
        figures, ungrounded, prompt_tokens, completion_tokens, latency_ms, error)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, now(), r.kind, r.symbol ?? null, r.question?.slice(0, 500) ?? null, r.answer.slice(0, 6000), r.writtenBy,
        r.model ?? null, JSON.stringify(r.citations ?? []).slice(0, 4000),
        r.context ? createHash("sha1").update(r.context).digest("hex").slice(0, 16) : null,
        figures, ungrounded, r.promptTokens ?? null, r.completionTokens ?? null, r.latencyMs ?? null, r.error ?? null]);
    return id;
  } catch (e) {
    log.warn(`could not record a generation: ${(e as Error).message}`);
    return null;
  }
}

export function rate(db: Db, id: string, rating: "helpful" | "unhelpful"): boolean {
  ensureSchema(db);
  if (!db.get("SELECT id FROM ai_generation WHERE id = ?", [id])) return false;
  db.run("UPDATE ai_generation SET rating = ?, rated_at = ? WHERE id = ?", [rating, now(), id]);
  return true;
}

export function review(db: Db, id: string, verdict: "ok" | "wrong" | "unclear"): boolean {
  ensureSchema(db);
  if (!db.get("SELECT id FROM ai_generation WHERE id = ?", [id])) return false;
  db.run("UPDATE ai_generation SET review = ?, reviewed_at = ? WHERE id = ?", [verdict, now(), id]);
  return true;
}

export interface Quality {
  since: string;
  generated: number;
  byModel: number;
  figures: number;
  ungrounded: number;
  groundingRate: number | null;
  helpful: number;
  unhelpful: number;
  reviewed: number;
  wrong: number;
  promptTokens: number;
  completionTokens: number;
  failures: number;
}

/** The numbers the spec asks to be held to, measured over the last `days`. */
export function quality(db: Db, days = 30): Quality {
  ensureSchema(db);
  const since = new Date(Date.now() - days * 86_400_000).toISOString().replace(/\.\d{3}Z$/, "+00:00");
  const r = db.get<Record & Quality>(
    `SELECT COUNT(*) AS generated,
            SUM(CASE WHEN written_by = 'model' THEN 1 ELSE 0 END) AS byModel,
            COALESCE(SUM(figures), 0) AS figures,
            COALESCE(SUM(ungrounded), 0) AS ungrounded,
            SUM(CASE WHEN rating = 'helpful' THEN 1 ELSE 0 END) AS helpful,
            SUM(CASE WHEN rating = 'unhelpful' THEN 1 ELSE 0 END) AS unhelpful,
            SUM(CASE WHEN reviewed_at IS NOT NULL THEN 1 ELSE 0 END) AS reviewed,
            SUM(CASE WHEN review = 'wrong' THEN 1 ELSE 0 END) AS wrong,
            COALESCE(SUM(prompt_tokens), 0) AS promptTokens,
            COALESCE(SUM(completion_tokens), 0) AS completionTokens,
            SUM(CASE WHEN error IS NOT NULL THEN 1 ELSE 0 END) AS failures
     FROM ai_generation WHERE at >= ?`, [since]) as Quality;
  const figures = Number(r.figures ?? 0);
  return {
    since, generated: Number(r.generated ?? 0), byModel: Number(r.byModel ?? 0), figures,
    ungrounded: Number(r.ungrounded ?? 0),
    groundingRate: figures ? Math.round(((figures - Number(r.ungrounded ?? 0)) / figures) * 1000) / 10 : null,
    helpful: Number(r.helpful ?? 0), unhelpful: Number(r.unhelpful ?? 0),
    reviewed: Number(r.reviewed ?? 0), wrong: Number(r.wrong ?? 0),
    promptTokens: Number(r.promptTokens ?? 0), completionTokens: Number(r.completionTokens ?? 0),
    failures: Number(r.failures ?? 0),
  };
}

/** A random sample to read through - the daily human check the spec asks for. */
export function sample(db: Db, limit = 10, onlyUnreviewed = true) {
  ensureSchema(db);
  return db.all(
    `SELECT id, at, kind, symbol, question, answer, written_by, model, figures, ungrounded, rating, review
     FROM ai_generation ${onlyUnreviewed ? "WHERE reviewed_at IS NULL" : ""} ORDER BY RANDOM() LIMIT ?`, [limit]);
}
