import { watchlistAdd, watchlistGet, watchlistRemove } from "@/server/api/legacy";
import { Args, body, db, handle, json } from "@/server/api/common";

const listName = (req: Request) => Args.of(req).str("name") || "default";

export const GET = handle((req: Request) => json(watchlistGet(db(), listName(req)), { shared: false }));
export const POST = handle(async (req: Request) => json(watchlistAdd(db(), listName(req), await body(req))));
export const DELETE = handle(async (req: Request) => json(watchlistRemove(db(), listName(req), await body(req))));
