import { watch } from "@/server/api/market";
import { Args, db, handle, json } from "@/server/api/common";

export const GET = handle((req: Request) => json(watch(db(), Args.of(req))));
