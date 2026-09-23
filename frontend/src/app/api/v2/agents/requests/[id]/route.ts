// One stored analysis exactly as the reader saw it, so the dashboard can reopen it from its history.
import { ApiError, db, handle, json, type Ctx } from "@/server/api/common";

export const GET = handle(async (_req: Request, ctx: Ctx<{ id: string }>) => {
  const id = (await ctx.params).id;
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new ApiError(400, "That is not a request id.", { error: "bad_request" });
  const d = db();
  const row = d.hasTable("agent_request") ? d.get<{ result: string | null }>("SELECT result FROM agent_request WHERE request_id = ?", [id]) : null;
  if (!row?.result) throw new ApiError(404, "That analysis is not on record.", { error: "not_found" });
  return json(JSON.parse(row.result), { shared: false });
});
