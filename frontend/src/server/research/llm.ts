// Optional language model, used only to phrase an answer that has already been assembled from the data.
//
// The model never sees a question without the retrieved figures and filings, and it is instructed to answer
// from them alone. With no key configured the caller falls back to the written-out answer, so the feature
// degrades to plain sentences rather than disappearing.
import { config } from "../config";
import { logger } from "../log";

const log = logger("llm");

export const available = () => Boolean(config.LLM_API_KEY);

// Anthropic and Gemini have their own request shapes; everything else here speaks the OpenAI chat-completions
// dialect, so Groq, Together, OpenRouter, DeepSeek or a model on this machine all work by naming the provider
// (or by pointing LLM_BASE_URL at any other compatible host).
const ENDPOINTS: Record<string, string> = {
  anthropic: "https://api.anthropic.com/v1/messages",
  openai: "https://api.openai.com/v1/chat/completions",
  gemini: "https://generativelanguage.googleapis.com/v1beta/models",
  groq: "https://api.groq.com/openai/v1/chat/completions",
  together: "https://api.together.xyz/v1/chat/completions",
  openrouter: "https://openrouter.ai/api/v1/chat/completions",
  deepseek: "https://api.deepseek.com/chat/completions",
};

// Used when LLM_MODEL is not set. Providers rename models often, so set LLM_MODEL if the default is retired.
const DEFAULT_MODEL: Record<string, string> = {
  anthropic: "claude-sonnet-5",
  openai: "gpt-5.6-luna",
  gemini: "gemini-2.5-flash",
  groq: "llama-3.3-70b-versatile",
};

const shape = (provider: string) => (provider === "anthropic" || provider === "gemini" ? provider : "openai");

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
  const kind = shape(provider);
  const model = config.LLM_MODEL || DEFAULT_MODEL[provider] || DEFAULT_MODEL.openai;
  const prompt = `CONTEXT\n${context}\n\nQUESTION\n${question}`;
  const body: Record<string, unknown> =
    kind === "anthropic"
      ? { model, max_tokens: 700, system: SYSTEM, messages: [{ role: "user", content: prompt }] }
      : kind === "gemini"
        ? { systemInstruction: { parts: [{ text: SYSTEM }] }, contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: 700 } }
        : { model, max_tokens: 700, temperature: 0.2, messages: [{ role: "system", content: SYSTEM }, { role: "user", content: prompt }] };

  const base = config.LLM_BASE_URL || ENDPOINTS[provider];
  if (!base) throw new Error(`LLM_PROVIDER=${provider} is not a known host; set LLM_BASE_URL to its OpenAI-compatible endpoint`);
  const url = kind === "gemini" ? `${base}/${model}:generateContent` : base;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (kind === "anthropic") Object.assign(headers, { "x-api-key": config.LLM_API_KEY, "anthropic-version": "2023-06-01" });
  else if (kind === "gemini") headers["x-goog-api-key"] = config.LLM_API_KEY;
  else headers.Authorization = `Bearer ${config.LLM_API_KEY}`;

  try {
    const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(45_000) });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    const data = JSON.parse(text);
    const answer = kind === "anthropic"
      ? data.content?.[0]?.text
      : kind === "gemini"
        ? data.candidates?.[0]?.content?.parts?.[0]?.text
        : data.choices?.[0]?.message?.content;
    return typeof answer === "string" && answer.trim() ? answer.trim() : null;
  } catch (e) {
    log.warn(`model call failed: ${(e as Error).message}`);
    return null;
  }
}
