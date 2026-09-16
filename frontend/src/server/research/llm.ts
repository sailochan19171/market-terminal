// Optional language model, used only to phrase an answer that has already been assembled from the data.
//
// The model never sees a question without the retrieved figures and filings, and it is instructed to answer
// from them alone. With no key configured the caller falls back to the written-out answer, so the feature
// degrades to plain sentences rather than disappearing.
import { config } from "../config";
import { logger } from "../log";

const log = logger("llm");

export const available = () => Boolean(config.LLM_API_KEY);

const ENDPOINTS = {
  anthropic: "https://api.anthropic.com/v1/messages",
  openai: "https://api.openai.com/v1/chat/completions",
  gemini: "https://generativelanguage.googleapis.com/v1beta/models",
};

export const SYSTEM = [
  "You are an equity research assistant for Indian listed companies (NSE and BSE).",
  "Answer only from the CONTEXT supplied with the question. Never add figures, dates or events that are not in it.",
  "If the context does not answer the question, say: 'The filings and figures on record do not answer that.'",
  "Be brief: at most six short bullet points, each with the figure and its period.",
  "Cite sources as [1], [2] matching the numbered context items.",
  "Never promise returns, never say guaranteed, and describe estimates as estimates.",
].join(" ");

/** Ask the configured model. Returns null when no key is set or the call fails. */
export async function complete(question: string, context: string): Promise<string | null> {
  if (!available()) return null;
  const provider = config.LLM_PROVIDER;
  const model = config.LLM_MODEL;
  const body: Record<string, unknown> =
    provider === "anthropic"
      ? { model, max_tokens: 700, system: SYSTEM, messages: [{ role: "user", content: `CONTEXT\n${context}\n\nQUESTION\n${question}` }] }
      : provider === "gemini"
        ? { systemInstruction: { parts: [{ text: SYSTEM }] }, contents: [{ role: "user", parts: [{ text: `CONTEXT\n${context}\n\nQUESTION\n${question}` }] }], generationConfig: { maxOutputTokens: 700 } }
        : { model, max_tokens: 700, messages: [{ role: "system", content: SYSTEM }, { role: "user", content: `CONTEXT\n${context}\n\nQUESTION\n${question}` }] };

  const url = provider === "gemini" ? `${ENDPOINTS.gemini}/${model}:generateContent` : ENDPOINTS[provider as "anthropic" | "openai"] ?? ENDPOINTS.anthropic;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (provider === "anthropic") Object.assign(headers, { "x-api-key": config.LLM_API_KEY, "anthropic-version": "2023-06-01" });
  else if (provider === "gemini") headers["x-goog-api-key"] = config.LLM_API_KEY;
  else headers.Authorization = `Bearer ${config.LLM_API_KEY}`;

  try {
    const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(45_000) });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    const data = JSON.parse(text);
    const answer = provider === "anthropic"
      ? data.content?.[0]?.text
      : provider === "gemini"
        ? data.candidates?.[0]?.content?.parts?.[0]?.text
        : data.choices?.[0]?.message?.content;
    return typeof answer === "string" && answer.trim() ? answer.trim() : null;
  } catch (e) {
    log.warn(`model call failed: ${(e as Error).message}`);
    return null;
  }
}
