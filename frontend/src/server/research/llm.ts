// Optional language model, used only to phrase an answer that has already been assembled from the data.
//
// The model never sees a question without the retrieved figures and filings, and it is instructed to answer
// from them alone. With no key configured the caller falls back to the written-out answer, so the feature
// degrades to plain sentences rather than disappearing.
import { config } from "../config";
import { logger } from "../log";

const log = logger("llm");

/** One model host: which provider, its key, and optionally a model and endpoint of its own. */
export interface Host { provider: string; key: string; model?: string; baseUrl?: string }

export const primaryHost = (): Host => ({ provider: config.LLM_PROVIDER, key: config.LLM_API_KEY, model: config.LLM_MODEL || undefined, baseUrl: config.LLM_BASE_URL || undefined });
/** The host to switch to when the primary is rate-limited, out of quota or unreachable; null when none is set. */
export const backupHost = (): Host | null =>
  config.LLM_BACKUP_PROVIDER && config.LLM_BACKUP_API_KEY ? { provider: config.LLM_BACKUP_PROVIDER, key: config.LLM_BACKUP_API_KEY, model: config.LLM_BACKUP_MODEL || undefined } : null;

export const available = () => Boolean(config.LLM_API_KEY || backupHost());

/**
 * A host that has spent its daily allowance says so plainly, and will keep saying so until the allowance
 * resets. Remembering that for a while saves every later call the wait, the retries and the timeout it would
 * otherwise spend finding out again - which is the difference between the backup answering in time and not.
 */
const spentUntil = new Map<string, number>();
const DAILY_LIMIT = /per day|\bTPD\b|\bRPD\b|daily/i;
const REMEMBER_MS = 30 * 60_000;

// Each model is metered on its own, so one model running dry says nothing about the next: only the model that
// reported the limit is stepped over, which is what makes a ladder of models worth having.
export const outOfQuota = (provider: string, model?: string) => Date.now() < (spentUntil.get(`${provider}:${model ?? ""}`) ?? 0);

const rememberSpent = (provider: string, model: string) => spentUntil.set(`${provider}:${model}`, Date.now() + REMEMBER_MS);

// Anthropic and Gemini have their own request shapes; everything else here speaks the OpenAI chat-completions
// dialect, so Groq, Together, OpenRouter, DeepSeek or a model on this machine all work by naming the provider
// (or by pointing LLM_BASE_URL at any other compatible host).
const ENDPOINTS: Record<string, string> = {
  anthropic: "https://api.anthropic.com/v1/messages",
  openai: "https://api.openai.com/v1/chat/completions",
  gemini: "https://generativelanguage.googleapis.com/v1beta/models",
  groq: "https://api.groq.com/openai/v1/chat/completions",
  cerebras: "https://api.cerebras.ai/v1/chat/completions",
  together: "https://api.together.xyz/v1/chat/completions",
  openrouter: "https://openrouter.ai/api/v1/chat/completions",
  deepseek: "https://api.deepseek.com/chat/completions",
};

// Used when LLM_MODEL is not set. Providers rename models often, so set LLM_MODEL if the default is retired.
const DEFAULT_MODEL: Record<string, string> = {
  anthropic: "claude-sonnet-5",
  openai: "gpt-5.6-luna",
  gemini: "gemini-2.5-flash",   // the newer flash models need a paid plan; this one has a free allowance
  groq: "openai/gpt-oss-120b",
  cerebras: "gpt-oss-120b",
};

const shape = (provider: string) => (provider === "anthropic" || provider === "gemini" ? provider : "openai");

/** Enough room for six bullets and, on a reasoning model, the thinking that precedes them. */
const MAX_TOKENS = 1800;
const REASONING = /gpt-oss|qwen3|deepseek-r1|reasoner|thinking/i;

