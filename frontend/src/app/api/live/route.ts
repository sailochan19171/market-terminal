import { catalogue } from "@/server/nse/live";
import { handle, json } from "@/server/api/common";

export const GET = handle(() => json({ modules: catalogue() }));
