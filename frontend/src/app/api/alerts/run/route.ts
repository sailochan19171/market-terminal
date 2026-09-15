import { alertsRun } from "@/server/api/legacy";
import { body, db, handle, json } from "@/server/api/common";

export const POST = handle(async (req: Request) => json(await alertsRun(db(), await body(req))));
