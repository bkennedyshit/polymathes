/**
 * Embedding adapter. Default: local Ollama with nomic-embed-text (768 dim).
 *
 * Design notes:
 * - Ollama's /api/embeddings returns {embedding: number[]}. We convert to
 *   Float32Array for cheap cosine ops in SemanticMemory.
 * - Batch is a simple fan-out of single calls. Ollama serializes internally
 *   but exposes the HTTP call per item; for true batch we'd wire an
 *   OpenAI-compat adapter for providers that support it (openai, mistral).
 *   Not worth it yet.
 * - Zero vector guard: if the backend 500s or returns an empty array, we
 *   return `null` instead of a zero vector. Callers MUST skip storage on
 *   null rather than write garbage that pollutes cosine similarity.
 */
export interface Embedder {
  /** Embed a single string. Returns null on failure — caller should skip store. */
  embed(text: string): Promise<Float32Array | null>;
  /** Embed many strings. Skips failures individually. */
  embedBatch(texts: string[]): Promise<Array<Float32Array | null>>;
  /** Dimensionality of the vectors this embedder produces. */
  readonly dim: number;
  /** Identifier for logging / audit. */
  readonly name: string;
}

export interface OllamaEmbedOpts {
  baseUrl?: string;     // http://host:port — NO /v1 suffix
  model?: string;
  dim?: number;
  timeoutMs?: number;
}

/** nomic-embed-text defaults to 768 dims. mxbai-embed-large is 1024. */
export class OllamaEmbedder implements Embedder {
  readonly name: string;
  readonly dim: number;
  private baseUrl: string;
  private model: string;
  private timeoutMs: number;

  constructor(opts: OllamaEmbedOpts = {}) {
    this.baseUrl = (opts.baseUrl ?? "http://localhost:11434").replace(/\/+$/, "");
    this.model = opts.model ?? "nomic-embed-text";
    this.dim = opts.dim ?? 768;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.name = `ollama:${this.model}`;
  }

  async embed(text: string): Promise<Float32Array | null> {
    if (!text?.trim()) return null;
    try {
      const res = await fetch(this.baseUrl + "/api/embeddings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: this.model, prompt: text }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!res.ok) return null;
      const data = (await res.json()) as { embedding?: number[] };
      if (!Array.isArray(data.embedding) || data.embedding.length === 0) return null;
      return new Float32Array(data.embedding);
    } catch {
      return null;
    }
  }

  async embedBatch(texts: string[]): Promise<Array<Float32Array | null>> {
    // Ollama doesn't batch natively — fan out with small concurrency.
    const CONC = 4;
    const out: Array<Float32Array | null> = new Array(texts.length).fill(null);
    let i = 0;
    async function worker(self: OllamaEmbedder) {
      while (true) {
        const idx = i++;
        if (idx >= texts.length) return;
        out[idx] = await self.embed(texts[idx]!);
      }
    }
    await Promise.all(Array.from({ length: CONC }, () => worker(this)));
    return out;
  }
}

/**
 * No-op embedder for dev / tests / when no local embedder is configured.
 * Returns null for every call, so callers that check for null skip storage
 * instead of writing zero vectors. Do NOT use in production — semantic
 * recall will always be empty.
 */
export class NullEmbedder implements Embedder {
  readonly name = "null";
  readonly dim: number;
  constructor(dim = 768) { this.dim = dim; }
  async embed(): Promise<Float32Array | null> { return null; }
  async embedBatch(texts: string[]): Promise<Array<Float32Array | null>> {
    return texts.map(() => null);
  }
}
