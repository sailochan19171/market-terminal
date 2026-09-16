import { identityOr404 } from "@/server/api/company";
import { ask } from "@/server/research/answer";
import { ApiError, Args, body, db, handle, json, type Ctx } from "@/server/api/common";

const answer = async (ident: string, question: string) => {
  const d = db();
  const identity = identityOr404(d, decodeURIComponent(ident));
  if (!identity.symbol) throw new ApiError(422, "Research answers need NSE filings; this company is listed on BSE only.", { error: "no_data" });
  if (!question.trim()) throw new ApiError(400, "Ask a question about the company.", { error: "bad_request" });
  return json(await ask(d, identity.symbol, question.slice(0, 500)), { shared: false });
};

export const GET = handle(async (req: Request, ctx: Ctx<{ ident: string }>) => answer((await ctx.params).ident, Args.of(req).str("q")));
export const POST = handle(async (req: Request, ctx: Ctx<{ ident: string }>) => answer((await ctx.params).ident, String((await body<{ q?: string }>(req)).q ?? "")));
