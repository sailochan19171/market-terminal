// The compiled LangGraph (spec §2, Figure 1): its nodes and edges, and the same graph as Mermaid.
import { agentGraph, graphDiagram } from "@/server/agents/graph";
import { handle, json } from "@/server/api/common";

export const GET = handle(async () => {
  const g = await agentGraph.getGraphAsync();
  return json({
    engine: "LangGraph.js",
    nodes: Object.keys(g.nodes),
    edges: g.edges.map((e) => ({ source: e.source, target: e.target, conditional: Boolean(e.conditional) })),
    mermaid: await graphDiagram(),
  });
});
