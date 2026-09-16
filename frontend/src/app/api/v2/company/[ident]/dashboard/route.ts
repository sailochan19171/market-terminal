import { dashboard } from "@/server/api/company";
import { Args, db, handle, json, type Ctx } from "@/server/api/common";

export const GET = handle(async (req: Request, ctx: Ctx<{ ident: string }>) => {
  const { data, cache } = await dashboard(db(), decodeURIComponent((await ctx.params).ident), Args.of(req));
  return json(data, { cache });
});
