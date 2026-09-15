import { compare } from "@/server/api/company";
import { Args, db, handle, json } from "@/server/api/common";

export const GET = handle((req: Request) => json(compare(db(), Args.of(req))));
