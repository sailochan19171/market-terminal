// The persona orchestrator (spec §3.2): turn the question into a research plan.
//
// The model picks from the registered workers only; the plan is checked against a schema, retried once with the
// validation error, and replaced by the default plan if it is still wrong. So a bad reply costs one extra call,
// never a broken request.
import type { Persona } from "./config";
import type { Intent, ResearchPlan, ResearchTask } from "./state";
import { parseJson, type Trace } from "./trace";

export const WORKERS = ["ratio_engine", "valuation_agent", "technical_agent", "news_moat_agent"] as const;
export type Worker = (typeof WORKERS)[number];

const CATEGORIES = ["profitability", "liquidity", "solvency", "efficiency", "valuation", "cashFlow", "growth", "dividends", "financial"];

export function defaultPlan(symbol: string, intent: Intent, persona: Persona): ResearchPlan {
  const tasks: ResearchTask[] = [
    { worker: "ratio_engine", focus: CATEGORIES, years: 10 },
    { worker: "valuation_agent", methods: ["dcf", "relative"] },
    { worker: "technical_agent", priority: persona.weights.technical < 0.1 ? "low" : "normal" },
  ];
  // A single ratio does not need a reading of the filings; a comparison does, or both sides are judged with an
  // empty qualitative score.
  if (intent === "full_analysis" || intent === "comparison") tasks.push({ worker: "news_moat_agent", questions: persona.researchQuestions.slice(0, 3) });
  return { symbol, tasks, reasoning: `Default ${intent.replace("_", " ")} plan for the ${persona.name} persona.`, plannedBy: "default" };
}

/** Check a plan against the schema; returns the problems, or none. */
export function checkPlan(value: unknown): { plan: Omit<ResearchPlan, "symbol" | "plannedBy"> | null; problems: string[] } {
  const problems: string[] = [];
  const v = value as { tasks?: unknown; reasoning?: unknown } | null;
  if (!v || typeof v !== "object") return { plan: null, problems: ["the reply is not a JSON object"] };
  if (!Array.isArray(v.tasks) || !v.tasks.length) return { plan: null, problems: ["\"tasks\" must be a non-empty array"] };
  const tasks: ResearchTask[] = [];
  for (const [i, t] of (v.tasks as Record<string, unknown>[]).entries()) {
    if (!t || typeof t !== "object") { problems.push(`task ${i} is not an object`); continue; }
    if (!WORKERS.includes(t.worker as Worker)) { problems.push(`task ${i}: "${String(t.worker)}" is not a registered worker (${WORKERS.join(", ")})`); continue; }
    const task: ResearchTask = { worker: String(t.worker) };
    if (t.focus !== undefined) {
      if (!Array.isArray(t.focus)) problems.push(`task ${i}: focus must be an array`);
      else task.focus = t.focus.map(String).filter((f) => CATEGORIES.includes(f));
    }
    if (t.questions !== undefined) {
      if (!Array.isArray(t.questions)) problems.push(`task ${i}: questions must be an array`);
      else task.questions = t.questions.map((q) => String(q).slice(0, 160)).slice(0, 4);
    }
    if (t.methods !== undefined && Array.isArray(t.methods)) task.methods = t.methods.map(String).filter((m) => ["dcf", "relative"].includes(m));
    if (t.years !== undefined) task.years = Math.min(10, Math.max(3, Number(t.years) || 10));
    if (t.priority !== undefined) task.priority = t.priority === "low" || t.priority === "high" ? t.priority : "normal";
    if (t.growth_cap !== undefined && typeof t.growth_cap === "number") task.growthSuggestion = t.growth_cap;
    tasks.push(task);
  }
  if (!tasks.some((t) => t.worker === "ratio_engine")) problems.push("the ratio_engine task is required: every analysis rests on it");
  return { plan: problems.length ? null : { tasks, reasoning: String(v.reasoning ?? "").slice(0, 400) }, problems };
}

