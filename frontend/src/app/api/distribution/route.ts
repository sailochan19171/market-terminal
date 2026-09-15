import { distribution } from "@/server/api/legacy";
import { Args, db, handle, json } from "@/server/api/common";

export const GET = handle((req: Request) => json(distribution(db(), Args.of(req))));
