/**
 * MemoryScheduler — background tasks that keep long-term memory healthy.
 *
 * Responsibilities:
 *   - Periodically find sessions that are "done" (idle for N minutes, no new
 *     episodic entries) and haven't been consolidated yet. Run consolidation
 *     in the background so it doesn't block user-facing requests.
 *   - Mid-session consolidation for long-running sessions: every M turns,
 *     summarize the oldest half and store atomic facts so context pressure
 *     is relieved without dropping information.
 *
 * Design:
 *   - One interval timer. No in-memory queue; the sessions table IS the queue.
 *   - Consolidation cost = one LLM call per eligible session. We limit to
 *     one session per tick to keep GPU contention low. Under heavy use with
 *     many idle sessions, we'll catch up over several ticks.
 *   - Explicit `idempotent`: consolidation marks `sessions.consolidated_at`.
 *     Next pass skips it unless there are newer entries.
 */
import type Database from "better-sqlite3";
import type { Logger } from "pino";
import type { EpisodicMemory } from "./episodic.js";
import type { SemanticMemory } from "./semantic.js";
import type { Embedder } from "./embed.js";
import type { LlmChatLike } from "./consolidator.js";
import { consolidateSession } from "./consolidator.js";

export interface MemorySchedulerOpts {
  db: Database.Database;
  episodic: EpisodicMemory;
  semantic: SemanticMemory;
  embedder: Embedder;
  llmAdapter: LlmChatLike;
  /** Sessions idle longer than this are candidates. Default 20 min. */
  idleMinutes?: number;
  /** How often we scan. Default 5 min. */
  tickMinutes?: number;
  /** Max sessions to process per tick. Default 1. */
  batchSize?: number;
  /**
   * Mid-session compression triggers: any active session with this many
   * uncompressed turns AND a quiet gap of `midSessionQuietMinutes` will
   * have its oldest half compressed into semantic memory. Default 12 turns,
   * 5 minute quiet gap.
   */
  midSessionCompressAfter?: number;
  midSessionQuietMinutes?: number;
  logger?: Logger;
}

export class MemoryScheduler {
  private timer: NodeJS.Timeout | null = null;
  private opts: Required<Omit<MemorySchedulerOpts, "logger">> & { logger?: Logger };

  constructor(opts: MemorySchedulerOpts) {
    this.opts = {
      db: opts.db,
      episodic: opts.episodic,
      semantic: opts.semantic,
      embedder: opts.embedder,
      llmAdapter: opts.llmAdapter,
      idleMinutes: opts.idleMinutes ?? 20,
      tickMinutes: opts.tickMinutes ?? 5,
      batchSize: opts.batchSize ?? 1,
      midSessionCompressAfter: opts.midSessionCompressAfter ?? 12,
      midSessionQuietMinutes: opts.midSessionQuietMinutes ?? 5,
      logger: opts.logger,
    };
  }

