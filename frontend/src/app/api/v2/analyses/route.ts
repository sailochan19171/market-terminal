import { analysesList } from "@/server/api/company";
import { Args, db, handle, json } from "@/server/api/common";

export const GET = handle((req: Request) => json(analysesList(db(), Args.of(req))));
