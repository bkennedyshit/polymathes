import { z } from "zod";
import type { ToolRegistry } from "../registry.js";
import type { EpisodicMemory } from "../../memory/episodic.js";
import type { SemanticMemory } from "../../memory/semantic.js";
import type { Embedder } from "../../memory/embed.js";
import type { MediaEpisodic, MediaFilter } from "../../memory/media_episodic.js";
import type { MediaWorkflow } from "../../memory/media_workflow.js";
import { seedMedia, type SeedOptions } from "../../workspace/seed_media.js";

let episodic: EpisodicMemory | undefined;
let semantic: SemanticMemory | undefined;
let embedder: Embedder | undefined;
let mediaEpisodic: MediaEpisodic | undefined;
let mediaWorkflow: MediaWorkflow | undefined;
let globalRouter: { invoke: (name: string, args: any, ctx?: any) => Promise<any> } | undefined;

export function setMemoryBackend(
  e: EpisodicMemory,
  s: SemanticMemory,
  emb?: Embedder,
  mEp?: MediaEpisodic,
  mWf?: MediaWorkflow,
): void {
  episodic = e;
  semantic = s;
  embedder = emb;
  mediaEpisodic = mEp;
  mediaWorkflow = mWf;
}

/**
 * Wire the tool router so media.vision_search can fan out to the
 * media-memory MCP server's `search` tool. Set after the router exists.
 */
export function setMediaToolRouter(
  router: { invoke: (name: string, args: any, ctx?: any) => Promise<any> },
): void {
  globalRouter = router;
}

