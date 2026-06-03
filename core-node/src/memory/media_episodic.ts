/**
 * MediaEpisodic — structured memory for the user's content catalog.
 *
 * Text agents have "I said X at time T" memory. Creator agents need the
 * equivalent for video/photo artifacts. This module is the answer.
 *
 * What we store per file:
 *   - Location + brand + category (auto-inferred from path convention)
 *   - Duration, dimensions, aspect — so the agent can reason about "is this
 *     vertical", "is this long enough for a reel", etc. without re-probing
 *   - Intent label — riding/trick/crash/chill/scenery, populated by the
 *     video-analyze skill when run
 *   - Free-form metadata JSON — exif, ffprobe, transcripts, hashtags, the
 *     agent's own notes
 *   - Perceptual hash (source_hash) — catches dupes across paths/formats
 *
 * What we deliberately DON'T do here:
 *   - CLIP / vision embeddings. Those live in the C++ media-memory binary
 *     and come through the MCP layer. This module wraps metadata-first.
 */
import type Database from "better-sqlite3";
import { ulid } from "ulid";
import { buildFtsMatchQuery } from "./episodic.js";

export interface MediaItem {
  id: string;
  path: string;
  kind?: "video" | "image" | "audio" | string;
  brand?: string;
  category?: "raw" | "edited" | "reel" | "photo" | "archive" | string;
  intent?: "riding" | "trick" | "crash" | "chill" | "scenery" | "other" | string;
  duration_sec?: number;
  width?: number;
  height?: number;
  aspect_ratio?: number;
  file_size_bytes?: number;
  modified_at?: string;
  indexed_at?: string;
  metadata?: Record<string, unknown>;
  source_hash?: string;
}

export interface MediaFilter {
  /** Natural-language query matched against path, tags, metadata, notes, and inferred labels. */
  query?: string;
  brand?: string;
  category?: string;
  kind?: string;
  intent?: string;
  min_duration_sec?: number;
  max_duration_sec?: number;
  modified_after?: string;
  modified_before?: string;
  /** Path glob (simple): '*' and '?' wildcards matched against path. */
  path_glob?: string;
  limit?: number;
}

function globToLike(glob: string): string {
  // Convert simple wildcard glob to SQL LIKE pattern.
  return glob.replace(/\\/g, "/").replace(/%/g, "\\%").replace(/_/g, "\\_").replace(/\*/g, "%").replace(/\?/g, "_");
}

export class MediaEpisodic {
  constructor(private db: Database.Database) {}

