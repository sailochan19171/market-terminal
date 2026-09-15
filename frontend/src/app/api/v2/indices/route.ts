import { indices } from "@/server/api/v2";
import { db, handle, json } from "@/server/api/common";

export const GET = handle(() => json(indices(db())));
