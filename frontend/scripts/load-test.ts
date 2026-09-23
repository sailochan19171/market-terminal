// Load test (spec §10.1): 50 concurrent requests, p95 under 60 s with a warm cache.
//
// Runs against a server (local or hosted). `--model off` measures the graph without a language model, which needs
// AGENTS_ALLOW_NO_MODEL=1 on the server; a free model tier cannot take 50 concurrent requests, so the model path is
// measured separately by scripts/eval-llm.ts.
//   npx tsx scripts/load-test.ts --base http://localhost:3000 --n 50 --model off
const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};

const BASE = arg("base", "http://localhost:3000");
const N = Number(arg("n", "50"));
const MODEL = arg("model", "on");
const QUESTIONS = ["Analyse RELIANCE.NS", "Analyse TCS", "Is HDFCBANK.NS's debt a concern?", "Analyse ITC", "Analyse INFY.NS", "Analyse Apple", "Analyse Microsoft", "Analyse NTPC", "Analyse Asian Paints", "Analyse Coca-Cola"];

async function one(message: string) {
  const started = Date.now();
  try {
    const res = await fetch(`${BASE}/api/v2/agents/analyze`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, persona: "buffett", stream: false, ...(MODEL === "off" ? { model: "off" } : {}) }),
      signal: AbortSignal.timeout(120_000),
    });
    const body = await res.json() as { status?: string; llmCalls?: number };
    return { ms: Date.now() - started, ok: res.ok && body.status === "answered", status: body.status ?? `HTTP ${res.status}`, llm: body.llmCalls ?? 0 };
  } catch (e) {
    return { ms: Date.now() - started, ok: false, status: (e as Error).message, llm: 0 };
  }
}

async function main() {
  console.log(`warming the cache: ${QUESTIONS.length} requests one at a time`);
  for (const q of QUESTIONS) await one(q);
  console.log(`firing ${N} concurrent requests at ${BASE} (model ${MODEL})`);
  const started = Date.now();
  const results = await Promise.all(Array.from({ length: N }, (_, i) => one(QUESTIONS[i % QUESTIONS.length])));
  const ms = results.map((r) => r.ms).sort((a, b) => a - b);
  const p = (q: number) => ms[Math.min(ms.length - 1, Math.floor(ms.length * q))];
  const failures = results.filter((r) => !r.ok);
  console.log(JSON.stringify({
    requests: N, wallSeconds: (Date.now() - started) / 1000, succeeded: N - failures.length,
    p50Seconds: p(0.5) / 1000, p95Seconds: p(0.95) / 1000, maxSeconds: ms.at(-1)! / 1000,
    failures: [...new Set(failures.map((f) => f.status))], modelCalls: results.reduce((s, r) => s + r.llm, 0),
  }, null, 2));
  const pass = p(0.95) < 60_000 && failures.length === 0;
  console.log(pass ? "PASS: p95 under 60 s, no failures" : "FAIL");
  process.exit(pass ? 0 : 1);
}

void main();

export {};
