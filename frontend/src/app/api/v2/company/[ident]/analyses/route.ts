import { companyAnalysesList, createAnalysis } from "@/server/api/company";
import { Args, body, db, handle, json, type Ctx } from "@/server/api/common";

export const GET = handle(async (req: Request, ctx: Ctx<{ ident: string }>) => json(companyAnalysesList(db(), decodeURIComponent((await ctx.params).ident), Args.of(req))));

export const POST = handle(async (req: Request, ctx: Ctx<{ ident: string }>) => {
  const { data, status } = createAnalysis(db(), decodeURIComponent((await ctx.params).ident), await body(req));
  return json(data, { status });
});
