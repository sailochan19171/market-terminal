import { movers } from "@/server/api/legacy";
import { Args, db, handle, json } from "@/server/api/common";

export const GET = handle((req: Request) => json(movers(db(), Args.of(req))));
