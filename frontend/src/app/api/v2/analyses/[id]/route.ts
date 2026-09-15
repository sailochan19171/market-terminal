import { analysisDetail } from "@/server/api/company";
import { ApiError, db, handle, json, type Ctx } from "@/server/api/common";

export const GET = handle(async (_req: Request, ctx: Ctx<{ id: string }>) => {
  const { id } = await ctx.params;
  if (!/^\d+$/.test(id)) throw new ApiError(404, `Analysis ${id} does not exist.`, { error: "not_found" });
  return json(analysisDetail(db(), Number(id)));
});
