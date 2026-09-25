// Every agent's input and output, recorded per request (spec §1 principle 5, §10.3 "full trace").
//
// Also the budget: at most 12 model calls per request (spec §3.2). A call past the budget does not happen - the
// agent that asked falls back to its rule-based path, and the trace says so.
import { randomUUID } from "node:crypto";
import type { Db } from "../db";
import { now } from "../db";
import { logger } from "../log";
import { config } from "../config";
import { backupHost, chat, outOfQuota, primaryHost, type ChatOptions, type Completion } from "../research/llm";
import { agentSetting, settings } from "./config";
import { digest, type StepDetail } from "./digest";
import type { AgentError } from "./state";

const log = logger("agents");

export const MAX_LLM_CALLS = 12;

/** The model, temperature, timeout and retries for one agent, from config/settings.yaml (spec §7.3). */
function tuned(agent: string, opts: ChatOptions): ChatOptions {
  const s = agentSetting(agent);
  const model = s.model === "small" ? settings().smallModels[config.LLM_PROVIDER] : s.model && s.model !== "default" ? s.model : undefined;
  // An explicitly set LLM_MODEL on a provider without a named small tier keeps every agent on that model.
  return {
    ...opts,
    model: opts.model ?? model,
    temperature: s.temperature ?? opts.temperature,
    timeoutMs: s.timeoutMs ?? opts.timeoutMs,
    maxRetries: s.maxRetries ?? opts.maxRetries,
    maxWaitMs: s.maxWaitMs ?? opts.maxWaitMs,
  };
}

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS agent_trace (
    request_id  TEXT NOT NULL,
    seq         INTEGER NOT NULL,
    at          TEXT NOT NULL,
    agent       TEXT NOT NULL,
    stage       TEXT NOT NULL,          -- start | done | error | llm
    duration_ms INTEGER,
    input       TEXT,                   -- JSON, truncated
    output      TEXT,                   -- JSON, truncated
    PRIMARY KEY (request_id, seq)
);
CREATE TABLE IF NOT EXISTS agent_request (
    request_id  TEXT PRIMARY KEY,
    at          TEXT NOT NULL,
    persona_id  TEXT NOT NULL,
    symbol      TEXT,
    intent      TEXT,
    question    TEXT,                   -- no personal data: the question only (spec §8.3)
    llm_calls   INTEGER DEFAULT 0,
    loops       INTEGER DEFAULT 0,
    passed      INTEGER,
    duration_ms INTEGER,
    errors      TEXT
);
CREATE INDEX IF NOT EXISTS ix_agent_request_at ON agent_request(at);
`;

export interface Step { agent: string; stage: string; at: string; durationMs: number | null; input?: unknown; output?: unknown; detail?: StepDetail | null }

const clip = (v: unknown, n = 20_000) => {
  if (v === undefined) return null;
  try {
    const s = JSON.stringify(v);
    return s.length > n ? `${s.slice(0, n)}…` : s;
  } catch {
    return null;
  }
};

export class Trace {
  readonly requestId = randomUUID();
  readonly steps: Step[] = [];
  readonly errors: AgentError[] = [];
  llmCalls = 0;

  /** `chatFn` replaces the model in tests (spec §10.1: graph integration with mocked LLMs). */
  /** When the response must be on its way (spec §7.3: under 60 s); model calls and steps shrink to fit. */
  deadline = Number.POSITIVE_INFINITY;

  constructor(private db: Db | null, private onStep?: (step: Step) => void, private chatFn?: (opts: ChatOptions) => Promise<Completion>) {}

  remainingMs() {
    return this.deadline - Date.now();
  }

  private write(step: Step) {
    // A readable account of the step for the workspace; the raw input and output stay in the trace.
    step.detail = digest(step.agent, step.stage, step.input, step.output);
    this.steps.push(step);
    this.onStep?.(step);
  }

  /** Run one agent step, record what went in and came out, and turn a failure into an AgentError (spec §6.5). */
  async run<T>(agent: string, input: unknown, fn: () => Promise<T> | T, opts: { timeoutMs?: number } = {}): Promise<T | null> {
    const started = Date.now();
    this.write({ agent, stage: "start", at: now(), durationMs: null, input });
    try {
      const work = Promise.resolve().then(fn);
      const limit = Math.max(1_000, Math.min(opts.timeoutMs ?? Number.POSITIVE_INFINITY, this.remainingMs()));
      let timer: ReturnType<typeof setTimeout> | undefined;
      const result = Number.isFinite(limit)
        ? await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out after ${Math.round(limit)} ms`)), limit); })])
          .finally(() => clearTimeout(timer))
        : await work;
      this.write({ agent, stage: "done", at: now(), durationMs: Date.now() - started, input, output: result });
      return result;
    } catch (e) {
      const message = (e as Error).message;
      this.errors.push({ agent, stage: "run", message, retryable: /timed out|fetch|ECONN|429/i.test(message), at: now() });
      this.write({ agent, stage: "error", at: now(), durationMs: Date.now() - started, output: { message } });
      log.warn(`${agent} failed: ${message}`);
      return null;
    }
  }

  /** Record a decision that is not itself an agent run - a loop-back, say. */
  note(agent: string, stage: string, output: unknown) {
    this.write({ agent, stage, at: now(), durationMs: null, output });
  }

  /** A model call, counted against the request's budget. */
  async llm(agent: string, raw: ChatOptions): Promise<Completion> {
    const tunedOpts = tuned(agent, raw);
    const remaining = this.remainingMs();
    if (remaining < 6_000) {
      const skipped: Completion = { text: null, model: "", promptTokens: null, completionTokens: null, latencyMs: 0, error: "time budget for this request used; written from the data" };
      this.write({ agent, stage: "llm", at: now(), durationMs: 0, output: skipped });
      return skipped;
    }
    // Fit the call inside what is left of the request, and do not sit out long rate-limit pauses.
    const opts: ChatOptions = {
      ...tunedOpts,
      timeoutMs: Math.min(tunedOpts.timeoutMs ?? 45_000, remaining - 3_000),
      maxRetries: remaining < 20_000 ? 0 : tunedOpts.maxRetries,
      // A free tier meters tokens by the minute, and the agent that writes the answer is worth waiting for:
      // a ten-second pause turns a rule-written answer into a written one. Never wait past the request's budget.
      maxWaitMs: Math.min(tunedOpts.maxWaitMs ?? 4_000, Math.max(0, remaining - 15_000)),
    };
    if (this.llmCalls >= Math.min(MAX_LLM_CALLS, settings().request.maxLlmCalls)) {
      const skipped: Completion = { text: null, model: "", promptTokens: null, completionTokens: null, latencyMs: 0, error: `budget of ${MAX_LLM_CALLS} model calls used` };
      this.write({ agent, stage: "llm", at: now(), durationMs: 0, output: skipped });
      return skipped;
    }
    // Every model this request may use, in order: the agent's own, then the provider's smaller tier, then its
    // spare models (each free tier meters every model separately), then a second provider if one is set up.
    // A model that has already said it is out of tokens for the day is stepped over rather than asked again.
    const small = settings().smallModels[config.LLM_PROVIDER];
    const backup = backupHost();
    const ladder: { host?: typeof backup; model?: string; label: string }[] = [
      { model: opts.model, label: opts.model ?? "the configured model" },
      ...(settings().fallbackToSmall && small && opts.model !== small ? [{ model: small, label: small }] : []),
      ...(settings().spareModels[config.LLM_PROVIDER] ?? []).filter((m) => m !== opts.model && m !== small).map((m) => ({ model: m, label: m })),
      ...(backup && !raw.host ? [{ host: backup, model: agentSetting(agent).model === "small" ? settings().smallModels[backup.provider] : backup.model, label: backup.provider }] : []),
    ];

    const fitted = () => Math.max(2_000, Math.min(opts.timeoutMs ?? 45_000, this.remainingMs() - 2_000));
    const budgetLeft = () => this.llmCalls < Math.min(MAX_LLM_CALLS, settings().request.maxLlmCalls);
    const RETRYABLE = /429|rate limit|quota|HTTP 5\d\d|fetch failed|timeout|aborted|no key/i;

    let result: Completion = { text: null, model: "", promptTokens: null, completionTokens: null, latencyMs: 0, error: "no model was asked" };
    for (const [i, step] of ladder.entries()) {
      const provider = step.host?.provider ?? config.LLM_PROVIDER;
      if (outOfQuota(provider, step.model)) {
        this.write({ agent, stage: "llm", at: now(), durationMs: 0, output: { text: null, model: step.label, error: "out of tokens for today", fellBackTo: ladder[i + 1]?.label ?? "the data" } });
        continue;
      }
      if (i > 0) {
        if (!budgetLeft() || this.remainingMs() < 5_000) break;
        this.write({ agent, stage: "llm", at: now(), durationMs: result.latencyMs, output: { text: null, model: result.model, error: result.error, fellBackTo: step.label } });
      }
      // Every attempt counts against the request's allowance, the first one included: a step down the ladder is
      // another call on another model, not a free retry.
      this.llmCalls++;
      result = await (this.chatFn ?? chat)({ ...opts, host: step.host ?? raw.host, model: step.model, timeoutMs: i > 0 ? fitted() : opts.timeoutMs });
      if (result.text || !RETRYABLE.test(result.error ?? "")) break;
    }

    this.write({
      agent, stage: "llm", at: now(), durationMs: result.latencyMs,
      input: { system: opts.system.slice(0, 400), user: opts.user.slice(0, 4000) },
      output: { text: result.text?.slice(0, 6000) ?? null, model: result.model, error: result.error, promptTokens: result.promptTokens, completionTokens: result.completionTokens },
    });
    return result;
  }

  /**
   * Write the whole trace in one batch. The hosted database client is synchronous, so writing each step as it
   * happened would stall the workers running in parallel.
   */
  finish(summary: { personaId: string; symbol: string | null; intent: string; question: string; loops: number; passed: boolean | null; startedAt: number; result?: unknown }) {
    if (!this.db) return;
    try {
      this.db.exec(SCHEMA);
      this.db.addColumns("agent_request", { result: "TEXT" });
      this.db.upsert("agent_trace", this.steps.map((step, i) => ({
        request_id: this.requestId, seq: i + 1, at: step.at, agent: step.agent, stage: step.stage,
        duration_ms: step.durationMs, input: clip(step.input), output: clip(step.output),
      })));
      this.db.upsert("agent_request", [{
        request_id: this.requestId, at: now(), persona_id: summary.personaId, symbol: summary.symbol, intent: summary.intent,
        question: summary.question.slice(0, 500), llm_calls: this.llmCalls, loops: summary.loops,
        passed: summary.passed === null ? null : summary.passed ? 1 : 0, duration_ms: Date.now() - summary.startedAt, errors: clip(this.errors, 4000),
        // What the reader was shown, so the dashboard can reopen an analysis and a reviewer can check it later.
        result: summary.result === undefined ? null : JSON.stringify(summary.result),
      }]);
    } catch (e) {
      log.warn(`trace write failed: ${(e as Error).message}`);
    }
  }
}

/** Pull the first JSON object out of a model reply, tolerating code fences and prose around it. */
export function parseJson<T = unknown>(text: string | null): T | null {
  if (!text) return null;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}
