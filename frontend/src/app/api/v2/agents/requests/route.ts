// Recent analysis requests, for the observability view (spec §7.1: trace every agent step). Questions are stored
// without personal data (spec §8.3): no user id, no IP, only the question, the persona and what ran.
//   GET ?limit=50&persona=buffett&status=passed|failed
import { Args, db, handle, json } from "@/server/api/common";

export const GET = handle((req: Request) => {
  const a = Args.of(req);
  const d = db();
  if (!d.hasTable("agent_request")) return json({ requests: [], summary: null }, { shared: false });
  const where: string[] = [];
  const args: (string | number)[] = [];
  const persona = a.str("persona");
  if (persona) { where.push("persona_id = ?"); args.push(persona); }
  if (a.str("status") === "failed") where.push("(passed = 0 OR errors != '[]')");
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const requests = d.all(
    `SELECT request_id, at, persona_id, symbol, intent, question, llm_calls, loops, passed, duration_ms, errors FROM agent_request ${clause} ORDER BY at DESC LIMIT ?`,
    [...args, a.int("limit", 50, 1, 200)]);
  const summary = d.get(
    `SELECT COUNT(*) AS requests, AVG(duration_ms) AS avg_ms, AVG(llm_calls) AS avg_llm_calls, SUM(CASE WHEN loops > 0 THEN 1 ELSE 0 END) AS with_loops,
            SUM(CASE WHEN passed = 0 THEN 1 ELSE 0 END) AS failed_validation, SUM(CASE WHEN errors != '[]' THEN 1 ELSE 0 END) AS with_errors
     FROM agent_request WHERE at >= datetime('now', '-7 days')`);
  // p95 of the last seven days, computed here so it works on SQLite and Turso alike.
  const durations = d.all<{ duration_ms: number }>("SELECT duration_ms FROM agent_request WHERE at >= datetime('now', '-7 days') AND duration_ms IS NOT NULL ORDER BY duration_ms").map((r) => r.duration_ms);
  const p95 = durations.length ? durations[Math.min(durations.length - 1, Math.floor(durations.length * 0.95))] : null;
  return json({ requests, summary: summary ? { ...summary, p95_ms: p95 } : null }, { shared: false });
});
