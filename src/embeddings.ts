import { z } from 'zod';
import { modelReviewConfigSchema } from './model-review.js';

/**
 * Optional semantic layer: an embedding model, off unless configured.
 *
 * **Why it is off by default.** This project's retrieval is deliberately lexical: no vector store, no
 * external inference, explainable and offline. That was a *choice*, and it stays the default — an
 * unconfigured install behaves exactly as it did before this file existed, down to the bytes of
 * every receipt. What the peer comparison showed is that the choice costs something: systems with a
 * vector layer find paraphrases that no word-overlap can. So the layer is offered, not imposed.
 *
 * **Why it is derived data.** Embeddings are recomputable from the entries themselves, so they live
 * in their own table, are never exported as authority, and never block a write. A failed embedding
 * call degrades retrieval to lexical; it cannot fail an import, a candidate, or a turn.
 *
 * **What it is not.** Not a replacement for the lexical path and not a second opinion that silently
 * outvotes it: the two rankings are fused (reciprocal rank fusion), so an entry the index found stays
 * found, and the receipt says whether the vector half was used at all.
 */

/**
 * The endpoint rule is reused rather than restated: a model service may be remote only over HTTPS, or
 * local over HTTP. Two copies of that rule would eventually disagree about what "remote" means.
 */
export const embeddingConfigSchema = z.object({
  endpoint: modelReviewConfigSchema.shape.endpoint,
  model: z.string().min(1).max(200),
  apiKey: z.string().max(1000).optional(),
  timeoutMs: z.number().int().min(100).max(60000).default(15000),
}).strict();

export type EmbeddingConfig = z.input<typeof embeddingConfigSchema>;

/**
 * Where the configuration comes from: the core's own environment, and nowhere else.
 *
 * Absence is the switch. There is no "enabled: false" flag to get wrong, no config file to migrate,
 * and no way for a stray value to turn the layer on: both `endpoint` and `model` must be present, or
 * this returns null and every caller takes the lexical path.
 */
export function embeddingConfigFrom(env: NodeJS.ProcessEnv = process.env): EmbeddingConfig | null {
  const endpoint = env.AMB_EMBEDDING_ENDPOINT?.trim();
  const model = env.AMB_EMBEDDING_MODEL?.trim();
  if (!endpoint || !model) return null;
  const apiKey = env.AMB_EMBEDDING_KEY?.trim();
  return { endpoint, model, ...(apiKey ? { apiKey } : {}) };
}

/** One batch call. Returns null on any failure — the caller degrades, it does not retry here. */
export async function embedTexts(texts: string[], config: EmbeddingConfig, signal?: AbortSignal): Promise<number[][] | null> {
  const parsed = embeddingConfigSchema.safeParse(config);
  if (!parsed.success || !texts.length) return null;
  const cfg = parsed.data;
  try {
    const response = await fetch(`${cfg.endpoint.replace(/\/$/, '')}/embeddings`, {
      method: 'POST', redirect: 'error',
      signal: signal ?? AbortSignal.timeout(cfg.timeoutMs),
      headers: { 'Content-Type': 'application/json', ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}) },
      body: JSON.stringify({ model: cfg.model, input: texts }),
    });
    if (!response.ok) return null;
    const raw = await response.text();
    // A response larger than this is not an embedding batch; refusing it keeps a misconfigured
    // endpoint from turning into a memory event.
    if (raw.length > 8_000_000) return null;
    const envelope = JSON.parse(raw) as { data?: Array<{ embedding?: unknown }> };
    const vectors = envelope.data?.map(item => item.embedding);
    if (!Array.isArray(vectors) || vectors.length !== texts.length) return null;
    const cleaned: number[][] = [];
    for (const vector of vectors) {
      if (!Array.isArray(vector) || !vector.length || !vector.every(value => typeof value === 'number' && Number.isFinite(value))) return null;
      cleaned.push(vector as number[]);
    }
    // Every vector in a batch must share a dimension, or the similarity numbers are meaningless.
    const dims = cleaned[0]!.length;
    if (!cleaned.every(vector => vector.length === dims)) return null;
    return cleaned;
  } catch { return null; }
}

/** Vectors are stored as float32 blobs: half the bytes of JSON and no precision games. */
export function encodeVector(vector: number[]): Uint8Array {
  return new Uint8Array(Float32Array.from(vector).buffer);
}
export function decodeVector(blob: Uint8Array): number[] {
  const copy = new Uint8Array(blob.byteLength);
  copy.set(blob);
  return [...new Float32Array(copy.buffer)];
}

/** Cosine similarity; zero when either side is empty or degenerate rather than NaN. */
export function cosine(a: number[], b: number[]): number {
  if (!a.length || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let index = 0; index < a.length; index++) {
    dot += a[index]! * b[index]!;
    na += a[index]! * a[index]!;
    nb += b[index]! * b[index]!;
  }
  if (!na || !nb) return 0;
  return dot / Math.sqrt(na * nb);
}

/**
 * Reciprocal rank fusion, the same shape used to merge the two rankings.
 *
 * Rank-based on purpose: a cosine and an IDF-weighted lexical score are not on a comparable scale,
 * and normalising them against each other would make the fusion depend on the score distribution of
 * the moment. Ranks are already comparable — that is what a rank is.
 */
export const RRF_K = 60;
export function rrf(rank: number): number {
  return 1 / (RRF_K + rank);
}
