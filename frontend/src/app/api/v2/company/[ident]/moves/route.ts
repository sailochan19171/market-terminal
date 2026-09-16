// "Why is this stock moving?" - the last session's move and the filings that could account for it.
import { whyMoving } from "@/server/research/moves";
import { ApiError, Args, db, handle, json, type Ctx } from "@/server/api/common";

export const GET = handle(async (req: Request, ctx: Ctx<{ ident: string }>) => {
  const ident = decodeURIComponent((await ctx.params).ident);
  const windowHours = Args.of(req).int("hours", 72, 24, 168);
  const out = whyMoving(db(), ident, { windowHours });
  if (!out) throw new ApiError(404, `No NSE or BSE company matches ${ident}.`, { error: "not_found" });
  return json(out, { shared: 900 });
});
