// Alert rules engine (BSE and NSE).
//
// A rule is a row in `alert_rule`: a name, a kind and a JSON params blob. Evaluating a rule yields hits;
// each carries a dedupe_key so the same event never fires twice (tracked in `alert_sent`).
//
// Kinds
//   announcement  {"keywords": [...], "symbols": [...], "categories": [...], "watchlist": "default", "lookback_hours": 24, "exchange": "bse"}
//   price_move    {"pct": 5.0, "symbols": [...], "watchlist": "default", "exchange": "bse"}
//   corp_action   {"purposes": ["Dividend","Bonus"], "within_days": 14, "symbols": [...], "watchlist": "default", "exchange": "bse"}
// `scrips` is accepted as a synonym for `symbols` (BSE scrip codes).
import { now, type Db, type Row } from "../db";
import { logger } from "../log";
import { addDays, placeholders, todayIso } from "../util";

const log = logger("rules");

export interface Hit {
  rule_name: string;
  dedupe_key: string;
  subject: string;
  body: string;
  meta: Row;
}

const EXCHANGES = {
  bse: {
    label: "BSE", key: "scrip_cd", master: "scrip", master_name: "COALESCE(scrip_name, scrip_id, scrip_cd)", prices: "bhavcopy",
    announcements: "announcement", ann_id: "news_id", ann_title: "headline", ann_dt: "news_dt", ann_extra: "category", ann_url: "pdf_url",
    actions: "corp_action",
  },
  nse: {
    label: "NSE", key: "symbol", master: "nse_symbol", master_name: "COALESCE(company, symbol)", prices: "nse_bhavcopy",
    announcements: "nse_announcement", ann_id: "ann_id", ann_title: "subject", ann_dt: "ann_dt", ann_extra: "details", ann_url: "pdf_url",
    actions: "nse_corp_action",
  },
};
type Spec = (typeof EXCHANGES)["bse"];

function spec(params: Row): Spec {
  const name = String(params.exchange || "bse").toLowerCase();
  if (name !== "bse" && name !== "nse") throw new Error(`unknown exchange '${name}'`);
  return EXCHANGES[name];
}

function watchlistMembers(db: Db, name: string | undefined, s: Spec): string[] {
  if (!name) return [];
  const sql = s.key === "scrip_cd"
    ? "SELECT scrip_cd AS k FROM watchlist WHERE name = ? AND scrip_cd IS NOT NULL AND UPPER(exchange) = 'BSE'"
    : "SELECT symbol AS k FROM watchlist WHERE name = ? AND symbol IS NOT NULL AND UPPER(exchange) = 'NSE'";
  return db.all<{ k: unknown }>(sql, [name]).map((r) => String(r.k));
}

function targets(db: Db, p: Row, s: Spec): string[] {
  const explicit: unknown[] = p.symbols || p.scrips || [];
  const out = [...explicit.map(String), ...watchlistMembers(db, p.watchlist, s)];
  return [...new Set(out)].sort();
}

function nameFor(db: Db, s: Spec, key: unknown): string {
  const v = db.scalar<string>(`SELECT ${s.master_name} FROM ${s.master} WHERE ${s.key} = ?`, [String(key)]);
  return v ? String(v) : String(key);
}

/** Naive local datetime, like the Python strptime formats; null when unparseable. */
function parseDt(value: unknown): Date | null {
  const m = String(value ?? "").trim().match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?)?$/);
  if (!m) return null;
  return new Date(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0));
}

const signed = (n: number) => `${n >= 0 ? "+" : "-"}${Math.abs(n).toFixed(2)}`;

