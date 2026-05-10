import { loadConfig } from "./config/load.js";
import { createLogger } from "./log.js";
import { openDb } from "./db/open.js";
import { runMigrations } from "./db/migrate.js";
import { AuditWriter } from "./audit/writer.js";
import { SandboxPolicySchema, type SandboxPolicy } from "./sandbox/policy.js";
import { McpRegistry } from "./tools/mcp/registry.js";
import { ToolRegistry } from "./tools/registry.js";
import { ToolRouter } from "./tools/router.js";
import { discoverTools } from "./tools/discover.js";
import { ApprovalQueue } from "./security/approval.js";
import { OpenAiAdapter } from "./llm/openai.js";
import { AnthropicAdapter } from "./llm/anthropic.js";
import { GoogleAdapter } from "./llm/google.js";
import { GoogleAdapter } from "./llm/google.js";
import { WorkingMemory } from "./memory/working.js";
import { EpisodicMemory } from "./memory/episodic.js";
import { runEpisode } from "./orchestrator/loop.js";
import { spawnSubagent } from "./sessions/subagent.js";
import { CronScheduler } from "./cron/scheduler.js";
import { SkillRegistry } from "./skills/registry.js";
import { setScheduler } from "./tools/builtin/cron.js";
import { setSessionStore, setTransportHub, setSubagentSpawner, type SessionStoreLike, type TransportHubLike } from "./tools/builtin/comms.js";
import { createApp } from "./gateway/server.js";
import { serve } from "@hono/node-server";
import type { Transport } from "./transports/base.js";
import type { AppConfig } from "./config/schema.js";
import type { LlmAdapter } from "./llm/types.js";
import type { Logger } from "pino";
import type Database from "better-sqlite3";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface BootOptions {
  config?: string;
  model?: string;
  verbose?: boolean;
  logLevel?: string;
  maxIterations?: number;
}

export interface RuntimeContext {
  config: AppConfig;
  logger: Logger;
  db: Database.Database;
  audit: AuditWriter;
  policy: SandboxPolicy;
  mcpRegistry: McpRegistry;
  toolRegistry: ToolRegistry;
  toolRouter: ToolRouter;
  llm: LlmAdapter;
  episodicMemory: EpisodicMemory;
  cronScheduler: CronScheduler | null;
  transports: Transport[];
  runTask: (text: string, sessionId?: string) => Promise<string>;
  shutdown: () => Promise<void>;
}

const PROVIDER_DEFAULTS: Record<string, { base_url: string; api_key?: string }> = {
  openai:    { base_url: "https://api.openai.com/v1" },
  anthropic: { base_url: "https://api.anthropic.com" },
  ollama:    { base_url: "http://localhost:11434/v1", api_key: "ollama" },
  lmstudio:  { base_url: "http://localhost:1234/v1",  api_key: "lm-studio" },
  openrouter:{ base_url: "https://openrouter.ai/api/v1" },
  groq:      { base_url: "https://api.groq.com/openai/v1" },
  together:  { base_url: "https://api.together.xyz/v1" },
  google:    { base_url: "https://generativelanguage.googleapis.com" },
};

function createLlmAdapter(config: AppConfig): LlmAdapter {
  const provider = config.llm.provider;
  const defaults = PROVIDER_DEFAULTS[provider] ?? { base_url: "https://api.openai.com/v1" };
  const base_url = config.llm.base_url ?? defaults.base_url;
  const api_key  = config.llm.api_key  || defaults.api_key || "";

  if (provider === "anthropic") {
    return new AnthropicAdapter({ base_url, api_key, model: config.llm.model, streaming: config.llm.streaming });
  }
  if (provider === "google") {
    return new GoogleAdapter({ api_key, model: config.llm.model });
  }
  // openai, ollama, lmstudio, openrouter, groq, together, or any openai-compat endpoint
  return new OpenAiAdapter({ base_url, api_key, model: config.llm.model, streaming: config.llm.streaming });
}

