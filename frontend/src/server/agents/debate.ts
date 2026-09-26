// The case for and the case against, argued separately before the persona writes.
//
// One writer reading one set of reports settles the argument in its own head and reports the conclusion. Two,
// each asked to make only one side of the case from the same figures, leave the disagreement visible - which is
// what a reader actually needs in order to judge. The pattern is the bull and bear researchers in the
// TradingAgents framework; here both sides are bound by this platform's own rules, so neither may name a figure
// the reports do not contain, and neither may tell the reader what to do.
//
// It costs two calls on the small model. When there is no model, or no budget left for it, the rule-based
// strengths and concerns stand in, so the section is always there.
import type { Persona } from "./config";
import { scrub } from "./compliance";
import type { Trace } from "./trace";
import { contradictions, ungroundedNumbers } from "./validator";
import { observations, type CompanyReports } from "./synthesis";

export interface Debate { bull: string[]; bear: string[]; writtenBy: "model" | "data" }

const SIDES = {
  bull: {
    ask: "Make the strongest honest case FOR this company as a long-term holding, from the FACTS alone.",
    note: "Do not soften a weakness by leaving it out - the other side is being argued separately - but this side argues the strengths.",
  },
  bear: {
    ask: "Make the strongest honest case AGAINST this company as a long-term holding, from the FACTS alone.",
    note: "Do not manufacture a problem the FACTS do not show; if a risk is small, say how small.",
  },
} as const;

const asList = (v: unknown) =>
  (Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : []).slice(0, 5);

/**
 * Both sides of the argument. `facts` is the same fact sheet the writer gets, so a point can always be traced
 * back to a report; `pool` is the set of numbers the reports contain, used to strip any figure that is not.
 */
export async function debate(
  trace: Trace,
  input: { persona: Persona; companies: CompanyReports[]; facts: string; pool: number[]; question: string },
): Promise<Debate> {
  const { persona, companies, facts, pool } = input;
  const names = companies.map((c) => c.raw.company ?? c.raw.symbol).join(" and ");

  // What the rules alone can say, used when no model answers - and as the floor for what the model must beat.
  const fromData = (): Debate => {
    const obs = companies.map((c) => observations(c, persona));
    return {
      bull: obs.flatMap((o) => o.strengths).slice(0, 5),
      bear: obs.flatMap((o) => o.concerns).slice(0, 5),
      writtenBy: "data",
    };
  };

  const argue = async (side: "bull" | "bear"): Promise<string[]> => {
    const reply = await trace.llm("debate_agent", {
      system: [
        `You are one of two analysts reading the same reports on ${names}. ${SIDES[side].ask}`,
        SIDES[side].note,
        "Every number you write must appear in the FACTS exactly as written there. Never calculate a new number and never estimate.",
        "Use the comparison words the FACTS give (above, below, in line with); never work out a direction yourself.",
        "Never tell the reader to buy, sell or hold, never give a price target, and never predict the price. Argue from what the figures show.",
        `Return JSON only: {"points": [3-5 sentences, each a separate point with its figure]}.`,
      ].join(" "),
      user: `QUESTION: ${input.question}\n\nFACTS\n${facts}`,
      json: true, temperature: 0.2, maxTokens: 700,
    });
    const parsed = reply.text ? (JSON.parse(reply.text.replace(/^```(?:json)?|```$/g, "").trim()) as { points?: unknown }) : null;
    const points = asList(parsed?.points);
    // The same checks the written analysis passes: a figure the reports do not hold, a backwards comparison, or
    // anything that reads as advice is dropped rather than shown.
    return points
      .map((p) => (ungroundedNumbers(p, pool).length || contradictions(p).length ? "" : scrub(p).text.trim()))
      .filter(Boolean);
  };

  try {
    const [bull, bear] = await Promise.all([argue("bull"), argue("bear")]);
    if (!bull.length && !bear.length) return fromData();
    const floor = fromData();
    return { bull: bull.length ? bull : floor.bull, bear: bear.length ? bear : floor.bear, writtenBy: "model" };
  } catch {
    return fromData();
  }
}