export const SYSTEM = [
  "You are the research assistant on Market Terminal, a site built on companies' own filings to NSE and BSE.",
  "Talk like a person: answer the message in front of you, in plain sentences, and carry the conversation forward.",
  "If the reader greets you or asks what you are, reply briefly and naturally and say what you can look up. Do not recite figures at them.",
  "If they ask something you have no material for, say so in one sentence and offer what you do have. Never pad a refusal with unrelated figures.",
  "When they follow up - \"and its debt?\", \"why?\" - read the earlier turns and answer about the same company and period.",
  "Answer only from the CONTEXT supplied with the question. Never add figures, dates or events that are not in it.",
  "This platform holds filings only for companies listed on NSE or BSE in India, about 3,400 of them.",
  "If the reader asks about a company you have no context for - one listed abroad, say, or a private business - tell them plainly that it is not covered here because it does not file with NSE or BSE, and say which company you do have in front of you.",
  "If the context does not answer the question about the company in view, say what is missing in one sentence and offer the closest thing you do have.",
  "Answer the question that was asked, not a general summary of the company.",
  "Begin with one sentence that answers it directly. Then at most five short supporting points, each with its figure and period.",
  "Cite a source by the number in front of the context line it came from, in square brackets: [1], [2].",
  "Only ever cite numbers that appear in the context. Never invent a label such as [RISK] or [FAIR VALUE].",
  "A line marked COMPUTED HERE is this platform's own calculation: repeat it without a citation, and never attach another source's number to it.",
  "Write plain sentences. No markdown, no bold, no headings, no nested bullets.",
  "Never promise returns, never say guaranteed, and describe estimates as estimates.",
  "Never tell the reader to buy, sell or hold, and never give a price target: describe what the figures show and let them judge.",
].join(" ");

/** What a call cost and what it produced, for the audit record and the cost metric. */
export interface Completion {
  text: string | null;
  model: string;
  promptTokens: number | null;
  completionTokens: number | null;
  latencyMs: number;
  error?: string;
}

/** Ask the configured model. `text` is null when no key is set or the call fails; the rest still describes it. */
export async function complete(question: string, context: string): Promise<Completion> {
  return chat({ system: SYSTEM, user: `CONTEXT\n${context}\n\nQUESTION\n${question}` });
}

export interface ChatOptions {
  system: string;
  user: string;
  /** Ask for a JSON object back (JSON mode where the host supports it). */
  json?: boolean;
  temperature?: number;
  maxTokens?: number;
  /** A different model from the configured default - the agents use a small one for simple jobs. */
  model?: string;
  timeoutMs?: number;
  /** Retries on rate limits, server errors and dropped connections, with exponential backoff. */
  maxRetries?: number;
  /** The longest rate-limit pause worth waiting for; past it the call returns so the caller can try elsewhere. */
  maxWaitMs?: number;
  /** Call this host instead of the configured primary. */
  host?: Host;
}

