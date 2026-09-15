import { runScreen } from "@/server/api/v2";
import { body, db, handle, json } from "@/server/api/common";

export const POST = handle(async (req: Request) => json(runScreen(db(), await body(req))));