function evalAnnouncement(db: Db, name: string, p: Row): Hit[] {
  const s = spec(p);
  const cutoff = Date.now() - Number(p.lookback_hours ?? 24) * 3600_000;
  const keywords = ((p.keywords ?? []) as string[]).map((k) => k.toLowerCase());
  const categories = ((p.categories ?? []) as string[]).map((c) => c.toLowerCase());
  const tg = new Set(targets(db, p, s));
  const rows = db.all(
    `SELECT ${s.ann_id} AS aid, ${s.key} AS akey, ${s.ann_title} AS title, ${s.ann_extra} AS extra, ${s.ann_dt} AS adt, ${s.ann_url} AS url `
    + `FROM ${s.announcements} ORDER BY ${s.ann_dt} DESC LIMIT 5000`);
  const hits: Hit[] = [];
  for (const r of rows) {
    const dt = parseDt(r.adt);
    if (dt && dt.getTime() < cutoff) continue;
    if (tg.size && !tg.has(String(r.akey))) continue;
    const haystack = `${r.title ?? ""} ${r.extra ?? ""}`.toLowerCase();
    if (keywords.length && !keywords.some((k) => haystack.includes(k))) continue;
    if (categories.length && !categories.some((c) => String(r.extra ?? "").toLowerCase().includes(c))) continue;
    const company = nameFor(db, s, r.akey);
    const lines = [`${company} (${s.label} ${r.akey})`, String(r.title ?? "")];
    if (r.adt) lines.push(`Filed: ${r.adt}`);
    if (r.url) lines.push(String(r.url));
    hits.push({ rule_name: name, dedupe_key: `ann:${s.label}:${r.aid}`, subject: `${s.label} filing: ${company}`, body: lines.join("\n"), meta: { exchange: s.label, key: r.akey } });
  }
  return hits;
}

function evalPriceMove(db: Db, name: string, p: Row): Hit[] {
  const s = spec(p);
  const threshold = Math.abs(Number(p.pct ?? 5));
  const tg = targets(db, p, s);
  const latest = db.scalar<string>(`SELECT MAX(trade_date) FROM ${s.prices}`);
  if (!latest) return [];
  let sql = `SELECT ${s.key} AS akey, close, prev_close FROM ${s.prices} WHERE trade_date = ? AND prev_close > 0 AND close IS NOT NULL`;
  const args: unknown[] = [latest];
  if (s.key === "symbol") sql += " AND series = 'EQ'"; // NSE bhavcopy carries other series too
  if (tg.length) {
    sql += ` AND ${s.key} IN (${placeholders(tg.length)})`;
    args.push(...tg);
  }
  const hits: Hit[] = [];
  for (const r of db.all(sql, args as never[])) {
    const pct = ((r.close - r.prev_close) / r.prev_close) * 100;
    if (Math.abs(pct) < threshold) continue;
    const company = nameFor(db, s, r.akey);
    hits.push({
      rule_name: name,
      dedupe_key: `move:${s.label}:${latest}:${r.akey}`,
      subject: `${company} ${pct > 0 ? "UP" : "DOWN"} ${Math.abs(pct).toFixed(2)}%`,
      body: [`${company} (${s.label} ${r.akey})`, `Close ${r.close.toFixed(2)} vs prev ${r.prev_close.toFixed(2)}  (${signed(pct)}%)`, `Date: ${latest}`].join("\n"),
      meta: { exchange: s.label, key: r.akey, pct },
    });
  }
  return hits;
}

function evalCorpAction(db: Db, name: string, p: Row): Hit[] {
  const s = spec(p);
  const within = Number.parseInt(String(p.within_days ?? 14), 10);
  const purposes = ((p.purposes ?? []) as string[]).map((x) => x.toLowerCase());
  const tg = new Set(targets(db, p, s));
  const today = todayIso();
  const horizon = addDays(today, within);
  const hits: Hit[] = [];
  for (const r of db.all(`SELECT ${s.key} AS akey, purpose, ex_date, record_date FROM ${s.actions} WHERE ex_date != '' ORDER BY ex_date`)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(r.ex_date ?? ""))) continue;
    if (r.ex_date < today || r.ex_date > horizon) continue;
    if (tg.size && !tg.has(String(r.akey))) continue;
    if (purposes.length && !purposes.some((x) => String(r.purpose ?? "").toLowerCase().includes(x))) continue;
    const company = nameFor(db, s, r.akey);
    const lines = [`${company} (${s.label} ${r.akey})`, String(r.purpose), `Ex-date: ${r.ex_date}`];
    if (r.record_date) lines.push(`Record date: ${r.record_date}`);
    hits.push({
      rule_name: name,
      dedupe_key: `ca:${s.label}:${r.akey}:${r.purpose}:${r.ex_date}`,
      subject: `Corporate action: ${company}`,
      body: lines.join("\n"),
      meta: { exchange: s.label, key: r.akey },
    });
  }
  return hits;
}

