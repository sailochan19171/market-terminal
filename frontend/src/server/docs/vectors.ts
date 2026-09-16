// Embeddings for the document library - optional, and honest about being optional.
//
// Word search finds a passage that uses the reader's words; an embedding finds one that means the same thing in
// different words, which is what makes "how much did they borrow" reach a paragraph about term loans. It needs a
// provider that serves an embeddings endpoint (OpenAI, Gemini, Voyage, or anything OpenAI-compatible); Groq does
// not serve one, so with a Groq key alone the library still works on words and simply skips the re-ranking.
//
//   EMBED_PROVIDER=openai|gemini|custom   EMBED_API_KEY=...   EMBED_MODEL=...   EMBED_BASE_URL=...
import { config } from "../config";
import { logger } from "../log";

const log = logger("docs.vectors");

export const available = () => Boolean(config.EMBED_API_KEY);

const ENDPOINTS: Record<string, string> = {
  openai: "https://api.openai.com/v1/embeddings",
  gemini: "https://generativelanguage.googleapis.com/v1beta/models",
  voyage: "https://api.voyageai.com/v1/embeddings",
};

const DEFAULT_MODEL: Record<string, string> = {
  openai: "text-embedding-3-small",
  gemini: "text-embedding-004",
  voyage: "voyage-3-lite",
};

/** Vectors are stored as little-endian float32, which is what both ends of this file agree on. */
export const toBlob = (vec: number[]): Uint8Array => new Uint8Array(Float32Array.from(vec).buffer);

export const fromBlob = (blob: Uint8Array): number[] => {
  const copy = blob.byteOffset === 0 && blob.byteLength === blob.buffer.byteLength ? blob : blob.slice();
  return Array.from(new Float32Array(copy.buffer, copy.byteOffset, Math.floor(copy.byteLength / 4)));
};

/** Cosine similarity: 1 is the same direction, 0 unrelated. */
export function similarity(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

const BATCH = 64;

/** Embed a batch of passages. Throws when no key is configured - callers check `available()` first. */
export async function embed(texts: string[]): Promise<number[][]> {
  if (!available()) throw new Error("no EMBED_API_KEY configured");
  const provider = config.EMBED_PROVIDER;
  const model = config.EMBED_MODEL || DEFAULT_MODEL[provider] || DEFAULT_MODEL.openai;
  const out: number[][] = [];

  for (let i = 0; i < texts.length; i += BATCH) {
    const batch = texts.slice(i, i + BATCH).map((t) => t.slice(0, 8000));
    if (provider === "gemini") {
      const url = `${config.EMBED_BASE_URL || ENDPOINTS.gemini}/${model}:batchEmbedContents`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": config.EMBED_API_KEY },
        body: JSON.stringify({ requests: batch.map((text) => ({ model: `models/${model}`, content: { parts: [{ text }] } })) }),
        signal: AbortSignal.timeout(60_000),
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 160)}`);
      for (const e of JSON.parse(text).embeddings ?? []) out.push(e.values as number[]);
    } else {
      const url = config.EMBED_BASE_URL || ENDPOINTS[provider] || ENDPOINTS.openai;
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.EMBED_API_KEY}` },
        body: JSON.stringify({ model, input: batch }),
        signal: AbortSignal.timeout(60_000),
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 160)}`);
      for (const e of JSON.parse(text).data ?? []) out.push(e.embedding as number[]);
    }
  }
  if (out.length !== texts.length) {
    log.warn(`asked for ${texts.length} vectors and received ${out.length}`);
    throw new Error("the embedding service returned a different number of vectors than were asked for");
  }
  return out;
}
