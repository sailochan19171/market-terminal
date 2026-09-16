// Questions about one company, answered from its filings. POST carries the conversation so far, so a follow-up
// ("and its debt?") knows what it refers to.
import { identityOr404 } from "@/server/api/company";
import { ask, type Turn } from "@/server/research/answer";
import { ApiError, Args, body, db, handle, json, type Ctx } from "@/server/api/common";

const MAX_TURNS = 4;

/** Trust nothing from the wire: at most four turns, each trimmed. */
function turns(raw: unknown): Turn[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((t): t is { q?: unknown; a?: unknown } => Boolean(t) && typeof t === "object")
    .map((t) => ({ q: String(t.q ?? "").slice(0, 300), a: String(t.a ?? "").slice(0, 600) }))
    .filter((t) => t.q && t.a)
    .slice(-MAX_TURNS);
}

const answer = async (ident: string, question: string, history: Turn[]) => {
  const d = db();
  const identity = identityOr404(d, decodeURIComponent(ident));
  if (!identity.symbol) throw new ApiError(422, "Research answers need NSE filings; this company is listed on BSE only.", { error: "no_data" });
  if (!question.trim()) throw new ApiError(400, "Ask a question about the company.", { error: "bad_request" });
  return json(await ask(d, identity.symbol, question.slice(0, 500), { history }), { shared: false });
};

export const GET = handle(async (req: Request, ctx: Ctx<{ ident: string }>) => answer((await ctx.params).ident, Args.of(req).str("q"), []));

export const POST = handle(async (req: Request, ctx: Ctx<{ ident: string }>) => {
  const sent = await body<{ q?: string; history?: unknown }>(req);
  return answer((await ctx.params).ident, String(sent.q ?? ""), turns(sent.history));
});