export function register(registry: ToolRegistry): void {
  // -------------------- text memory --------------------

  registry.register({
    name: "memory.recall",
    description:
      "Search your long-term memory. Runs a hybrid search (FTS + semantic vectors when available) " +
      "across every past conversation and stored fact. Use this before asking the user a question " +
      "you might already know the answer to.",
    parameters: z.object({
      query: z.string().describe("Natural-language query. Example: 'user's BMX content paths' or 'where do I export reels'."),
      limit: z.number().optional().describe("Max results. Default 8."),
    }),
    async handler(args) {
      const { query, limit } = args as { query: string; limit?: number };
      const lim = limit ?? 8;
      const ftsHits = episodic?.recall(query, lim) ?? [];
      let semanticHits: Array<{ id: string; content: string; score: number }> = [];
      if (embedder && semantic) {
        const vec = await embedder.embed(query);
        if (vec) semanticHits = semantic.recall(vec, lim);
      }
      return {
        fts: ftsHits.map((h) => ({ id: h.id, role: h.role, content: h.content, ts: h.created_at })),
        semantic: semanticHits,
      };
    },
    toolset: "memory",
  });

  registry.register({
    name: "memory.note",
    description:
      "Explicitly write a fact into long-term semantic memory with a real embedding. Use this when " +
      "the user tells you something durable (preferences, paths, conventions, names) that you should " +
      "remember across sessions. Does NOT replace existing notes — creates a new entry. Use memory.forget " +
      "to remove stale ones.",
    parameters: z.object({
      content: z.string().describe("The fact in a single clear sentence. Example: 'User stores raw BMX footage under D:/AGENT/input/bmx/'."),
    }),
    async handler(args, ctx) {
      const { content } = args as { content: string };
      if (!semantic || !embedder) return { ok: false, error: "semantic memory not wired" };
      const vec = await embedder.embed(content);
      if (!vec) return { ok: false, error: "embedding failed — is Ollama reachable?" };
      const sessionId = (ctx as any)?.sessionId;
      const id = semantic.store(content, vec, sessionId);
      return { ok: true, id };
    },
    toolset: "memory",
  });

  registry.register({
    name: "memory.pin",
    description: "Flag a semantic memory entry as pinned so it's preferred in recall.",
    parameters: z.object({ id: z.string() }),
    async handler(args) {
      const { id } = args as { id: string };
      if (!semantic) return { ok: false, error: "memory backend not set" };
      semantic.pin(id);
      return { ok: true };
    },
    toolset: "memory",
  });

  registry.register({
    name: "memory.forget",
    description: "Delete a semantic memory entry by id. Irreversible. Use when a fact is no longer true.",
    parameters: z.object({ id: z.string() }),
    async handler(args) {
      const { id } = args as { id: string };
      if (!semantic) return { ok: false, error: "memory backend not set" };
      semantic.forget(id);
      return { ok: true };
    },
    toolset: "memory",
  });

  registry.register({
    name: "memory.session_history",
    description: "Return the turn-by-turn episodic log for a given session id.",
    parameters: z.object({
      sessionId: z.string().optional().describe("Defaults to the current session."),
      limit: z.number().optional(),
    }),
    async handler(args, ctx) {
      const { sessionId, limit } = args as { sessionId?: string; limit?: number };
      const sid = sessionId ?? (ctx as any)?.sessionId ?? "";
      if (!episodic || !sid) return { results: [] };
      return { results: episodic.recallBySession(sid, limit ?? 50) };
    },
    toolset: "memory",
  });

  // -------------------- media memory --------------------

  registry.register({
    name: "media.register",
    description:
      "Record or update a media file in the catalog. Use this when you see or process a new video/photo " +
      "so future questions like 'have I reeled this session yet' work. Idempotent on path.",
    parameters: z.object({
      path: z.string().describe("Absolute file path."),
      kind: z.string().optional().describe("video | image | audio"),
      brand: z.string().optional().describe("Brand tag (bmx, nepa-ai, etc). Usually auto-inferred from path."),
      category: z.string().optional().describe("raw | edited | reel | photo | archive"),
      intent: z.string().optional(),
      duration_sec: z.number().optional(),
      width: z.number().optional(),
      height: z.number().optional(),
      note: z.string().optional().describe("Free-form observation stored in metadata."),
    }),
    async handler(args) {
      if (!mediaEpisodic) return { ok: false, error: "media memory not wired" };
      const { note, ...rest } = args as { note?: string } & Record<string, unknown>;
      const metadata = note ? { note } : undefined;
      const id = mediaEpisodic.upsert({ ...(rest as any), metadata });
      return { ok: true, id };
    },
    toolset: "memory",
  });

  registry.register({
    name: "media.query",
    description:
      "Search the media catalog with structured filters. Use this to answer content questions like " +
      "'show me BMX reels posted in May', 'find raw sessions longer than 10 minutes', 'what photos are " +
      "in the nepa-ai brand folder'.",
    parameters: z.object({
      brand: z.string().optional(),
      category: z.string().optional(),
      kind: z.string().optional(),
      intent: z.string().optional(),
      min_duration_sec: z.number().optional(),
      max_duration_sec: z.number().optional(),
      modified_after: z.string().optional().describe("ISO-8601 timestamp."),
      modified_before: z.string().optional(),
      path_glob: z.string().optional().describe("Wildcard path match, e.g. D:/AGENT/input/bmx/* "),
      limit: z.number().optional(),
    }),
    async handler(args) {
      if (!mediaEpisodic) return { ok: false, error: "media memory not wired" };
      return { results: mediaEpisodic.query(args as MediaFilter) };
    },
    toolset: "memory",
  });

  registry.register({
    name: "media.stats",
    description: "Return total count + per-brand + per-category breakdown of the media catalog. Good for 'give me an inventory'.",
    parameters: z.object({}),
    async handler() {
      if (!mediaEpisodic) return { ok: false, error: "media memory not wired" };
      return mediaEpisodic.stats();
    },
    toolset: "memory",
  });

  registry.register({
    name: "media.trace",
    description:
      "Record a workflow event: an analyze/edit/reel/crop/post/repurpose step. Use this after running a " +
      "skill or posting to social so future queries can answer 'have I done X with Y yet' correctly.",
    parameters: z.object({
      source_id: z.string().optional().describe("Source media id. Null if starting fresh."),
      derived_id: z.string().optional().describe("If this step produced a new media item, its id."),
      step: z.string().describe("analyze | edit | reel | crop | post | repurpose"),
      platform: z.string().optional().describe("When step=post: instagram | tiktok | youtube | ..."),
      tool: z.string().optional().describe("Name of skill/tool that did the step."),
      note: z.string().optional(),
    }),
    async handler(args, ctx) {
      if (!mediaWorkflow) return { ok: false, error: "media workflow not wired" };
      const a = args as any;
      const sessionId = (ctx as any)?.sessionId;
      const id = mediaWorkflow.record({ ...a, session_id: sessionId });
      return { ok: true, id };
    },
    toolset: "memory",
  });

  registry.register({
    name: "media.pipeline",
    description: "Return the full workflow trace for a source media item — every step that's been applied to it.",
    parameters: z.object({ source_id: z.string() }),
    async handler(args) {
      if (!mediaWorkflow) return { ok: false, error: "media workflow not wired" };
      const { source_id } = args as { source_id: string };
      return { events: mediaWorkflow.pipelineFor(source_id) };
    },
    toolset: "memory",
  });

  registry.register({
    name: "media.unposted",
    description:
      "Return source media items that have never been taken through a given workflow step. Use to answer " +
      "'what raw sessions haven't I edited yet' or 'which reels haven't been posted to Instagram'.",
    parameters: z.object({
      step: z.string().describe("The step to check for (e.g. 'edit', 'post', 'reel')."),
      brand: z.string().optional(),
      category: z.string().optional(),
      limit: z.number().optional(),
    }),
    async handler(args) {
      if (!mediaWorkflow) return { ok: false, error: "media workflow not wired" };
      const { step, brand, category, limit } = args as any;
      return { source_ids: mediaWorkflow.sourcesMissingStep(step, { brand, category, limit }) };
    },
    toolset: "memory",
  });

  registry.register({
    name: "media.recent_posts",
    description:
      "Return recent post events from the workflow log. Use this to answer 'what did I post yesterday' " +
      "or 'show me everything I posted to TikTok this week'.",
    parameters: z.object({
      since: z.string().optional().describe("ISO timestamp lower bound."),
      until: z.string().optional().describe("ISO timestamp upper bound."),
      platform: z.string().optional().describe("instagram | tiktok | youtube | pinterest | twitter | ..."),
      limit: z.number().optional().describe("Default 100."),
    }),
    async handler(args) {
      if (!mediaWorkflow) return { ok: false, error: "media workflow not wired" };
      const a = args as any;
      return { events: mediaWorkflow.recentPosts({ since: a.since, until: a.until, platform: a.platform, limit: a.limit }) };
    },
    toolset: "memory",
  });

  registry.register({
    name: "media.digest",
    description:
      "ONE-CALL roll-up of the media catalog: per-brand totals, per-category breakdown, plus how many " +
      "items haven't been posted to each major platform yet. Use this to answer 'what's pending across " +
      "all my brands' — the agent's flagship 'I know your workflow' question.",
    parameters: z.object({
      brand: z.string().optional().describe("Filter to a single brand. Default: all brands with non-null brand."),
      platforms: z.array(z.string()).optional().describe("Platforms to check unposted-counts for. Default: instagram, tiktok, youtube, pinterest."),
    }),
    async handler(args) {
      if (!mediaEpisodic || !mediaWorkflow) {
        return { ok: false, error: "media catalog or workflow not wired" };
      }
      const a = args as any;
      const platforms: string[] = a.platforms ?? ["instagram", "tiktok", "youtube", "pinterest"];
      const stats = mediaEpisodic.stats();

      // For each brand (or just the one filter), build the digest.
      const targets = a.brand
        ? [a.brand]
        : Object.keys(stats.by_brand).filter((b) => b && b !== "(unbranded)");

      const brands: Array<any> = [];
      for (const brand of targets) {
        const items = mediaEpisodic.query({ brand, limit: 500 });
        const byCategory: Record<string, number> = {};
        for (const it of items) {
          const c = it.category ?? "(uncategorized)";
          byCategory[c] = (byCategory[c] ?? 0) + 1;
        }
        const pending: Record<string, number> = {};
        for (const platform of platforms) {
          // Look at items that are reels/long-form (likely-postable categories)
          // and count how many have never been traced as step=post for this platform.
          const ids = mediaWorkflow.sourcesMissingStep("post", { brand, limit: 1000 });
          // Filter platform-specific: a source is "missing for instagram" if it
          // has no post event for instagram. Since sourcesMissingStep is per
          // step-only, walk the pipeline on each candidate and exclude those
          // already posted to this platform.
          let count = 0;
          for (const id of ids) {
            const events = mediaWorkflow.pipelineFor(id);
            if (!events.some((ev) => ev.step === "post" && ev.platform === platform)) {
              count++;
            }
          }
          pending[platform] = count;
        }
        brands.push({
          brand,
          total: items.length,
          by_category: byCategory,
          unposted: pending,
        });
      }

      return {
        ok: true,
        catalog_total: stats.total,
        brands,
        platforms_checked: platforms,
      };
    },
    toolset: "memory",
  });

  registry.register({
    name: "media.seed",
    description:
      "Walk a directory tree and catalog every video/photo/audio file: classify by brand and category " +
      "from path conventions, extract metadata via ffprobe (videos) or image headers (photos), and " +
      "upsert into the catalog. Idempotent — safe to re-run. Use to bootstrap or refresh the catalog " +
      "after adding new content to disk.",
    parameters: z.object({
      path: z.string().describe("Absolute root path to scan (e.g. D:/AGENT or D:/AGENT/input/bmx)."),
      since: z.string().optional().describe("ISO timestamp; only seed files modified after this."),
      max_file_mb: z.number().optional().describe("Skip files larger than N MB. Default 2048."),
      max_video_minutes: z.number().optional().describe("Warn on videos longer than N minutes. Default 10."),
      force_large: z.boolean().optional().describe("Bypass size/duration guardrails."),
      dry_run: z.boolean().optional().describe("Scan without writing — useful for previews."),
    }),
    async handler(args) {
      if (!mediaEpisodic) return { ok: false, error: "media catalog not wired" };
      const a = args as any;
      const opts: SeedOptions = {
        since: a.since,
        maxFileMb: a.max_file_mb,
        maxVideoMinutes: a.max_video_minutes,
        forceLarge: a.force_large,
        dryRun: a.dry_run,
      };
      const result = await seedMedia(a.path, mediaEpisodic, opts);
      // Return a compact summary — full results are too verbose for chat.
      return {
        ok: true,
        registered: result.registered,
        skipped: result.skipped,
        total_scanned: result.total_files,
        duration_ms: result.duration_ms,
        by_brand: result.by_brand,
        by_category: result.by_category,
        warnings: result.warnings.slice(0, 5),
        warning_count: result.warnings.length,
      };
    },
    toolset: "memory",
  });

  registry.register({
    name: "media.vision_search",
    description:
      "Search media files by VISUAL similarity using GPU CLIP embeddings. Use this for queries like " +
      "'find a clean rider shot for the blog' or 'photos visually similar to this hero image'. Joins " +
      "vector hits with metadata so brand/category/duration filters still work after similarity ranking. " +
      "Requires the media-memory MCP server to be running and an index to have been built.",
    parameters: z.object({
      query: z.string().describe("Natural-language description OR an absolute image/frame path. The C++ encoder handles both."),
      k: z.number().optional().describe("Top-K nearest neighbors to return. Default 8."),
      brand: z.string().optional().describe("Post-filter: only return results in this brand."),
      category: z.string().optional().describe("Post-filter: only return results in this category."),
      min_duration_sec: z.number().optional().describe("Post-filter: minimum video duration."),
      max_duration_sec: z.number().optional().describe("Post-filter: maximum video duration."),
    }),
    async handler(args, ctx) {
      const a = args as any;
      // Route through the parent ToolRouter so we hit the media-memory MCP
      // server's `search` tool. The router dispatches MCP-namespaced names.
      const router = (ctx as any)?.router ?? globalRouter;
      if (!router?.invoke) {
        return { ok: false, error: "tool router not wired into media.vision_search" };
      }
      let raw: any;
      try {
        raw = await router.invoke(
          "media-memory.search",
          { query: a.query, k: a.k ?? 8 },
          { sessionId: (ctx as any)?.sessionId ?? "media.vision_search" },
        );
      } catch (e: any) {
        return {
          ok: false,
          error: `vision search failed (is media-memory MCP server running and indexed?): ${e?.message ?? e}`,
        };
      }
      // Normalize result shape — MCP servers return varied envelopes.
      const hits: Array<{ path: string; score: number }> =
        raw?.results ?? raw?.hits ?? (Array.isArray(raw) ? raw : []);

      // Join with the catalog so we can post-filter on brand/category/etc.
      const enriched: Array<any> = [];
      for (const hit of hits) {
        const path = hit.path ?? (hit as any).file ?? "";
        if (!path) continue;
        const item = mediaEpisodic?.get(path);
        if (a.brand && item?.brand !== a.brand) continue;
        if (a.category && item?.category !== a.category) continue;
        if (a.min_duration_sec != null && (!item?.duration_sec || item.duration_sec < a.min_duration_sec)) continue;
        if (a.max_duration_sec != null && (item?.duration_sec ?? Infinity) > a.max_duration_sec) continue;
        enriched.push({
          path,
          score: hit.score ?? (hit as any).similarity ?? null,
          ...(item ? { metadata: item } : {}),
        });
      }

      return { ok: true, results: enriched, source_hit_count: hits.length, returned: enriched.length };
    },
    toolset: "memory",
  });
}
