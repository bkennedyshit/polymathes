import type Database from "better-sqlite3";
import { ulid } from "ulid";

export interface SemanticEntry {
  id: string;
  content: string;
  embedding: Buffer;
  source_session: string | null;
  created_at: string;
  pinned: number;
}

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

export class SemanticMemory {
  constructor(private db: Database.Database) {}

  store(content: string, embedding: Float32Array, sourceSession?: string): string {
    const id = ulid();
    const buf = Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
    this.db
      .prepare(
        `INSERT INTO semantic (id, content, embedding, source_session) VALUES (?, ?, ?, ?)`
      )
      .run(id, content, buf, sourceSession ?? null);
    return id;
  }

  recall(queryEmbedding: Float32Array, limit = 5): Array<{ id: string; content: string; score: number }> {
    const rows = this.db
      .prepare(`SELECT id, content, embedding FROM semantic WHERE pinned = 0 OR pinned = 1`)
      .all() as Array<{ id: string; content: string; embedding: Buffer }>;

    return rows
      .map((r) => {
        const stored = new Float32Array(r.embedding.buffer, r.embedding.byteOffset, r.embedding.byteLength / 4);
        return { id: r.id, content: r.content, score: cosine(queryEmbedding, stored) };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  pin(id: string): void {
    this.db.prepare(`UPDATE semantic SET pinned = 1 WHERE id = ?`).run(id);
  }

  forget(id: string): void {
    this.db.prepare(`DELETE FROM semantic WHERE id = ?`).run(id);
  }
}