/** One call to the configured model with any system prompt - what the agents use. */
export async function chat(opts: ChatOptions): Promise<Completion> {
  const startedAt = Date.now();
  const host = opts.host ?? primaryHost();
  if (!host.key) return { text: null, model: "", promptTokens: null, completionTokens: null, latencyMs: 0, error: "no key configured" };
  const provider = host.provider;
  const kind = shape(provider);
  const model = opts.model || host.model || DEFAULT_MODEL[provider] || DEFAULT_MODEL.openai;
  const SYSTEM = opts.system;
  const prompt = opts.user;
  const maxTokens = opts.maxTokens ?? MAX_TOKENS;
  const body: Record<string, unknown> =
    kind === "anthropic"
      ? { model, max_tokens: maxTokens, temperature: opts.temperature ?? 0.2, system: SYSTEM, messages: [{ role: "user", content: prompt }] }
      : kind === "gemini"
        ? {
          systemInstruction: { parts: [{ text: SYSTEM }] }, contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: { maxOutputTokens: maxTokens, temperature: opts.temperature ?? 0.2, ...(opts.json ? { responseMimeType: "application/json" } : {}) },
        }
        : {
          model, max_tokens: maxTokens, temperature: opts.temperature ?? 0.2,
          // Reasoning models spend the same budget thinking before they write, and a long research context can
          // use all of it, leaving the answer empty. Keep the thinking short; the reasoning is not shown anyway.
          ...(REASONING.test(model) ? { reasoning_effort: "low" } : {}),
          ...(opts.json ? { response_format: { type: "json_object" } } : {}),
          messages: [{ role: "system", content: SYSTEM }, { role: "user", content: prompt }],
        };

  const done = (text: string | null, usage?: { prompt_tokens?: number; completion_tokens?: number }, error?: string): Completion => ({
    text, model,
    promptTokens: usage?.prompt_tokens ?? null,
    completionTokens: usage?.completion_tokens ?? null,
    latencyMs: Date.now() - startedAt,
    error,
  });

  const base = host.baseUrl || ENDPOINTS[provider];
  if (!base) throw new Error(`LLM_PROVIDER=${provider} is not a known host; set LLM_BASE_URL to its OpenAI-compatible endpoint`);
  const url = kind === "gemini" ? `${base}/${model}:generateContent` : base;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (kind === "anthropic") Object.assign(headers, { "x-api-key": host.key, "anthropic-version": "2023-06-01" });
  else if (kind === "gemini") headers["x-goog-api-key"] = host.key;
  else headers.Authorization = `Bearer ${host.key}`;

  try {
    const timeout = opts.timeoutMs ?? 45_000;
    const retries = opts.maxRetries ?? 1;
    let res: Response | null = null;
    for (let attempt = 0; ; attempt++) {
      try {
        res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(timeout) });
      } catch (e) {
        if (attempt >= retries) throw e;
        const wait = 1000 * 2 ** attempt;
        log.warn(`${provider} request failed (${(e as Error).message}); retrying in ${wait / 1000}s`);
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      // Free tiers meter tokens by the minute. The host says how long to wait; otherwise back off exponentially.
      if ((res.status === 429 || res.status >= 500) && attempt < retries) {
        // A daily quota does not come back in twelve seconds; waiting only makes the reader wait.
        if (res.status === 429) {
          const peek = await res.clone().text().catch(() => "");
          if (DAILY_LIMIT.test(peek)) {
            rememberSpent(provider, model);
            break;
          }
        }
        // How long to wait: the header if the host sets one, otherwise the delay it names in the body (Gemini
        // answers "Please retry in 22.1s" and means it - coming back in two seconds only spends another request
        // against the same per-minute limit), and failing both, a doubling back-off.
        const body = res.status === 429 ? await res.clone().text().catch(() => "") : "";
        const asked = Number(body.match(/retry in (\d+(?:\.\d+)?)s/i)?.[1] ?? body.match(/"retryDelay":\s*"(\d+(?:\.\d+)?)s"/)?.[1] ?? 0) * 1000;
        const wait = Math.min(Number(res.headers.get("retry-after") ?? 0) * 1000 || asked || 2000 * 2 ** attempt, 30_000);
        // A long wait costs more than it saves: with many jobs running, the caller does better switching to another
        // model tier at once. Only short pauses are sat out.
        if (res.status === 429 && wait > (opts.maxWaitMs ?? 12_000)) break;
        log.warn(`${res.status === 429 ? "rate limited" : `HTTP ${res.status}`} by ${provider}; retrying in ${Math.round(wait / 1000)}s`);
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      break;
    }
    const text = await res.text();
    if (res.status === 429 && DAILY_LIMIT.test(text)) rememberSpent(provider, model);
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    const data = JSON.parse(text);
    const answer = kind === "anthropic"
      ? data.content?.[0]?.text
      : kind === "gemini"
        ? data.candidates?.[0]?.content?.parts?.[0]?.text
        : data.choices?.[0]?.message?.content;
    const usage = data.usage ?? data.usageMetadata;
    if (typeof answer === "string" && answer.trim()) return done(answer.trim(), usage);
    // An empty answer is nearly always a budget that ran out mid-thought; say so rather than failing silently.
    const reason = data.choices?.[0]?.finish_reason ?? data.stop_reason ?? "unknown";
    log.warn(`${model} returned no text (finish reason: ${reason})${reason === "length" ? "; raise MAX_TOKENS or lower the reasoning effort" : ""}`);
    return done(null, usage, `empty reply (${reason})`);
  } catch (e) {
    log.warn(`model call failed: ${(e as Error).message}`);
    return done(null, undefined, (e as Error).message);
  }
}