export async function plan(trace: Trace, args: { question: string; symbol: string; company: string | null; intent: Intent; persona: Persona; metric: string | null }): Promise<ResearchPlan> {
  const { persona } = args;
  const system = [
    `You are the research orchestrator for an analysis inspired by the investing principles of ${persona.inspiredBy}.`,
    `Philosophy: ${persona.systemPrompt.replace(/\s+/g, " ").slice(0, 700)}`,
    `Key metrics for this persona: ${persona.keyMetrics.join(", ")}.`,
    `Choose which workers to run and what each must return. Registered workers - use no others: ${WORKERS.join(", ")}.`,
    "ratio_engine: {\"worker\":\"ratio_engine\",\"focus\":[categories from profitability, liquidity, solvency, efficiency, valuation, cashFlow, growth, dividends, financial],\"years\":10} - always required.",
    "valuation_agent: {\"worker\":\"valuation_agent\",\"methods\":[\"dcf\",\"relative\"]}.",
    "technical_agent: {\"worker\":\"technical_agent\",\"priority\":\"low\"|\"normal\"}.",
    "news_moat_agent: {\"worker\":\"news_moat_agent\",\"questions\":[up to 3 short research questions about moat, management and risks]} - costs a model call; skip it for a narrow question about one ratio.",
    "Return JSON only: {\"tasks\": [...], \"reasoning\": one sentence}. You plan; you never compute numbers.",
  ].join(" ");
  const user = `QUESTION: ${args.question}\nCOMPANY: ${args.company ?? args.symbol} (${args.symbol})\nINTENT: ${args.intent}${args.metric ? `\nMETRIC ASKED ABOUT: ${args.metric}` : ""}`;

  let reply = await trace.llm("orchestrator", { system, user, json: true, temperature: 0, maxTokens: 600 });
  if (!reply.text) return defaultPlan(args.symbol, args.intent, persona);
  let checked = checkPlan(parseJson(reply.text));
  if (!checked.plan) {
    // One retry with the validation error in the prompt (spec §8.2).
    reply = await trace.llm("orchestrator", {
      system, json: true, temperature: 0, maxTokens: 600,
      user: `${user}\n\nYour previous plan was rejected: ${checked.problems.join("; ")}. Return a corrected JSON plan.`,
    });
    checked = checkPlan(parseJson(reply.text));
  }
  if (!checked.plan) return { ...defaultPlan(args.symbol, args.intent, persona), reasoning: `The model's plan failed validation twice (${checked.problems.join("; ")}); the default plan was used.` };
  return { symbol: args.symbol, ...withCodeWorkers(checked.plan, args.intent, persona.researchQuestions), plannedBy: "model" };
}

/**
 * A full analysis, and a comparison, have all four reports (spec §2, step 4). The plan decides what each worker
 * focuses on and how much weight it carries, but may not leave one out: the code workers cost nothing, and
 * without the news and moat reading the qualitative score - a fifth to a quarter of every persona's weighting -
 * would be empty. A comparison was leaving it out, which is why two companies could be judged with a blank
 * qualitative score on both sides.
 */
export function withCodeWorkers<T extends { tasks: ResearchTask[]; reasoning: string }>(p: T, intent: Intent, questions: string[] = []): T {
  if (intent !== "full_analysis" && intent !== "comparison") return p;
  const added: string[] = [];
  const tasks = [...p.tasks];
  if (!tasks.some((t) => t.worker === "valuation_agent")) { tasks.push({ worker: "valuation_agent", methods: ["dcf", "relative"], priority: "low" }); added.push("valuation_agent"); }
  if (!tasks.some((t) => t.worker === "technical_agent")) { tasks.push({ worker: "technical_agent", priority: "low" }); added.push("technical_agent"); }
  if (!tasks.some((t) => t.worker === "news_moat_agent")) { tasks.push({ worker: "news_moat_agent", questions: questions.slice(0, 3) }); added.push("news_moat_agent"); }
  return { ...p, tasks, reasoning: added.length ? `${p.reasoning} (${added.join(", ")} added: ${intent === "comparison" ? "a comparison" : "a full analysis"} carries all four reports.)` : p.reasoning };
}
