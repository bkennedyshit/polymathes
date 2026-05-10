import type { EpisodicMemory } from "./episodic.js";
import type { SemanticMemory } from "./semantic.js";

export interface HybridResult {
  id: string;
  content: string;
  score: number;
  source: "episodic" | "semantic";
}

export interface HybridOpts {
  episodic: EpisodicMemory;
  semantic: SemanticMemory;
  embedding?: Float32Array;
  weights?: { fts: number; cosine: number; recency: number };
  limit?: number;
}

export function hybridRecall(query: string, opts: HybridOpts): HybridResult[] {
  const { fts: wFts, cosine: wCos, recency: wRec } = opts.weights ?? { fts: 0.4, cosine: 0.4, recency: 0.2 };
  const limit = opts.limit ?? 10;
  const results = new Map<string, HybridResult>();

  // FTS results
  const ftsHits = opts.episodic.recall(query, limit * 2);
  const ftsMax = ftsHits.length;
  ftsHits.forEach((h, i) => {
    const recencyScore = 1 - i / Math.max(ftsMax, 1);
    const score = wFts * (1 - i / Math.max(ftsMax, 1)) + wRec * recencyScore;
    results.set(h.id, { id: h.id, content: h.content, score, source: "episodic" });
  });

  // Cosine results
  if (opts.embedding) {
    const cosHits = opts.semantic.recall(opts.embedding, limit * 2);
    for (const h of cosHits) {
      const existing = results.get(h.id);
      const cosScore = wCos * h.score;
      if (existing) {
        existing.score += cosScore;
      } else {
        results.set(h.id, { id: h.id, content: h.content, score: cosScore, source: "semantic" });
      }
    }
  }

  return [...results.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}
