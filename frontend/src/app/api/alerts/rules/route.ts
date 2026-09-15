import { alertRules } from "@/server/api/legacy";
import { db, handle, json } from "@/server/api/common";

export const GET = handle(() => json(alertRules(db())));