  /** Idempotent upsert — by path. Returns the id of the stored row. */
  upsert(item: Omit<MediaItem, "id" | "indexed_at">): string {
    const existing = this.db
      .prepare(`SELECT id FROM media_items WHERE path = ?`)
      .get(item.path) as { id: string } | undefined;

    const id = existing?.id ?? ulid();
    const metadata_json = item.metadata ? JSON.stringify(item.metadata) : null;

    if (existing) {
      this.db.prepare(`
        UPDATE media_items SET
          kind = COALESCE(?, kind),
          brand = COALESCE(?, brand),
          category = COALESCE(?, category),
          intent = COALESCE(?, intent),
          duration_sec = COALESCE(?, duration_sec),
          width = COALESCE(?, width),
          height = COALESCE(?, height),
          aspect_ratio = COALESCE(?, aspect_ratio),
          file_size_bytes = COALESCE(?, file_size_bytes),
          modified_at = COALESCE(?, modified_at),
          metadata_json = COALESCE(?, metadata_json),
          source_hash = COALESCE(?, source_hash)
        WHERE id = ?
      `).run(
        item.kind ?? null, item.brand ?? null, item.category ?? null, item.intent ?? null,
        item.duration_sec ?? null, item.width ?? null, item.height ?? null, item.aspect_ratio ?? null,
        item.file_size_bytes ?? null, item.modified_at ?? null, metadata_json, item.source_hash ?? null,
        id,
      );
    } else {
      this.db.prepare(`
        INSERT INTO media_items (
          id, path, kind, brand, category, intent,
          duration_sec, width, height, aspect_ratio, file_size_bytes,
          modified_at, metadata_json, source_hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id, item.path, item.kind ?? null, item.brand ?? null, item.category ?? null, item.intent ?? null,
        item.duration_sec ?? null, item.width ?? null, item.height ?? null, item.aspect_ratio ?? null,
        item.file_size_bytes ?? null, item.modified_at ?? null, metadata_json, item.source_hash ?? null,
      );
    }
    return id;
  }

  get(path: string): MediaItem | null {
    const row = this.db.prepare(`SELECT * FROM media_items WHERE path = ?`).get(path) as any;
    return row ? rowToItem(row) : null;
  }

  getById(id: string): MediaItem | null {
    const row = this.db.prepare(`SELECT * FROM media_items WHERE id = ?`).get(id) as any;
    return row ? rowToItem(row) : null;
  }

  query(filter: MediaFilter = {}): MediaItem[] {
    if (filter.query?.trim()) return this.search(filter.query, filter);

    const clauses: string[] = [];
    const params: any[] = [];
    if (filter.brand) { clauses.push("brand = ?"); params.push(filter.brand); }
    if (filter.category) { clauses.push("category = ?"); params.push(filter.category); }
    if (filter.kind) { clauses.push("kind = ?"); params.push(filter.kind); }
    if (filter.intent) { clauses.push("intent = ?"); params.push(filter.intent); }
    if (filter.min_duration_sec != null) { clauses.push("duration_sec >= ?"); params.push(filter.min_duration_sec); }
    if (filter.max_duration_sec != null) { clauses.push("duration_sec <= ?"); params.push(filter.max_duration_sec); }
    if (filter.modified_after) { clauses.push("modified_at >= ?"); params.push(filter.modified_after); }
    if (filter.modified_before) { clauses.push("modified_at <= ?"); params.push(filter.modified_before); }
    if (filter.path_glob) { clauses.push("path LIKE ? ESCAPE '\\'"); params.push(globToLike(filter.path_glob)); }

    const where = clauses.length ? "WHERE " + clauses.join(" AND ") : "";
    const limit = Math.min(filter.limit ?? 100, 500);
    const rows = this.db
      .prepare(`SELECT * FROM media_items ${where} ORDER BY modified_at DESC LIMIT ?`)
      .all(...params, limit) as any[];
    return rows.map(rowToItem);
  }

  search(query: string, filter: Omit<MediaFilter, "query"> = {}): MediaItem[] {
    const matchQuery = buildFtsMatchQuery(query, 12);
    if (!matchQuery) return this.query(filter);

    const clauses: string[] = ["media_fts MATCH ?"];
    const params: any[] = [matchQuery];
    appendMediaFilterClauses(filter, clauses, params);

    const limit = Math.min(filter.limit ?? 50, 500);
    const rows = this.db
      .prepare(`
        SELECT mi.*
        FROM media_items mi
        JOIN media_fts f ON f.rowid = mi.rowid
        WHERE ${clauses.join(" AND ")}
        ORDER BY bm25(media_fts), mi.modified_at DESC
        LIMIT ?
      `)
      .all(...params, limit) as any[];
    return rows.map(rowToItem);
  }

  /** Quick total / breakdown view — for the UI dashboard. */
  stats(): { total: number; by_brand: Record<string, number>; by_category: Record<string, number> } {
    const total = (this.db.prepare(`SELECT COUNT(*) as n FROM media_items`).get() as any).n;
    const by_brand: Record<string, number> = {};
    for (const r of this.db.prepare(`SELECT brand, COUNT(*) as n FROM media_items GROUP BY brand`).all() as any[]) {
      by_brand[r.brand ?? "(unbranded)"] = r.n;
    }
    const by_category: Record<string, number> = {};
    for (const r of this.db.prepare(`SELECT category, COUNT(*) as n FROM media_items GROUP BY category`).all() as any[]) {
      by_category[r.category ?? "(uncategorized)"] = r.n;
    }
    return { total, by_brand, by_category };
  }

  remove(id: string): void {
    this.db.prepare(`DELETE FROM media_items WHERE id = ?`).run(id);
  }
}

function appendMediaFilterClauses(filter: Omit<MediaFilter, "query">, clauses: string[], params: any[]): void {
  if (filter.brand) { clauses.push("mi.brand = ?"); params.push(filter.brand); }
  if (filter.category) { clauses.push("mi.category = ?"); params.push(filter.category); }
  if (filter.kind) { clauses.push("mi.kind = ?"); params.push(filter.kind); }
  if (filter.intent) { clauses.push("mi.intent = ?"); params.push(filter.intent); }
  if (filter.min_duration_sec != null) { clauses.push("mi.duration_sec >= ?"); params.push(filter.min_duration_sec); }
  if (filter.max_duration_sec != null) { clauses.push("mi.duration_sec <= ?"); params.push(filter.max_duration_sec); }
  if (filter.modified_after) { clauses.push("mi.modified_at >= ?"); params.push(filter.modified_after); }
  if (filter.modified_before) { clauses.push("mi.modified_at <= ?"); params.push(filter.modified_before); }
  if (filter.path_glob) { clauses.push("mi.path LIKE ? ESCAPE '\\'"); params.push(globToLike(filter.path_glob)); }
}

function rowToItem(row: any): MediaItem {
  return {
    id: row.id,
    path: row.path,
    kind: row.kind ?? undefined,
    brand: row.brand ?? undefined,
    category: row.category ?? undefined,
    intent: row.intent ?? undefined,
    duration_sec: row.duration_sec ?? undefined,
    width: row.width ?? undefined,
    height: row.height ?? undefined,
    aspect_ratio: row.aspect_ratio ?? undefined,
    file_size_bytes: row.file_size_bytes ?? undefined,
    modified_at: row.modified_at ?? undefined,
    indexed_at: row.indexed_at ?? undefined,
    metadata: row.metadata_json ? safeJson(row.metadata_json) : undefined,
    source_hash: row.source_hash ?? undefined,
  };
}
function safeJson(s: string): Record<string, unknown> | undefined {
  try { return JSON.parse(s); } catch { return undefined; }
}
