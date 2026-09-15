import { NSEClient } from "@/server/nse/client";
import { UnknownModule, fetch as fetchLive } from "@/server/nse/live";
import { Args, handle, json, type Ctx } from "@/server/api/common";

// One warmed-up NSE session shared by all live requests.
let client: NSEClient | null = null;

export const GET = handle(async (req: Request, ctx: Ctx<{ key: string }>) => {
  const { key } = await ctx.params;
  client ??= new NSEClient();
  try {
    return json(await fetchLive(client, key, Args.of(req).str("force") === "1"), { shared: 60 });
  } catch (e) {
    if (e instanceof UnknownModule) return json({ error: `unknown module '${key}'` }, { status: 404 });
    // A live feed being unavailable should not read as a broken page.
    return json({ error: (e as Error).message, key, rows: [], columns: [], count: 0 }, { status: 502 });
  }
});
