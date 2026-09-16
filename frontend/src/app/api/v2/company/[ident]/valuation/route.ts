import { identityOr404 } from "@/server/api/company";
import { valuation } from "@/server/research/valuation";
import { ApiError, db, handle, json, type Ctx } from "@/server/api/common";

export const GET = handle(async (_req: Request, ctx: Ctx<{ ident: string }>) => {
  const d = db();
  const identity = identityOr404(d, decodeURIComponent((await ctx.params).ident));
  if (!identity.symbol) throw new ApiError(422, "Valuation needs NSE filings; this company is listed on BSE only.", { error: "no_data" });
  return json(valuation(d, identity.symbol));
});
