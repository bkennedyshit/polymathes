import { z } from "zod";
import type { ToolRegistry } from "../registry.js";
import type { EpisodicMemory } from "../../memory/episodic.js";
import type { SemanticMemory } from "../../memory/semantic.js";

let episodic: EpisodicMemory | undefined;
let semantic: SemanticMemory | undefined;

export function setMemoryBackend(e: EpisodicMemory, s: SemanticMemory): void {
  episodic = e;
  semantic = s;
}

export function register(registry: ToolRegistry): void {
  registry.register({
    name: "memory_recall",
    description: "Recall memories matching a query",
    parameters: z.object({ query: z.string(), limit: z.number().optional() }),
    async handler(args) {
      const { query, limit } = args as { query: string; limit?: number };
      if (!episodic) return { results: [] };
      return { results: episodic.recall(query, limit ?? 10) };
    },
    toolset: "memory",
  });

  registry.register({
    name: "memory_recall_session",
    description: "Recall memories from a specific session",
    parameters: z.object({ sessionId: z.string().optional() }),
    async handler(args) {
      const { sessionId } = args as { sessionId?: string };
      if (!episodic) return { results: [] };
      return { results: episodic.recallBySession(sessionId ?? "") };
    },
    toolset: "memory",
  });

  registry.register({
    name: "memory_recall_by_date",
    description: "Recall memories within a date range",
    parameters: z.object({ from: z.string(), to: z.string() }),
    async handler(args) {
      const { from, to } = args as { from: string; to: string };
      if (!episodic) return { results: [] };
      return { results: episodic.recallByDate(from, to) };
    },
    toolset: "memory",
  });

  registry.register({
    name: "memory_pin",
    description: "Pin a memory entry",
    parameters: z.object({ id: z.string() }),
    async handler(args) {
      const { id } = args as { id: string };
      if (!semantic) return { error: "memory backend not set" };
      semantic.pin(id);
      return { ok: true };
    },
    toolset: "memory",
  });

  registry.register({
    name: "memory_forget",
    description: "Delete a memory entry by ID",
    parameters: z.object({ id: z.string() }),
    async handler(args) {
      const { id } = args as { id: string };
      if (!episodic) return { error: "memory backend not set" };
      (episodic as any).db.prepare("DELETE FROM episodic WHERE id = ?").run(id);
      return { ok: true };
    },
    toolset: "memory",
  });

  registry.register({
    name: "memory_list_sessions",
    description: "List remembered sessions",
    parameters: z.object({ limit: z.number().optional() }),
    async handler(args) {
      const { limit } = args as { limit?: number };
      if (!episodic) return { sessions: [] };
      const rows = (episodic as any).db
        .prepare("SELECT DISTINCT session_id FROM episodic ORDER BY created_at DESC LIMIT ?")
        .all(limit ?? 20) as Array<{ session_id: string }>;
      return { sessions: rows.map((r) => r.session_id) };
    },
    toolset: "memory",
  });
}
