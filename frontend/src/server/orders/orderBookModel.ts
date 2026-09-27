// Reading the order book off a slide, where the patterns cannot.
//
// A presentation is a deck, and a deck's text comes out of the PDF in the order the boxes were drawn, not the
// order a reader sees: "Current Order Book as experience in Ashoka Family st on 31 March 2026 construction
// ACUITE RATINGS 16,000 LANE Kms". The figure is in there, but so are three other numbers, and no pattern can
// tell which belongs to which label. A model can.
//
// It is given only the few hundred characters around each mention of an order book, never the whole deck, so a
// hundred-page presentation costs about as many tokens as a paragraph. What comes back is checked against the
// text it was given: a figure that is not in the excerpt is not used.
import { logger } from "../log";
import { chat } from "../research/llm";
import { settings } from "../agents/config";
import { readAsOf } from "./orderBook";

const log = logger("orders.orderbook.model");

/** The neighbourhood of every mention, capped so one deck cannot fill the prompt. */
export function excerpts(text: string, limit = 5): string[] {
  const flat = text.replace(/\s+/g, " ");
  const out: string[] = [];
  for (const m of flat.matchAll(/order\s*book/gi)) {
    const at = m.index ?? 0;
    out.push(flat.slice(Math.max(0, at - 160), at + 260).trim());
    if (out.length >= limit) break;
  }
  return out;
}

export interface ModelReading { valueCr: number; asOf: string | null; phrase: string }

/**
 * The order book the model finds in the excerpts, or null. Every reading is checked back against the text:
 * the digits it reports must appear in what it was shown, so a figure it has supplied from elsewhere - or
 * invented - cannot reach the database.
 */
export async function orderBookFromModel(text: string, company: string | null): Promise<ModelReading | null> {
  const parts = excerpts(text);
  if (!parts.length) return null;
  const shown = parts.join("\n---\n");
  const agent = settings().agents?.orderbook_agent;

  const reply = await chat({
    system: [
      "You read Indian investor presentations. The excerpts below are the text around each mention of an order book, taken out of a slide deck, so the words of different labels are mixed together.",
      "Find the company's total order book: the value of work it has won and not yet delivered.",
      "Copy the figure exactly as the deck writes it, digits and separators and all, and say which unit the deck states it in - crore, lakh, million, billion, or rupees. Do no arithmetic: the conversion is done here, from what you copied.",
      "Never report revenue, market capitalisation, a single order, a target, or a number from a chart axis. If the excerpts do not clearly state a total order book, say so.",
      'Return JSON only: {"as_written": "the figure exactly as printed, or null", "unit": "crore|lakh|million|billion|rupees|null", "as_on": "YYYY-MM-DD" or null, "quote": "the words you read it from"}.',
    ].join(" "),
    user: `COMPANY: ${company ?? "not named"}\n\nEXCERPTS\n${shown.slice(0, 4_000)}`,
    json: true,
    temperature: 0,
    maxTokens: 300,
    model: !agent?.model || agent.model === "small" ? undefined : agent.model,
    timeoutMs: agent?.timeoutMs ?? 30_000,
  });
  if (!reply.text) return null;

  let parsed: { as_written?: unknown; unit?: unknown; as_on?: unknown; quote?: unknown };
  try {
    parsed = JSON.parse(reply.text.replace(/^```(?:json)?|```$/g, "").trim());
  } catch {
    return null;
  }
  const written = typeof parsed.as_written === "string" ? parsed.as_written.trim() : "";
  if (!written) return null;

  // The figure must be in the text the model was shown, as a whole number and not as part of a longer one:
  // "1,82,180" contains "18,218", and a model that has quietly converted lakh to crore would otherwise pass.
  const bare = written.replace(/[^\d.]/g, "");
  if (!bare || !new RegExp(`(?<![\d.])${bare.replace(/\./g, "\.")}(?![\d])`).test(shown.replace(/,/g, ""))) {
    log.warn(`${company ?? "a company"}: the model reported "${written}", which is not in the excerpts it was shown`);
    return null;
  }

  // The arithmetic is done here, from the unit the deck stated - never by the model.
  const PER_CRORE: Record<string, number> = { crore: 1, cr: 1, lakh: 0.01, lac: 0.01, million: 0.1, mn: 0.1, billion: 100, bn: 100, rupees: 1e-7, rupee: 1e-7 };
  const unit = String(parsed.unit ?? "").toLowerCase().replace(/s$/, "").trim();
  const factor = PER_CRORE[unit];
  if (!factor) {
    log.warn(`${company ?? "a company"}: the model did not say what unit "${written}" is in`);
    return null;
  }
  const raw = Number(bare);
  if (!Number.isFinite(raw) || raw <= 0) return null;
  const valueCr = raw * factor;
  if (valueCr <= 0 || valueCr > 10_000_000) return null;

  const asOn = typeof parsed.as_on === "string" && /^\d{4}-\d{2}-\d{2}$/.test(parsed.as_on) ? parsed.as_on : readAsOf(shown);
  return { valueCr: Math.round(valueCr * 100) / 100, asOf: asOn, phrase: String(parsed.quote ?? "").slice(0, 130) || shown.slice(0, 130) };
}
