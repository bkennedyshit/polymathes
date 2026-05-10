import { Hono } from "hono";
import { ulid } from "ulid";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname, extname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { authMiddleware } from "./auth.js";
import { PairingManager } from "../security/pairing.js";
import { ApprovalQueue } from "../security/approval.js";
import type { RuntimeContext } from "../main.js";
import type { SkillRegistry } from "../skills/registry.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const startTime = Date.now();

export interface CreateAppOpts {
  skillRegistry?: SkillRegistry;
}

export function createApp(ctx: RuntimeContext, opts?: CreateAppOpts) {
  const app = new Hono();
  const hasDb = ctx.db && typeof (ctx.db as any).prepare === "function";
  const approvalQueue = hasDb ? new ApprovalQueue(ctx.db) : undefined;
  const pairingManager = hasDb ? new PairingManager(ctx.db) : undefined;

  app.use("*", authMiddleware());

  app.get("/health", (c) => c.json({ status: "ok", uptime: Date.now() - startTime }));

  app.get("/metrics", (c) =>
    c.json({ tools: ctx.toolRegistry.list().length, sessions: 0, uptime: Date.now() - startTime }),
  );

  app.post("/api/chat", async (c) => {
    const body = await c.req.json<{ sessionId?: string; text: string }>();
    const sessionId = body.sessionId ?? ulid();
    const answer = await (ctx.runTask?.(body.text) ?? Promise.resolve(""));
    return c.json({ answer, sessionId });
  });

  app.get("/api/tools", (c) => c.json(ctx.toolRegistry.schemas()));

  app.get("/api/sessions", (c) => c.json([]));

  // Approvals
  app.get("/api/approvals", (c) => {
    if (!hasDb) return c.json([]);
    const rows = ctx.db.prepare("SELECT * FROM approvals WHERE status = 'pending'").all();
    return c.json(rows);
  });

  app.post("/api/approvals/:id", async (c) => {
    const { decision } = await c.req.json<{ decision: "approve" | "deny" }>();
    const id = c.req.param("id");
    approvalQueue?.resolve(id, decision === "approve");
    return c.json({ id, decision, applied: true });
  });

  // Pairings
  app.get("/api/pairings", (c) => {
    const rows = pairingManager?.listPending() ?? [];
    return c.json(rows);
  });

  app.post("/api/pairings/:code/approve", async (c) => {
    const code = c.req.param("code");
    pairingManager?.approvePairing(code);
    return c.json({ code, status: "approved" });
  });

  app.post("/api/pairings/:code/deny", async (c) => {
    const code = c.req.param("code");
    pairingManager?.denyPairing(code);
    return c.json({ code, status: "denied" });
  });

  // UI
  app.get("/", (c) => {
    const html = readFileSync(join(__dirname, "..", "ui", "index.html"), "utf-8");
    return c.html(html);
  });

  // Skills
  app.get("/api/skills", (c) => {
    const skills = opts?.skillRegistry?.list() ?? [];
    return c.json(skills);
  });

  // Cron
  app.get("/api/cron", (c) => {
    if (!hasDb) return c.json([]);
    try {
      const rows = ctx.db.prepare("SELECT * FROM cron_jobs").all();
      return c.json(rows);
    } catch { return c.json([]); }
  });

  app.post("/api/cron", async (c) => {
    if (!hasDb) return c.json({ error: "no db" }, 500);
    const body = await c.req.json<{ cron_expr: string; task?: string; agent_id?: string; channel?: string }>();
    const id = ulid();
    ctx.db.prepare("INSERT INTO cron_jobs (id, cron_expr, agent_id, task, channel, enabled) VALUES (?, ?, ?, ?, ?, 1)")
      .run(id, body.cron_expr, body.agent_id ?? null, body.task ?? null, body.channel ?? null);
    return c.json({ id, ...body });
  });

  // Audit
  app.get("/api/audit", (c) => {
    if (!hasDb) return c.json([]);
    try {
      const rows = ctx.db.prepare("SELECT * FROM audit ORDER BY ts DESC LIMIT 50").all();
      return c.json(rows);
    } catch { return c.json([]); }
  });

  // Config (sanitized)
  app.get("/api/config", (c) => {
    const sanitized = JSON.parse(JSON.stringify(ctx.config));
    function mask(obj: any) {
      for (const key of Object.keys(obj)) {
        if (key === "api_key" || key.endsWith("_key")) obj[key] = "***";
        else if (typeof obj[key] === "object" && obj[key] !== null) mask(obj[key]);
      }
    }
    mask(sanitized);
    return c.json(sanitized);
  });

  // Doctor
  app.get("/api/doctor", (c) => {
    let dbStatus: "ok" | "error" = "error";
    if (hasDb) {
      try { ctx.db.prepare("SELECT 1").get(); dbStatus = "ok"; } catch { /* */ }
    }
    const mcpServers = (ctx.mcpRegistry as any).listServers?.() ?? [];
    return c.json({
      gateway: "ok",
      db: dbStatus,
      llm: "unchecked",
      mcp_servers: mcpServers,
      tools: ctx.toolRegistry.list().length,
      uptime_seconds: Math.floor((Date.now() - startTime) / 1000),
    });
  });

  // Channels
  app.get("/api/channels", (c) => {
    const channels = (ctx.transports ?? []).map((t: any) => ({
      name: t.name ?? "unknown",
      status: "connected",
    }));
    return c.json(channels);
  });

  // MCP
  app.get("/api/mcp", (c) => {
    const servers = (ctx.mcpRegistry as any).listServers?.() ?? [];
    return c.json(servers);
  });

  app.post("/api/mcp/:name/reconnect", async (c) => {
    const name = c.req.param("name");
    const ok = await ctx.mcpRegistry.restart(name);
    return c.json({ name, reconnected: ok });
  });

  // Attachments
  app.post("/api/attachments", async (c) => {
    const body = await c.req.parseBody();
    const file = body["file"];
    if (!file || typeof file === "string") return c.json({ error: "no file" }, 400);
    const sessionId = (body["sessionId"] as string) || "default";
    const ext = extname(file.name || ".bin") || ".bin";
    const id = ulid();
    const dir = join(homedir(), ".polymath", "inbox", sessionId);
    mkdirSync(dir, { recursive: true });
    const filePath = join(dir, `${id}${ext}`);
    const buf = Buffer.from(await file.arrayBuffer());
    writeFileSync(filePath, buf);
    return c.json({ path: filePath });
  });

  return app;
}
