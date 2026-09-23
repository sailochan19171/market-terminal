// The full trace of one request: every agent's input and output, in order (spec §10.3).
import { ApiError, db, handle, json, type Ctx } from "@/server/api/common";

export const GET = handle(async (_req: Request, ctx: Ctx<{ id: string }>) => {
  const id = (await ctx.params).id;
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new ApiError(400, "That is not a request id.", { error: "bad_request" });
  const d = db();
  if (!d.hasTable("agent_request")) throw new ApiError(404, "No traces recorded yet.", { error: "not_found" });
  const row = d.get<Record<string, unknown>>("SELECT * FROM agent_request WHERE request_id = ?", [id]);
  if (!row) throw new ApiError(404, "No trace for that request.", { error: "not_found" });
  const { result, ...request } = row;
  // The LangGraph nodes the request passed through, from the stored response.
  const stored = parse(result) as { path?: string[] } | null;
  const steps = d.all("SELECT seq, at, agent, stage, duration_ms, input, output FROM agent_trace WHERE request_id = ? ORDER BY seq", [id])
    .map((s) => ({ ...s, input: parse(s.input), output: parse(s.output) }));
  return json({ request, path: stored && typeof stored === "object" ? stored.path ?? [] : [], steps }, { shared: false });
});

function parse(v: unknown) {
  if (typeof v !== "string") return v ?? null;
  try {
    return JSON.parse(v);
  } catch {
    return v; // truncated at the size limit; shown as text
  }
}
