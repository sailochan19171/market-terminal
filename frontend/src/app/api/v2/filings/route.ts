import { filings } from "@/server/api/v2";
import { Args, db, handle, json } from "@/server/api/common";

export const GET = handle((req: Request) => json(filings(db(), Args.of(req))));
