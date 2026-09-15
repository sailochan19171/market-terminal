import { peers } from "@/server/api/v2";
import { db, handle, json, type Ctx } from "@/server/api/common";

export const GET = handle(async (_req: Request, ctx: Ctx<{ ident: string }>) => json(peers(db(), decodeURIComponent((await ctx.params).ident))));
