import { documents } from "@/server/api/company";
import { Args, db, handle, json, type Ctx } from "@/server/api/common";

export const GET = handle(async (req: Request, ctx: Ctx<{ ident: string }>) => json(documents(db(), decodeURIComponent((await ctx.params).ident), Args.of(req))));
