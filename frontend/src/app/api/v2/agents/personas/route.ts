// The personas on offer, read from config/personas/*.yaml (spec §3.9). The prompts stay on the server.
import { personas } from "@/server/agents/config";
import { handle, json } from "@/server/api/common";

export const GET = handle(() => json({
  personas: personas().map((p) => ({
    id: p.id, name: p.name, inspiredBy: p.inspiredBy, tagline: p.tagline, keyMetrics: p.keyMetrics,
    weights: p.weights, dcfGrowthCap: p.dcfGrowthCap, requiredMarginOfSafety: p.requiredMarginOfSafety,
  })),
}));
