import { z } from "zod";
import type { ToolRegistry } from "../registry.js";

// ---------- Connective setters ----------
//
// comms.ts is registered at tool-discovery time, before the Gateway has
// assembled its session store, transport layer, or subagent spawner.
// main.ts wires those in via these setters once boot is complete.

export interface SessionStoreLike {
  list(): Array<{ id: string; created_at?: string; last_active_at?: string }>;
  history(sessionId: string, limit?: number): Array<{ role: string; content: string; created_at?: string }>;
  send?(sessionId: string, text: string): Promise<void>;
}

export interface TransportHubLike {
  list(): Array<{ name: string }>;
  send(channel: string, target: string, text: string): Promise<{ ok: boolean; error?: string }>;
}

type SubagentSpawnerFn = (task: string, opts?: { toolset?: string; timeoutMs?: number }) => Promise<unknown>;

let sessionStore: SessionStoreLike | undefined;
let transportHub: TransportHubLike | undefined;
let subagentSpawner: SubagentSpawnerFn | undefined;

export function setSessionStore(store: SessionStoreLike): void {
  sessionStore = store;
}

export function setTransportHub(hub: TransportHubLike): void {
  transportHub = hub;
}

export function setSubagentSpawner(fn: SubagentSpawnerFn): void {
  subagentSpawner = fn;
}

// ---------- Tools ----------

export function register(registry: ToolRegistry): void {
  registry.register({
    name: "sessions_list",
    description: "List active and recent sessions",
    parameters: z.object({}),
    async handler() {
      if (!sessionStore) return { sessions: [], note: "session store not connected" };
      return { sessions: sessionStore.list() };
    },
    toolset: "comms",
  });

  registry.register({
    name: "sessions_history",
    description: "Get message history for a session",
    parameters: z.object({ sessionId: z.string(), limit: z.number().int().positive().optional() }),
    async handler(args) {
      const { sessionId, limit } = args as { sessionId: string; limit?: number };
      if (!sessionStore) return { messages: [], note: "session store not connected" };
      return { messages: sessionStore.history(sessionId, limit ?? 50) };
    },
    toolset: "comms",
  });

  registry.register({
    name: "sessions_send",
    description: "Send a message into an existing session (routes to its active channel if any)",
    parameters: z.object({ sessionId: z.string(), text: z.string() }),
    async handler(args) {
      const { sessionId, text } = args as { sessionId: string; text: string };
      if (!sessionStore?.send) return { ok: false, error: "session send not connected" };
      await sessionStore.send(sessionId, text);
      return { ok: true };
    },
    toolset: "comms",
  });

  registry.register({
    name: "sessions_spawn",
    description: "Spawn a subagent to work a task in parallel. Returns the subagent's final result.",
    parameters: z.object({
      task: z.string(),
      toolset: z.string().optional(),
      timeoutMs: z.number().int().positive().optional(),
    }),
    async handler(args) {
      const { task, toolset, timeoutMs } = args as { task: string; toolset?: string; timeoutMs?: number };
      if (!subagentSpawner) return { ok: false, error: "subagent spawner not connected" };
      const result = await subagentSpawner(task, { toolset, timeoutMs });
      return { ok: true, result };
    },
    toolset: "comms",
  });

  registry.register({
    name: "channel_send",
    description: "Proactively send a message to a transport channel (e.g., telegram, discord, signal, email). target is a channel-specific identifier (telegram chat id, discord channel id, email address).",
    parameters: z.object({ channel: z.string(), target: z.string(), text: z.string() }),
    async handler(args) {
      const { channel, target, text } = args as { channel: string; target: string; text: string };
      if (!transportHub) return { ok: false, error: "transport hub not connected" };
      return await transportHub.send(channel, target, text);
    },
    toolset: "comms",
  });
}