  start(): void {
    if (this.timer) return;
    const ms = this.opts.tickMinutes * 60 * 1000;
    // Kick one immediately so consolidation happens soon after boot if there's
    // pending work from a prior run.
    setTimeout(() => { void this.tick(); }, 30_000);
    this.timer = setInterval(() => { void this.tick(); }, ms);
    this.log("info", `memory scheduler started — tick every ${this.opts.tickMinutes}m, idle threshold ${this.opts.idleMinutes}m`);
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  /**
   * One pass: find up to N idle+unconsolidated sessions, consolidate each,
   * then look for active sessions with too many turns and compress the
   * oldest half of each.
   */
  async tick(): Promise<void> {
    // 1. End-of-session consolidation for fully-idle sessions.
    const idleSessions = this.findEligibleSessions(this.opts.batchSize);
    for (const sid of idleSessions) {
      try {
        const result = await consolidateSession(sid, {
          llmAdapter: this.opts.llmAdapter,
          episodic: this.opts.episodic,
          semantic: this.opts.semantic,
          embedder: this.opts.embedder,
          db: this.opts.db,
        });
        this.log("info", `consolidated ${sid}: ${result.status}${result.error ? ` - ${result.error}` : ""}${result.facts_stored ? ` (${result.facts_stored} facts)` : ""}`);
      } catch (e: any) {
        this.log("warn", `consolidation failed for ${sid}: ${e?.message ?? e}`);
      }
    }

    // 2. Mid-session compression for long-running active sessions.
    const longSessions = this.findLongActiveSessions(this.opts.batchSize);
    for (const sid of longSessions) {
      try {
        const halfTurns = Math.floor(this.opts.midSessionCompressAfter / 2);
        const result = await consolidateSession(sid, {
          llmAdapter: this.opts.llmAdapter,
          episodic: this.opts.episodic,
          semantic: this.opts.semantic,
          embedder: this.opts.embedder,
          db: this.opts.db,
          compressOldestN: halfTurns,
        });
        this.log(
          "info",
          `mid-session compressed ${sid}: ${result.status}${
            result.error ? ` - ${result.error}` :
            result.compressed_count ? ` (${result.compressed_count} turns rolled into ${result.facts_stored ?? 0} facts)` : ""
          }`,
        );
      } catch (e: any) {
        this.log("warn", `mid-session compression failed for ${sid}: ${e?.message ?? e}`);
      }
    }
  }

  /**
   * Find sessions that:
   *   - have at least one episodic entry
   *   - haven't received a new entry in idleMinutes
   *   - either were never consolidated, OR the last episodic entry is newer
   *     than the last consolidation (new material has arrived since)
   */
  private findEligibleSessions(limit: number): string[] {
    try {
      const rows = this.opts.db.prepare(`
        SELECT s.id
        FROM sessions s
        WHERE EXISTS (SELECT 1 FROM episodic e WHERE e.session_id = s.id)
          AND (
            s.consolidated_at IS NULL
            OR (SELECT MAX(created_at) FROM episodic e WHERE e.session_id = s.id) > s.consolidated_at
          )
          AND (SELECT MAX(created_at) FROM episodic e WHERE e.session_id = s.id)
              < datetime('now', ?)
        ORDER BY s.id
        LIMIT ?
      `).all(`-${this.opts.idleMinutes} minutes`, limit) as Array<{ id: string }>;
      return rows.map((r) => r.id);
    } catch (e: any) {
      this.log("warn", `scheduler query failed (migration may be pending): ${e?.message ?? e}`);
      return [];
    }
  }

  /**
   * Find active sessions that have grown beyond the mid-session threshold
   * and have a brief quiet gap — good time to compress the oldest half
   * without disrupting an in-flight conversation.
   */
  private findLongActiveSessions(limit: number): string[] {
    try {
      const rows = this.opts.db.prepare(`
        SELECT s.id, COUNT(e.id) as uncompressed_count
        FROM sessions s
        JOIN episodic e ON e.session_id = s.id
        WHERE e.compressed_at IS NULL
          AND (SELECT MAX(created_at) FROM episodic e2
                WHERE e2.session_id = s.id
                  AND e2.compressed_at IS NULL)
              < datetime('now', ?)
        GROUP BY s.id
        HAVING uncompressed_count >= ?
        ORDER BY uncompressed_count DESC
        LIMIT ?
      `).all(
        `-${this.opts.midSessionQuietMinutes} minutes`,
        this.opts.midSessionCompressAfter,
        limit,
      ) as Array<{ id: string; uncompressed_count: number }>;
      return rows.map((r) => r.id);
    } catch (e: any) {
      this.log("warn", `mid-session query failed: ${e?.message ?? e}`);
      return [];
    }
  }

  private log(level: "info" | "warn", msg: string): void {
    if (!this.opts.logger) return;
    const l: any = this.opts.logger;
    if (typeof l[level] === "function") l[level](`[memory] ${msg}`);
  }
}
