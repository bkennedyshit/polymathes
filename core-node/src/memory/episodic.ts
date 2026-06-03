import type Database from "better-sqlite3";
import { ulid } from "ulid";

export interface EpisodicEntry {
  id: string;
  session_id: string;
  role: string;
  content: string;
  tool_name?: string;
  tool_args?: string;
  tool_result?: string;
  created_at: string;
}

export class EpisodicMemory {
  constructor(private db: Database.Database) {}

  store(
    sessionId: string,
    role: string,
    content: string,
    toolName?: string,
    toolArgs?: string,
    toolResult?: string
  ): string {
    const id = ulid();
    this.db
      .prepare(
        `INSERT INTO episodic (id, session_id, role, content, tool_name, tool_args, tool_result)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(id, sessionId, role, content, toolName ?? null, toolArgs ?? null, toolResult ?? null);
    return id;
  }

  recall(query: string, limit = 10): EpisodicEntry[] {
    const matchQuery = buildFtsMatchQuery(query);
    if (!matchQuery) return [];
    return this.db
      .prepare(
        `SELECT e.* FROM episodic e
         JOIN episodic_fts f ON f.rowid = e.rowid
         WHERE episodic_fts MATCH ?
           AND e.compressed_at IS NULL
         ORDER BY rank
         LIMIT ?`
      )
      .all(matchQuery, limit) as EpisodicEntry[];
  }

  recallBySession(sessionId: string, limit = 50, opts: { includeCompressed?: boolean } = {}): EpisodicEntry[] {
    const compressedFilter = opts.includeCompressed ? "" : "AND compressed_at IS NULL";
    // Return the latest N messages, then restore chronological order for
    // display/model context. Returning the oldest N made long sessions forget
    // the user's most recent steps.
    return this.db
      .prepare(
        `SELECT * FROM (
           SELECT episodic.*, rowid AS memory_rowid FROM episodic
           WHERE session_id = ? ${compressedFilter}
           ORDER BY created_at DESC, rowid DESC
           LIMIT ?
         ) ORDER BY created_at ASC, memory_rowid ASC`
      )
      .all(sessionId, limit) as EpisodicEntry[];
  }

  recallByDate(from: string, to: string, limit = 20): EpisodicEntry[] {
    return this.db
      .prepare(
        `SELECT * FROM episodic WHERE created_at >= ? AND created_at <= ? AND compressed_at IS NULL ORDER BY created_at DESC LIMIT ?`
      )
      .all(from, to, limit) as EpisodicEntry[];
  }

  /**
   * Mark a set of episodic rows as compressed (i.e. their content has been
   * summarized into semantic memory). Compressed rows still exist for
   * audit, but they're filtered out of recall by default.
   */
  markCompressed(ids: string[]): number {
    if (!ids.length) return 0;
    const placeholders = ids.map(() => "?").join(",");
    const result = this.db
      .prepare(`UPDATE episodic SET compressed_at = datetime('now') WHERE id IN (${placeholders}) AND compressed_at IS NULL`)
      .run(...ids);
    return result.changes;
  }
}

export function buildFtsMatchQuery(query: string, maxTerms = 8): string {
  const terms = Array.from(
    new Set(
      query
        .toLowerCase()
        .match(/[\p{L}\p{N}_-]{2,}/gu) ?? [],
    ),
  ).slice(0, maxTerms);
  return terms.map((term) => `"${term.replace(/"/g, '""')}"`).join(" OR ");
}
