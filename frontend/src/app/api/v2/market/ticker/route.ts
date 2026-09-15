import { ticker } from "@/server/api/market";
import { db, handle, json } from "@/server/api/common";

export const GET = handle(() => json(ticker(db())));
