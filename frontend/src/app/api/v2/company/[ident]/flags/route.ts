// Risk flags: pledging, promoter selling, auditor changes, insider disposals, leverage and regulatory action.
import { riskFlags } from "@/server/research/flags";
import { ApiError, db, handle, json, type Ctx } from "@/server/api/common";

export const GET = handle(async (_req: Request, ctx: Ctx<{ ident: string }>) => {
  const ident = decodeURIComponent((await ctx.params).ident);
  const out = riskFlags(db(), ident);
  if (!out) throw new ApiError(404, `No NSE or BSE company matches ${ident}.`, { error: "not_found" });
  return json(out, { shared: 900 });
});
