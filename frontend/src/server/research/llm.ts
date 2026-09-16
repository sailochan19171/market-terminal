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
  groq: "openai/gpt-oss-120b",
};

const shape = (provider: string) => (provider === "anthropic" || provider === "gemini" ? provider : "openai");

/** Enough room for six bullets and, on a reasoning model, the thinking that precedes them. */
const MAX_TOKENS = 1800;
const REASONING = /gpt-oss|qwen3|deepseek-r1|reasoner|thinking/i;

export const SYSTEM = [
  "You are an equity research assistant for Indian listed companies (NSE and BSE).",
  "Answer only from the CONTEXT supplied with the question. Never add figures, dates or events that are not in it.",
  "If the context does not answer the question, say: 'The filings and figures on record do not answer that.'",
  "Be brief: at most six short bullet points, each with the figure and its period.",
  "Cite a source by the number in front of the context line it came from, in square brackets: [1], [2].",
  "Only ever cite numbers that appear in the context. Never invent a label such as [RISK] or [FAIR VALUE].",
  "A line marked COMPUTED HERE is this platform's own calculation: repeat it without a citation, and never attach another source's number to it.",
  "Write plain sentences. No markdown, no bold, no headings, no nested bullets.",
  "Never promise returns, never say guaranteed, and describe estimates as estimates.",
  "Never tell the reader to buy, sell or hold, and never give a price target: describe what the figures show and let them judge.",
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
      ? { model, max_tokens: MAX_TOKENS, system: SYSTEM, messages: [{ role: "user", content: prompt }] }
      : kind === "gemini"
        ? { systemInstruction: { parts: [{ text: SYSTEM }] }, contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: MAX_TOKENS } }
        : {
          model, max_tokens: MAX_TOKENS, temperature: 0.2,
          // Reasoning models spend the same budget thinking before they write, and a long research context can
          // use all of it, leaving the answer empty. Keep the thinking short; the reasoning is not shown anyway.
          ...(REASONING.test(model) ? { reasoning_effort: "low" } : {}),
          messages: [{ role: "system", content: SYSTEM }, { role: "user", content: prompt }],
        };

  const base = config.LLM_BASE_URL || ENDPOINTS[provider];
  if (!base) throw new Error(`LLM_PROVIDER=${provider} is not a known host; set LLM_BASE_URL to its OpenAI-compatible endpoint`);
  const url = kind === "gemini" ? `${base}/${model}:generateContent` : base;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (kind === "anthropic") Object.assign(headers, { "x-api-key": config.LLM_API_KEY, "anthropic-version": "2023-06-01" });
  else if (kind === "gemini") headers["x-goog-api-key"] = config.LLM_API_KEY;
  else headers.Authorization = `Bearer ${config.LLM_API_KEY}`;

  try {
    let res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(45_000) });
    // Free tiers meter tokens by the minute, and a research context is not small. The host says how long to
    // wait; waiting once is better than dropping the reader back to the written answer for a few seconds' burst.
    if (res.status === 429) {
      const wait = Math.min(Number(res.headers.get("retry-after") ?? 0) * 1000 || 4000, 12_000);
      log.warn(`rate limited by ${provider}; retrying in ${Math.round(wait / 1000)}s`);
      await new Promise((r) => setTimeout(r, wait));
      res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(45_000) });
    }
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    const data = JSON.parse(text);
    const answer = kind === "anthropic"
      ? data.content?.[0]?.text
      : kind === "gemini"
        ? data.candidates?.[0]?.content?.parts?.[0]?.text
        : data.choices?.[0]?.message?.content;
    if (typeof answer === "string" && answer.trim()) return answer.trim();
    // An empty answer is nearly always a budget that ran out mid-thought; say so rather than failing silently.
    const reason = data.choices?.[0]?.finish_reason ?? data.stop_reason ?? "unknown";
    log.warn(`${model} returned no text (finish reason: ${reason})${reason === "length" ? "; raise MAX_TOKENS or lower the reasoning effort" : ""}`);
    return null;
  } catch (e) {
    log.warn(`model call failed: ${(e as Error).message}`);
    return null;
  }
}
