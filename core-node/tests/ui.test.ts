import { describe, it, expect, vi, beforeAll } from "vitest";
import { createApp } from "../src/gateway/server.js";
import type { RuntimeContext } from "../src/main.js";
import { ToolRegistry } from "../src/tools/registry.js";
import Database from "better-sqlite3";

vi.mock("../src/gateway/auth.js", () => ({
  loadToken: () => "test-token",
  authMiddleware: () => {
    return async (c: any, next: any) => {
      const path = new URL(c.req.url).pathname;
      if (!path.startsWith("/api/")) return next();
      const header = c.req.header("authorization");
      if (header !== "Bearer test-token") return c.json({ error: "unauthorized" }, 401);
      return next();
    };
  },
}));

function makeCtx(): RuntimeContext {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE IF NOT EXISTS audit (id TEXT PRIMARY KEY, ts TEXT NOT NULL, session_id TEXT, tool_name TEXT, args TEXT, outcome TEXT, duration_ms INTEGER, error TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  db.exec(`CREATE TABLE IF NOT EXISTS cron_jobs (id TEXT PRIMARY KEY, cron_expr TEXT NOT NULL, agent_id TEXT, task TEXT, channel TEXT, enabled INTEGER DEFAULT 1, last_run TEXT, next_run TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  db.exec(`CREATE TABLE IF NOT EXISTS approvals (id TEXT PRIMARY KEY, tool_name TEXT, args TEXT, session_id TEXT, status TEXT DEFAULT 'pending', created_at TEXT NOT NULL DEFAULT (datetime('now')), resolved_at TEXT, decision TEXT)`);
  db.exec(`CREATE TABLE IF NOT EXISTS pairings (id TEXT PRIMARY KEY, channel TEXT, sender_id TEXT, code TEXT, status TEXT DEFAULT 'pending', created_at TEXT NOT NULL DEFAULT (datetime('now')), approved_at TEXT)`);
  db.prepare("INSERT INTO audit (id, ts, tool_name, outcome) VALUES (?, ?, ?, ?)").run("a1", "2025-01-01T00:00:00Z", "test.tool", "allow");

  const toolRegistry = new ToolRegistry();
  return {
    config: {
      runtime: { home_dir: "~/.polymath", port: 18789, log_level: "info" },
      llm: { provider: "openai", model: "gpt-4o", api_key: "sk-secret123", base_url: "https://api.openai.com/v1", streaming: true, context_window: 128000, temperature: 0.7 },
      orchestrator: { max_iterations: 25, max_token_budget: 200000, max_subagent_depth: 3 },
      sandbox: { default_mode: "host", tool_overrides: {} },
      channels: { telegram: { token: "tg-secret", enabled: false }, discord: { token: "dc-secret", enabled: false }, signal: { enabled: false }, email: { imap: "", smtp: "", enabled: false }, webchat: { enabled: true } },
      mcp_servers: [],
      agents: [],
      memory: { consolidation_model: "gpt-4o-mini", embedding_model: "text-embedding-3-small", recall_weights: { semantic: 0.5, episodic: 0.3, recency: 0.2 } },
      cron: { enabled: true },
    } as any,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any,
    db,
    audit: { record: vi.fn() } as any,
    policy: {} as any,
    mcpRegistry: {} as any,
    toolRegistry,
    transports: [],
    runTask: async (text: string) => `echo: ${text}`,
    shutdown: async () => {},
  };
}

describe("control UI", () => {
  let app: ReturnType<typeof createApp>;

  beforeAll(() => {
    app = createApp(makeCtx());
  });

  it("GET / returns 200 with HTML content", async () => {
    const res = await app.request("/");
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("<!DOCTYPE html>");
    expect(text).toContain("Polymath Control");
  });

  it("GET /api/audit returns array", async () => {
    const res = await app.request("/api/audit", { headers: { authorization: "Bearer test-token" } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThan(0);
    expect(body[0].tool_name).toBe("test.tool");
  });

  it("GET /api/config masks api_key", async () => {
    const res = await app.request("/api/config", { headers: { authorization: "Bearer test-token" } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.llm.api_key).toBe("***");
    expect(body.channels.telegram.token).not.toBe("***"); // token != api_key
  });
});
