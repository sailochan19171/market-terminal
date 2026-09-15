import { pulse } from "@/server/api/live";
import { handle, json } from "@/server/api/common";

export const GET = handle(async () => json(await pulse()));
