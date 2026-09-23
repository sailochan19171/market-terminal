// One question through the multi-agent graph (spec §2, §7.1 "streaming progress").
//
// POST { message, persona?, symbol?, market?, stream? }
//   stream: true  -> newline-delimited JSON: {"type":"step",...} as each agent starts and finishes, then
//                    {"type":"result","data":...}. The dashboard shows "Calculating ratios…" while it works.
//   stream: false -> the finished analysis as one JSON body.
// A load test can run the code path without a model (`model: "off"`), but only where AGENTS_ALLOW_NO_MODEL=1.
import { analyze } from "@/server/agents/graph";
import type { Market } from "@/server/agents/state";
import { ApiError, body, db, handle } from "@/server/api/common";

// The graph targets under 60 seconds (spec §7.3); give the platform the full minute.
export const maxDuration = 60;

interface Sent { message?: unknown; persona?: unknown; symbol?: unknown; market?: unknown; stream?: unknown; model?: unknown }

export const POST = handle(async (req: Request) => {
  const sent = await body<Sent>(req);
  const message = String(sent.message ?? "").trim().slice(0, 600);
  if (!message) throw new ApiError(400, "Ask a question about a company, for example \"Analyse Infosys\" or \"Analyse Apple\".", { error: "bad_request" });
  const personaId = typeof sent.persona === "string" ? sent.persona.slice(0, 40) : null;
  const symbol = typeof sent.symbol === "string" ? sent.symbol.slice(0, 30) : null;
  const market: Market | null = sent.market === "US" || sent.market === "IN" ? sent.market : null;
  const noModel = sent.model === "off" && process.env.AGENTS_ALLOW_NO_MODEL === "1";
  const chat = noModel ? async () => ({ text: null, model: "", promptTokens: null, completionTokens: null, latencyMs: 0, error: "model off for load testing" }) : undefined;
  const d = db();

  if (sent.stream !== true) {
    // One JSON body, but never silent: a proxy drops a connection that sends nothing for too long, and a busy
    // analysis can take tens of seconds. Leading whitespace is valid JSON, so a space every few seconds keeps it open.
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        const beat = setInterval(() => controller.enqueue(encoder.encode(" ")), 4_000);
        try {
          controller.enqueue(encoder.encode(JSON.stringify(await analyze(d, { message, personaId, symbol, market, chat }))));
        } catch (e) {
          controller.enqueue(encoder.encode(JSON.stringify({ error: "server_error", message: (e as Error).message })));
        } finally {
          clearInterval(beat);
          controller.close();
        }
      },
    });
    return new Response(body, { headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (v: unknown) => controller.enqueue(encoder.encode(`${JSON.stringify(v)}\n`));
      // Steps arrive often, but a long model call is quiet; a blank line every few seconds keeps proxies from closing it.
      const beat = setInterval(() => controller.enqueue(encoder.encode("\n")), 4_000);
      try {
        const data = await analyze(d, {
          message, personaId, symbol, market, chat,
          onStep: (s) => send({ type: "step", agent: s.agent, stage: s.stage, durationMs: s.durationMs, detail: s.detail ?? null }),
        });
        send({ type: "result", data });
      } catch (e) {
        send({ type: "error", message: (e as Error).message });
      } finally {
        clearInterval(beat);
        controller.close();
      }
    },
  });
  return new Response(stream, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no" } });
});
