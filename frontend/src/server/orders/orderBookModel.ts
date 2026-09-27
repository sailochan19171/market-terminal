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
      "Report it in crore rupees. A figure written as 1,854.14 Cr is 1854.14; one written in lakh or million must be converted; one written in rupees in full must be divided by ten million.",
      "Never report revenue, market capitalisation, a single order, a target, or a number from a chart axis. If the excerpts do not clearly state a total order book, say so.",
      'Return JSON only: {"order_book_cr": number or null, "as_on": "YYYY-MM-DD" or null, "quote": "the words you read it from"}.',
    ].join(" "),
    user: `COMPANY: ${company ?? "not named"}\n\nEXCERPTS\n${shown.slice(0, 4_000)}`,
    json: true,
    temperature: 0,
    maxTokens: 300,
    model: !agent?.model || agent.model === "small" ? undefined : agent.model,
    timeoutMs: agent?.timeoutMs ?? 30_000,
  });
  if (!reply.text) return null;

  let parsed: { order_book_cr?: unknown; as_on?: unknown; quote?: unknown };
  try {
    parsed = JSON.parse(reply.text.replace(/^```(?:json)?|```$/g, "").trim());
  } catch {
    return null;
  }
  const valueCr = typeof parsed.order_book_cr === "number" && Number.isFinite(parsed.order_book_cr) ? parsed.order_book_cr : null;
  if (valueCr === null || valueCr <= 0 || valueCr > 10_000_000) return null;

  // The digits must be in the text it was shown. A model that rounds 1,854.14 to 1,854 still passes, because
  // the check is on the digits before the decimal point, which is what a reader would recognise.
  const whole = Math.round(valueCr).toLocaleString("en-IN").replace(/,/g, "");
  const shownDigits = shown.replace(/,/g, "");
  if (!shownDigits.includes(whole) && !shownDigits.includes(String(Math.round(valueCr * 100) / 100))) {
    log.warn(`${company ?? "a company"}: the model reported ${valueCr} cr, which is not in the excerpts it was shown`);
    return null;
  }

  const asOn = typeof parsed.as_on === "string" && /^\d{4}-\d{2}-\d{2}$/.test(parsed.as_on) ? parsed.as_on : readAsOf(shown);
  return { valueCr: Math.round(valueCr * 100) / 100, asOf: asOn, phrase: String(parsed.quote ?? "").slice(0, 130) || shown.slice(0, 130) };
}
