/**
 * MediaWorkflow — structured trace of every transformation, edit, cut, or
 * post that happens to a media file. Lets the agent reason about what's
 * already been done, what's pending, and prevent duplicate work.
 *
 * Steps we track:
 *   analyze   — video-analyze skill ran against it
 *   edit      — session-highlight-editor or similar produced an edit plan
 *   reel      — a reel was extracted from it
 *   crop      — a platform crop/reframe was made
 *   post      — published to a platform (platform column populated)
 *   repurpose — used as source for a new derivative (e.g. reel → TikTok clip)
 *
 * Queries that become trivial:
 *   - "has c_0308 been reeled yet?"        → pipeline(source_id).any(step=reel)
 *   - "which raw sessions have I never edited?" → sessions without edit step
 *   - "what did I post today?"             → today's post rows
 *   - "is this already on Instagram?"      → has post row with platform=instagram
 */
import type Database from "better-sqlite3";
import { ulid } from "ulid";

export type WorkflowStep = "analyze" | "edit" | "reel" | "crop" | "post" | "repurpose" | string;

export interface WorkflowEvent {
  id: string;
  source_id: string | null;
  derived_id: string | null;
  step: WorkflowStep;
  platform?: string;
  tool?: string;
  session_id?: string;
  note?: string;
  created_at: string;
  metrics?: Record<string, unknown>;
}

export class MediaWorkflow {
  constructor(private db: Database.Database) {}

  record(ev: Omit<WorkflowEvent, "id" | "created_at">): string {
    const id = ulid();
    this.db.prepare(`
      INSERT INTO media_workflow (
        id, source_id, derived_id, step, platform, tool, session_id, note, metrics_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      ev.source_id ?? null,
      ev.derived_id ?? null,
      ev.step,
      ev.platform ?? null,
      ev.tool ?? null,
      ev.session_id ?? null,
      ev.note ?? null,
      ev.metrics ? JSON.stringify(ev.metrics) : null,
    );
    return id;
  }

  /** Full trace for a single source file. Ordered oldest→newest. */
  pipelineFor(sourceId: string): WorkflowEvent[] {
    const rows = this.db.prepare(`
      SELECT * FROM media_workflow
      WHERE source_id = ? OR derived_id = ?
      ORDER BY created_at ASC
    `).all(sourceId, sourceId) as any[];
    return rows.map(rowToEvent);
  }

  /** Has a source file been taken through a given step (optionally on a given platform)? */
  hasBeen(sourceId: string, step: WorkflowStep, platform?: string): boolean {
    if (platform) {
      const row = this.db.prepare(`
        SELECT 1 FROM media_workflow WHERE source_id = ? AND step = ? AND platform = ? LIMIT 1
      `).get(sourceId, step, platform);
      return !!row;
    }
    const row = this.db.prepare(`
      SELECT 1 FROM media_workflow WHERE source_id = ? AND step = ? LIMIT 1
    `).get(sourceId, step);
    return !!row;
  }

  /** Source items that have NEVER been taken through `step`. Useful for "show me unposted content." */
  sourcesMissingStep(step: WorkflowStep, opts: { brand?: string; category?: string; limit?: number } = {}): string[] {
    const params: any[] = [step];
    let brandClause = "";
    if (opts.brand) { brandClause += " AND mi.brand = ?"; params.push(opts.brand); }
    if (opts.category) { brandClause += " AND mi.category = ?"; params.push(opts.category); }
    const limit = Math.min(opts.limit ?? 50, 500);
    params.push(limit);
    const rows = this.db.prepare(`
      SELECT mi.id FROM media_items mi
      WHERE NOT EXISTS (
        SELECT 1 FROM media_workflow w WHERE w.source_id = mi.id AND w.step = ?
      )${brandClause}
      ORDER BY mi.modified_at DESC
      LIMIT ?
    `).all(...params) as Array<{ id: string }>;
    return rows.map((r) => r.id);
  }

  /** What did I post today? (or in a window) */
  recentPosts(opts: { since?: string; until?: string; platform?: string; limit?: number } = {}): WorkflowEvent[] {
    const clauses: string[] = ["step = 'post'"];
    const params: any[] = [];
    if (opts.since) { clauses.push("created_at >= ?"); params.push(opts.since); }
    if (opts.until) { clauses.push("created_at <= ?"); params.push(opts.until); }
    if (opts.platform) { clauses.push("platform = ?"); params.push(opts.platform); }
    const where = "WHERE " + clauses.join(" AND ");
    const limit = Math.min(opts.limit ?? 100, 500);
    const rows = this.db.prepare(`
      SELECT * FROM media_workflow ${where} ORDER BY created_at DESC LIMIT ?
    `).all(...params, limit) as any[];
    return rows.map(rowToEvent);
  }
}

function rowToEvent(row: any): WorkflowEvent {
  return {
    id: row.id,
    source_id: row.source_id,
    derived_id: row.derived_id,
    step: row.step,
    platform: row.platform ?? undefined,
    tool: row.tool ?? undefined,
    session_id: row.session_id ?? undefined,
    note: row.note ?? undefined,
    created_at: row.created_at,
    metrics: row.metrics_json ? safeJson(row.metrics_json) : undefined,
  };
}
function safeJson(s: string): Record<string, unknown> | undefined {
  try { return JSON.parse(s); } catch { return undefined; }
}