export async function boot(opts: BootOptions = {}): Promise<RuntimeContext> {
  const config = loadConfig(opts.config);
  if (opts.model) config.llm.model = opts.model;
  if (opts.logLevel) config.runtime.log_level = opts.logLevel as AppConfig["runtime"]["log_level"];
  if (opts.maxIterations) config.orchestrator.max_iterations = opts.maxIterations;

  const logger = createLogger(config);
  logger.info("polymath gateway booting");

  const db = openDb();
  runMigrations(db);

  const audit = new AuditWriter(db);
  const policy = SandboxPolicySchema.parse({});
  const episodicMemory = new EpisodicMemory(db);

  // MCP
  const mcpRegistry = new McpRegistry();
  if (config.mcp_servers.length > 0) {
    await mcpRegistry.startAll(config.mcp_servers);
  }

  // Tools
  const toolRegistry = new ToolRegistry();
  await discoverTools(toolRegistry, join(__dirname, "tools", "builtin"));

  // Skills
  const skillRegistry = new SkillRegistry();
  skillRegistry.discover(config.runtime.home_dir, toolRegistry);

  // LLM
  const llm = createLlmAdapter(config);

  // Router
  const approvalQueue = new ApprovalQueue(db);
  const toolRouter = new ToolRouter(toolRegistry, policy, audit, approvalQueue, {
    timeoutMs: 60_000,
    maxResultSize: 256 * 1024,
    sessionId: "",
  });

  // Cron (declared early so the runTask closure can reference it and the
  // comms setters below can refer to the transport array by closure)
  let cronScheduler: CronScheduler | null = null;
  const transports: Transport[] = [];

  // runTask — creates fresh WorkingMemory per invocation
  const runTask = async (text: string, sessionId?: string): Promise<string> => {
    const sid = sessionId ?? `cli-${Date.now()}`;
    // Ensure session row exists for FK
    db.prepare("INSERT OR IGNORE INTO sessions (id) VALUES (?)").run(sid);

    const memory = new WorkingMemory();
    const result = await runEpisode(text, {
      llm,
      router: toolRouter,
      registry: toolRegistry,
      memory,
      maxIterations: config.orchestrator.max_iterations,
      maxTokenBudget: config.orchestrator.max_token_budget,
      contextWindow: config.llm.context_window,
      sessionId: sid,
    });

    // Persist episode
    episodicMemory.store(sid, "user", text);
    if (result.finalAnswer) {
      episodicMemory.store(sid, "assistant", result.finalAnswer);
    }

    return result.finalAnswer ?? `[${result.status}]`;
  };

  // ---- Wire connective tools (subagent, transport hub, session store) ----

  // Session store — backed by sessions table + episodic memory.
  const sessionStore: SessionStoreLike = {
    list() {
      try {
        return db.prepare(
          "SELECT id, created_at, last_active_at FROM sessions ORDER BY COALESCE(last_active_at, created_at) DESC LIMIT 50",
        ).all() as Array<{ id: string; created_at?: string; last_active_at?: string }>;
      } catch {
        return [];
      }
    },
    history(sessionId: string, limit = 50) {
      return episodicMemory
        .recallBySession(sessionId, limit)
        .map((e) => ({ role: e.role, content: e.content, created_at: e.created_at }));
    },
    async send(sessionId: string, text: string) {
      // Record the inbound message in episodic memory so the next iteration
      // on that session can see it. Actual delivery to a live channel is
      // routed through the transport hub when a channel binding exists.
      episodicMemory.store(sessionId, "user", text);
    },
  };

  // Transport hub — thin adapter over the transports[] array.
  const transportHub: TransportHubLike = {
    list() {
      return transports.map((t) => ({ name: t.name }));
    },
    async send(channel: string, target: string, text: string) {
      const t = transports.find((x) => x.name === channel);
      if (!t) return { ok: false, error: `channel '${channel}' not connected` };
      try {
        await t.send(target, text);
        return { ok: true };
      } catch (e: any) {
        return { ok: false, error: e?.message ?? String(e) };
      }
    },
  };

  // Subagent spawner — shares the parent's LLM, router, registry; gets its
  // own WorkingMemory per spawn. Depth is enforced inside spawnSubagent.
  const subagentSpawner = async (
    task: string,
    spawnOpts?: { toolset?: string; timeoutMs?: number },
  ) => {
    // The parent's sessionId isn't known at setter time; comms.ts passes it
    // indirectly through the orchestrator's tool context. For v1 we use a
    // synthetic parent id so depth counting still works across chained spawns.
    const parentSessionId = "subagent-root";
    const signal = spawnOpts?.timeoutMs
      ? AbortSignal.timeout(spawnOpts.timeoutMs)
      : undefined;
    const result = await spawnSubagent(task, {
      parentSessionId,
      ctx: {
        llm,
        router: toolRouter,
        registry: toolRegistry,
        memory: new WorkingMemory(),
        maxIterations: config.orchestrator.max_iterations,
        maxTokenBudget: config.orchestrator.max_token_budget,
        contextWindow: config.llm.context_window,
      },
      signal,
    });
    return {
      status: result.status,
      finalAnswer: result.finalAnswer,
      iterations: result.iterations,
      tokens: result.totalTokens,
    };
  };

  setSessionStore(sessionStore);
  setTransportHub(transportHub);
  setSubagentSpawner(subagentSpawner);

  // Skill invocation context — returns a fresh episode ctx for the skill's
  // subagent to run inside.
  skillRegistry.setContextProvider(() => ({
    llm,
    router: toolRouter,
    registry: toolRegistry,
    memory: new WorkingMemory(),
    maxIterations: config.orchestrator.max_iterations,
    maxTokenBudget: config.orchestrator.max_token_budget,
    contextWindow: config.llm.context_window,
    sessionId: `skill-${Date.now()}`,
  }));

  // ---- Cron ----
  if (config.cron.enabled) {
    cronScheduler = new CronScheduler({
      db,
      onFire: async (job) => {
        const task = job.task ?? "scheduled task (no prompt)";
        logger.info(`cron fired: ${job.id}`);
        await runTask(task, `cron-${job.id}-${Date.now()}`);
      },
      logger: { warn: (m) => logger.warn(m), info: (m) => logger.info(m) },
    });
    cronScheduler.start();
    setScheduler(cronScheduler);
  }

  const shutdown = async () => {
    logger.info("shutting down");
    cronScheduler?.stop();
    for (const t of transports) await t.stop();
    await mcpRegistry.shutdownAll();
    db.close();
  };

  process.on("SIGINT", () => void shutdown().then(() => process.exit(0)));
  process.on("SIGTERM", () => void shutdown().then(() => process.exit(0)));

  return { config, logger, db, audit, policy, mcpRegistry, toolRegistry, toolRouter, llm, episodicMemory, cronScheduler, transports, runTask, shutdown };
}

export function startGateway(ctx: RuntimeContext) {
  const app = createApp(ctx as any);
  const port = ctx.config.runtime.port;
  serve({ fetch: app.fetch, port }, () => {
    ctx.logger.info(`polymath gateway listening on http://localhost:${port}`);
  });
  return app;
}
