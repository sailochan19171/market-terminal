import { indexDetail } from "@/server/api/v2";
import { Args, db, handle, json, type Ctx } from "@/server/api/common";

export const GET = handle(async (req: Request, ctx: Ctx<{ name: string[] }>) => {
  const { name } = await ctx.params;
  return json(indexDetail(db(), name.map(decodeURIComponent).join("/"), Args.of(req)));
});