const EVALUATORS: Record<string, (db: Db, name: string, p: Row) => Hit[]> = {
  announcement: evalAnnouncement,
  price_move: evalPriceMove,
  corp_action: evalCorpAction,
};

export function addRule(db: Db, name: string, kind: string, params: Row) {
  if (!EVALUATORS[kind]) throw new Error(`unknown rule kind '${kind}'; known: ${Object.keys(EVALUATORS).join(", ")}`);
  spec(params);
  db.run("INSERT INTO alert_rule (name, kind, params, enabled, created_at) VALUES (?, ?, ?, 1, ?) "
    + "ON CONFLICT(name) DO UPDATE SET kind=excluded.kind, params=excluded.params", [name, kind, JSON.stringify(params), now()]);
}

export const listRules = (db: Db) => db.all("SELECT * FROM alert_rule ORDER BY name");

const CRITICAL_KEYWORDS = ["amalgamation", "merger", "acquisition", "open offer", "delisting", "buyback", "resignation of", "fraud", "insolvency", "default", "credit rating"];

const DEFAULT_RULES: [string, string, Row][] = [
  ["bse-big-movers", "price_move", { pct: 5.0, watchlist: "default", exchange: "bse" }],
  ["nse-big-movers", "price_move", { pct: 5.0, watchlist: "default", exchange: "nse" }],
  ["bse-watchlist-filings", "announcement", { watchlist: "default", lookback_hours: 24, exchange: "bse" }],
  ["nse-watchlist-filings", "announcement", { watchlist: "default", lookback_hours: 24, exchange: "nse" }],
  ["bse-upcoming-corp-actions", "corp_action", { watchlist: "default", within_days: 14, exchange: "bse" }],
  ["nse-upcoming-corp-actions", "corp_action", { watchlist: "default", within_days: 14, exchange: "nse" }],
  ["bse-critical-filings", "announcement", { lookback_hours: 24, keywords: CRITICAL_KEYWORDS, exchange: "bse" }],
  ["nse-critical-filings", "announcement", { lookback_hours: 24, keywords: CRITICAL_KEYWORDS, exchange: "nse" }],
];

export function seedDefaults(db: Db): number {
  for (const [name, kind, params] of DEFAULT_RULES) addRule(db, name, kind, params);
  return DEFAULT_RULES.length;
}

export function evaluate(db: Db, only?: string | null): Hit[] {
  const hits: Hit[] = [];
  for (const rule of listRules(db)) {
    if (!rule.enabled || (only && rule.name !== only)) continue;
    const fn = EVALUATORS[rule.kind];
    if (!fn) {
      log.warn(`rule ${rule.name} has unknown kind ${rule.kind}`);
      continue;
    }
    let params: Row;
    try {
      params = JSON.parse(rule.params);
    } catch {
      log.warn(`rule ${rule.name} has malformed params`);
      continue;
    }
    try {
      hits.push(...fn(db, rule.name, params));
    } catch (e) {
      log.error(`rule ${rule.name} failed: ${(e as Error).message}`);
    }
  }
  return hits;
}

export const unsent = (db: Db, hits: Hit[]) =>
  hits.filter((h) => !db.get("SELECT 1 FROM alert_sent WHERE rule_name = ? AND dedupe_key = ?", [h.rule_name, h.dedupe_key]));

export function markSent(db: Db, hit: Hit, channels: string[]) {
  db.run("INSERT OR REPLACE INTO alert_sent (rule_name, dedupe_key, sent_at, channel) VALUES (?, ?, ?, ?)", [hit.rule_name, hit.dedupe_key, now(), channels.join(",")]);
}
