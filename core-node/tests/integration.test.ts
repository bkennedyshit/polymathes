import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { openDb } from "../src/db/open.js";
import { runMigrations } from "../src/db/migrate.js";
import { AuditWriter } from "../src/audit/writer.js";
import { SandboxPolicySchema } from "../src/sandbox/policy.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { ToolRouter } from "../src/tools/router.js";
import { ApprovalQueue } from "../src/security/approval.js";
import { OpenAiAdapter } from "../src/llm/openai.js";
import { WorkingMemory } from "../src/memory/working.js";
import { EpisodicMemory } from "../src/memory/episodic.js";
import { runEpisode } from "../src/orchestrator/loop.js";
import { discoverTools } from "../src/tools/discover.js";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { unlinkSync } from "node:fs";
import type Database from "better-sqlite3";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_DB = join(tmpdir(), `polymath-integration-${Date.now()}.db`);

function createMockOpenAiServer(answer: string): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          choices: [{
            message: {
              role: "assistant",
              tool_calls: [{
                id: "tc_1",
                type: "function",
                function: { name: "core.final_answer", arguments: JSON.stringify({ answer }) },
              }],
            },
            finish_reason: "tool_calls",
          }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }));
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({ server, port: addr.port });
    });
  });
}

describe("integration: full boot → runTask → persist", () => {
  let db: Database.Database;
  let mockServer: Server;
  let mockPort: number;

  afterEach(async () => {
    mockServer?.close();
    db?.close();
    try { unlinkSync(TEST_DB); } catch {}
    try { unlinkSync(TEST_DB + "-wal"); } catch {}
    try { unlinkSync(TEST_DB + "-shm"); } catch {}
  });

  it("runs a task end-to-end and persists episode", async () => {
    // Start mock OpenAI
    ({ server: mockServer, port: mockPort } = await createMockOpenAiServer("4"));

    // Setup DB
    db = openDb(TEST_DB);
    runMigrations(db);

    // Setup components
    const audit = new AuditWriter(db);
    const policy = SandboxPolicySchema.parse({});
    const approvalQueue = new ApprovalQueue(db);
    const toolRegistry = new ToolRegistry();
    await discoverTools(toolRegistry, join(__dirname, "..", "src", "tools", "builtin"));

    const llm = new OpenAiAdapter({
      base_url: `http://127.0.0.1:${mockPort}`,
      api_key: "test-key",
      model: "test-model",
      streaming: false,
    });

    const toolRouter = new ToolRouter(toolRegistry, policy, audit, approvalQueue, {
      timeoutMs: 60_000,
      maxResultSize: 256 * 1024,
      sessionId: "",
    });

    const episodicMemory = new EpisodicMemory(db);
    const sessionId = "test-session-1";

    // Create session row
    db.prepare("INSERT INTO sessions (id) VALUES (?)").run(sessionId);

    // Run task
    const memory = new WorkingMemory();
    const result = await runEpisode("what is 2+2", {
      llm,
      router: toolRouter,
      registry: toolRegistry,
      memory,
      maxIterations: 10,
      maxTokenBudget: 100_000,
      contextWindow: 50_000,
      sessionId,
    });

    expect(result.status).toBe("completed");
    expect(result.finalAnswer).toBe("4");

    // Persist
    episodicMemory.store(sessionId, "user", "what is 2+2");
    episodicMemory.store(sessionId, "assistant", result.finalAnswer!);

    // Verify persistence
    const rows = db.prepare("SELECT * FROM episodic WHERE session_id = ? ORDER BY created_at").all(sessionId) as any[];
    expect(rows).toHaveLength(2);
    expect(rows[0].role).toBe("user");
    expect(rows[0].content).toBe("what is 2+2");
    expect(rows[1].role).toBe("assistant");
    expect(rows[1].content).toBe("4");
  });

  it("handles plain text response (no tool calls)", async () => {
    // Mock that returns plain text instead of tool call
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          choices: [{ message: { role: "assistant", content: "The answer is 4" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    mockServer = server;

    db = openDb(TEST_DB);
    runMigrations(db);

    const audit = new AuditWriter(db);
    const policy = SandboxPolicySchema.parse({});
    const approvalQueue = new ApprovalQueue(db);
    const toolRegistry = new ToolRegistry();
    await discoverTools(toolRegistry, join(__dirname, "..", "src", "tools", "builtin"));

    const llm = new OpenAiAdapter({
      base_url: `http://127.0.0.1:${port}`,
      api_key: "test-key",
      model: "test-model",
      streaming: false,
    });

    const toolRouter = new ToolRouter(toolRegistry, policy, audit, approvalQueue);
    const sessionId = "test-session-2";
    db.prepare("INSERT INTO sessions (id) VALUES (?)").run(sessionId);

    const memory = new WorkingMemory();
    const result = await runEpisode("what is 2+2", {
      llm,
      router: toolRouter,
      registry: toolRegistry,
      memory,
      maxIterations: 10,
      maxTokenBudget: 100_000,
      contextWindow: 50_000,
      sessionId,
    });

    expect(result.status).toBe("completed");
    expect(result.finalAnswer).toBe("The answer is 4");
  });
});
