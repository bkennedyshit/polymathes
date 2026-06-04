import { Hono } from "hono";
import { ulid } from "ulid";
import { createReadStream, readFileSync, mkdirSync, writeFileSync, existsSync, statSync, rmSync, renameSync } from "node:fs";
import { join, dirname, extname, resolve } from "node:path";
import { Readable } from "node:stream";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { authMiddleware, loadToken } from "./auth.js";
import { PairingManager } from "../security/pairing.js";
import { ApprovalQueue } from "../security/approval.js";
import type { RuntimeContext } from "../main.js";
import type { SkillRegistry } from "../skills/registry.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const startTime = Date.now();

// Resolve the UI html across layouts:
//   - src layout (tsx dev): src/gateway/server.ts -> ../ui/index.html
//   - bundled (dist/polymath.cjs): dist/ -> ui/index.html (copied by build.mjs)
function resolveUiHtml(): string {
  const candidates = [
    resolve(__dirname, "..", "ui", "index.html"),
    resolve(__dirname, "ui", "index.html"),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return readFileSync(p, "utf-8");
  }
  return "<!doctype html><h1>Polymath</h1><p>UI bundle not found. Run `pnpm build`.</p>";
}
const UI_HTML = resolveUiHtml();

const MEDIA_MIME: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".svg": "image/svg+xml",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
};

function mediaContentType(path: string): string {
  return MEDIA_MIME[extname(path).toLowerCase()] ?? "application/octet-stream";
}

function findFfmpeg(): string | null {
  const configured = process.env.POLYMATH_FFMPEG;
  const candidates = configured?.trim() ? [configured, "ffmpeg"] : ["ffmpeg"];
  for (const p of candidates) {
    const resolved = p === "ffmpeg" ? p : resolve(p);
    if (resolved === "ffmpeg" || existsSync(resolved)) return resolved;
  }
  return null;
}

async function ensureBrowserVideoPreview(id: string, sourcePath: string): Promise<string> {
  const dir = join(homedir(), ".polymath", "media-previews");
  mkdirSync(dir, { recursive: true });
  const out = join(dir, `${id}.mp4`);
  if (existsSync(out) && statSync(out).size > 0) return out;

  const ffmpeg = findFfmpeg();
  if (!ffmpeg) throw new Error("ffmpeg not found for browser-safe video preview generation");

  const tmp = join(dir, `${id}.tmp.mp4`);
  if (existsSync(tmp)) {
    try { rmSync(tmp, { force: true }); } catch { /* ignore */ }
  }

  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(ffmpeg, [
      "-y",
      "-ss", "0",
      "-i", sourcePath,
      "-t", "30",
      "-vf", "scale='min(1280,iw)':-2",
      "-c:v", "libx264",
      "-pix_fmt", "yuv420p",
      "-preset", "veryfast",
      "-crf", "28",
      "-movflags", "+faststart",
      "-an",
      tmp,
    ], { windowsHide: true });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0 && existsSync(tmp)) {
        try {
          renameSync(tmp, out);
          resolvePromise();
        } catch (e) { reject(e); }
      } else {
        reject(new Error(stderr.slice(-1000) || `ffmpeg exited ${code}`));
      }
    });
  });

  return out;
}

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

  // Enumerate available LLM models.
  // For Ollama / LM Studio / OpenAI-compatible endpoints, probe /v1/models.
  // Cloud providers: return well-known lists.
  app.get("/api/models", async (c) => {
    const provider = ctx.config.llm.provider;
    const currentModel = ctx.config.llm.model;
    const baseUrl = ctx.config.llm.base_url;

    // Codex (subscription) provider — defer to the dedicated discovery
    // cache so we don't double-fetch.
    if (provider === "openai-codex") {
      try {
        const { discoverModels } = await import("../llm/codex/models.js");
        const cache = await discoverModels({ version: "0.1.1" });
        return c.json({
          provider,
          current: currentModel,
          models: cache.models.map((m) => m.id).sort(),
        });
      } catch {
        // ChatGPT-account-tier models. `/v1/models` is gated behind
        // Cloudflare's challenge for non-browser UA so we ship a
        // hardcoded fallback list. Slugs sourced from `~/.codex/models_cache.json`
        // on a real ChatGPT account.
        return c.json({ provider, current: currentModel, models: ["gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "gpt-5.3-codex", "gpt-5.2"] });
      }
    }

    // Providers we can probe at runtime
    const probeProviders = new Set(["ollama", "lmstudio", "openai", "openrouter", "groq", "together"]);
    if (probeProviders.has(provider) && baseUrl) {
      try {
        const headers: Record<string, string> = { "content-type": "application/json" };
        if (ctx.config.llm.api_key) headers.authorization = `Bearer ${ctx.config.llm.api_key}`;
        // Ollama exposes /v1/models but also /api/tags with richer info
        const url = baseUrl.replace(/\/+$/, "") + "/models";
        const res = await fetch(url, { headers, signal: AbortSignal.timeout(4000) });
        if (res.ok) {
          const data: any = await res.json();
          const models = (data?.data ?? data?.models ?? [])
            .map((m: any) => (typeof m === "string" ? m : m.id ?? m.name))
            .filter(Boolean)
            .sort();
          return c.json({ provider, current: currentModel, models });
        }
      } catch { /* fall through to static list */ }
    }

    const staticLists: Record<string, string[]> = {
      anthropic: ["claude-sonnet-4-5", "claude-opus-4-5", "claude-haiku-4-5"],
      google: ["gemini-2.0-flash", "gemini-2.0-pro", "gemini-1.5-pro"],
      openai: ["gpt-4o", "gpt-4o-mini", "o1", "o1-mini"],
    };
    return c.json({ provider, current: currentModel, models: staticLists[provider] ?? [] });
  });

  // Hot-swap LLM provider/model without restart.
  app.post("/api/settings/llm", async (c) => {
    const body = await c.req.json<{ provider?: string; model?: string; base_url?: string; api_key?: string; temperature?: number }>();
    if (body.provider) ctx.config.llm.provider = body.provider;
    if (body.model) ctx.config.llm.model = body.model;
    if (body.base_url !== undefined) ctx.config.llm.base_url = body.base_url;
    if (body.api_key !== undefined) ctx.config.llm.api_key = body.api_key;
    if (body.temperature !== undefined) ctx.config.llm.temperature = body.temperature;

    // Persist to ~/.polymath/polymath.json and rebuild adapter
    try {
      const cfgPath = resolve(homedir(), ".polymath", "polymath.json");
      writeFileSync(cfgPath, JSON.stringify(ctx.config, null, 2), "utf-8");
    } catch { /* ignore persist failure */ }

    // Rebuild the LLM adapter in place
    if (typeof ctx.rebuildLlm === "function") ctx.rebuildLlm();

    return c.json({ ok: true, provider: ctx.config.llm.provider, model: ctx.config.llm.model });
  });

  app.get("/api/tools", (c) => c.json(ctx.toolRegistry.schemas()));

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
    // Serve with no-cache headers so UI updates during development don't get
    // shadowed by the browser's disk cache. Cheap for a ~10KB html file.
    c.header("Cache-Control", "no-cache, no-store, must-revalidate");
    c.header("Pragma", "no-cache");
    c.header("Expires", "0");
    return c.html(UI_HTML.replace("__POLYMATH_TOKEN__", loadToken() ?? ""));
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

  // Doctor — real diagnostic checks (replaces the legacy stub).
  app.get("/api/doctor", async (c) => {
    const checks: Array<{ label: string; status: string; latency_ms?: number; detail?: string }> = [];

    // Gateway HTTP itself — if we can answer this we're up.
    checks.push({ label: "Gateway HTTP", status: "ok" });

    // Database integrity
    if (hasDb) {
      const t0 = Date.now();
      try {
        ctx.db.prepare("SELECT 1").get();
        const integrity = ctx.db.pragma("integrity_check") as Array<{ integrity_check: string }>;
        const okFlag = integrity[0]?.integrity_check === "ok";
        checks.push({
          label: "Database (SQLite)",
          status: okFlag ? "ok" : "error",
          latency_ms: Date.now() - t0,
          detail: okFlag ? undefined : "integrity check failed",
        });
      } catch (e: any) {
        checks.push({
          label: "Database (SQLite)",
          status: "error",
          latency_ms: Date.now() - t0,
          detail: e?.message ?? String(e),
        });
      }
    } else {
      checks.push({ label: "Database (SQLite)", status: "error", detail: "no database connected" });
    }

    // LLM provider — try to list models.
    {
      const t0 = Date.now();
      const provider = ctx.config.llm.provider;
      if (provider === "openai-codex") {
        // Codex auth is its own check below; we just confirm the
        // adapter can resolve a token without erroring.
        try {
          const { ensureFreshToken } = await import("../llm/codex/auth_refresh.js");
          const tokens = await ensureFreshToken();
          checks.push({
            label: `LLM (openai-codex)`,
            status: "ok",
            latency_ms: Date.now() - t0,
            detail: `account ${tokens.account_id}, model ${ctx.config.llm.model}`,
          });
        } catch (e: any) {
          checks.push({
            label: `LLM (openai-codex)`,
            status: "error",
            latency_ms: Date.now() - t0,
            detail: e?.message ?? String(e),
          });
        }
      } else {
        const baseUrl = ctx.config.llm.base_url;
        if (!baseUrl) {
          checks.push({ label: "LLM provider", status: "warn", detail: "no base_url configured" });
        } else {
          try {
            const headers: Record<string, string> = {};
            if (ctx.config.llm.api_key) headers.authorization = `Bearer ${ctx.config.llm.api_key}`;
            const url = baseUrl.replace(/\/+$/, "") + "/models";
            const r = await fetch(url, { headers, signal: AbortSignal.timeout(5_000) });
            checks.push({
              label: `LLM (${provider})`,
              status: r.ok ? "ok" : "error",
              latency_ms: Date.now() - t0,
              detail: r.ok ? `model: ${ctx.config.llm.model}` : `HTTP ${r.status}`,
            });
          } catch (e: any) {
            checks.push({
              label: `LLM (${provider})`,
              status: "error",
              latency_ms: Date.now() - t0,
              detail: e?.message ?? String(e),
            });
          }
        }
      }
    }

    // Codex auth status (T9) — surfaced regardless of active provider so
    // users with imported tokens can see freshness.
    {
      const t0 = Date.now();
      try {
        const { loadAuth } = await import("../llm/codex/auth_store.js");
        const auth = await loadAuth();
        if (!auth) {
          checks.push({ label: "Codex auth", status: "gray", detail: "not configured" });
        } else {
          const ageMs = Date.now() - new Date(auth.last_refresh).getTime();
          const ageMin = Math.round(ageMs / 60000);
          let status: "ok" | "warn" | "error" = "ok";
          if (ageMs > 60 * 60 * 1000) status = "error";
          else if (ageMs > 25 * 60 * 1000) status = "warn";
          checks.push({
            label: "Codex auth",
            status,
            latency_ms: Date.now() - t0,
            detail: `account ${auth.tokens.account_id}, last refresh ${ageMin} min ago`,
          });
        }
      } catch (e: any) {
        checks.push({
          label: "Codex auth",
          status: "error",
          latency_ms: Date.now() - t0,
          detail: e?.message ?? String(e),
        });
      }
    }

    // Embedder — runs against the local Ollama fleet if available, even
    // when the orchestrator is cloud (codex / anthropic / google). Auto-
    // probes localhost:11434 when no explicit fleet URL is configured so
    // the check reflects the same auto-detection boot does.
    {
      const t0 = Date.now();
      const explicit = (ctx.config.memory.embedder_base_url && ctx.config.memory.embedder_base_url.trim())
        ? ctx.config.memory.embedder_base_url
        : (ctx.config.llm.provider === "ollama" || ctx.config.llm.provider === "lmstudio"
              ? ctx.config.llm.base_url
              : undefined);
      let fleetBase = explicit?.replace(/\/v1\/?$/, "");
      // Auto-probe for cloud orchestrators with no explicit fleet URL.
      if (!fleetBase) {
        try {
          const probe = await fetch("http://localhost:11434/api/tags", { signal: AbortSignal.timeout(800) });
          if (probe.ok) fleetBase = "http://localhost:11434";
        } catch { /* no local Ollama */ }
      }
      if (!fleetBase) {
        checks.push({ label: "Embedder", status: "warn", detail: "no local Ollama detected — semantic recall disabled (FTS still works)" });
      } else {
        try {
          const r = await fetch(fleetBase + "/api/embeddings", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              model: ctx.config.memory.embedding_model || "nomic-embed-text",
              prompt: "doctor",
            }),
            signal: AbortSignal.timeout(5_000),
          });
          const body: any = r.ok ? await r.json() : null;
          const haveVec = Array.isArray(body?.embedding) && body.embedding.length > 0;
          checks.push({
            label: "Embedder",
            status: haveVec ? "ok" : "error",
            latency_ms: Date.now() - t0,
            detail: haveVec
              ? `dim ${body.embedding.length}, model ${ctx.config.memory.embedding_model || "nomic-embed-text"}`
              : "no embedding returned (model may not be pulled)",
          });
        } catch (e: any) {
          checks.push({
            label: "Embedder",
            status: "error",
            latency_ms: Date.now() - t0,
            detail: e?.message ?? String(e),
          });
        }
      }
    }

    // MCP servers
    const mcpServers = (ctx.mcpRegistry as any).listServers?.() ?? [];
    for (const s of mcpServers) {
      checks.push({
        label: `MCP: ${s.name}`,
        status: s.health === "connected" ? "ok" : "error",
        detail: `${s.tools} tools`,
      });
    }
    if (mcpServers.length === 0) {
      checks.push({ label: "MCP servers", status: "warn", detail: "none configured" });
    }

    // Tool registry sanity
    const toolCount = ctx.toolRegistry.list().length;
    checks.push({
      label: "Tool registry",
      status: toolCount > 0 ? "ok" : "error",
      detail: `${toolCount} tools registered`,
    });

    // Disk space — best effort.
    try {
      const { statfsSync } = await import("node:fs");
      const stats: any = statfsSync(homedir());
      const freeMb = Math.round((stats.bavail * stats.bsize) / 1024 / 1024);
      checks.push({
        label: "Disk space (HOME)",
        status: freeMb > 1024 ? "ok" : "warn",
        detail: `${freeMb} MB free`,
      });
    } catch {
      checks.push({ label: "Disk space (HOME)", status: "warn", detail: "statfs unavailable" });
    }

    return c.json({
      gateway: "ok",
      db: hasDb ? "ok" : "error",
      llm: checks.find((c) => c.label.startsWith("LLM"))?.status ?? "unchecked",
      mcp_servers: mcpServers,
      tools: toolCount,
      uptime_seconds: Math.floor((Date.now() - startTime) / 1000),
      checks,
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
    return c.json({ id, path: filePath, size: buf.length, name: file.name });
  });

  app.get("/api/file-preview", async (c) => {
    const requestedPath = c.req.query("path");
    if (!requestedPath) return c.json({ error: "path required" }, 400);

    const filePath = resolve(requestedPath);
    if (!existsSync(filePath)) return c.json({ error: "file missing on disk", path: filePath }, 404);
    const stats = statSync(filePath);
    if (!stats.isFile()) return c.json({ error: "not a file", path: filePath }, 400);

    const contentType = mediaContentType(filePath);
    if (!contentType.startsWith("image/") && !contentType.startsWith("video/") && !contentType.startsWith("audio/")) {
      return c.json({ error: "unsupported preview type", path: filePath, content_type: contentType }, 415);
    }

    const filename = filePath.split(/[\\/]/).pop() ?? "preview";
    const baseHeaders: Record<string, string> = {
      "Content-Type": contentType,
      "Accept-Ranges": "bytes",
      "Cache-Control": "private, max-age=60",
      "Content-Disposition": `inline; filename="${filename}"`,
    };

    const range = c.req.header("range");
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!match) return c.body(null, 416);
      const start = match[1] ? parseInt(match[1], 10) : 0;
      const end = match[2] ? Math.min(parseInt(match[2], 10), stats.size - 1) : stats.size - 1;
      if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= stats.size) {
        return c.body(null, 416, { "Content-Range": `bytes */${stats.size}` });
      }
      return new Response(Readable.toWeb(createReadStream(filePath, { start, end })) as any, {
        status: 206,
        headers: {
          ...baseHeaders,
          "Content-Length": String(end - start + 1),
          "Content-Range": `bytes ${start}-${end}/${stats.size}`,
        },
      });
    }

    return new Response(Readable.toWeb(createReadStream(filePath)) as any, {
      headers: {
        ...baseHeaders,
        "Content-Length": String(stats.size),
      },
    });
  });

  app.post("/api/file-reveal", async (c) => {
    const body = await c.req.json<{ path?: string }>().catch(() => ({}));
    if (!body.path) return c.json({ error: "path required" }, 400);

    const filePath = resolve(body.path);
    if (!existsSync(filePath)) return c.json({ error: "file missing on disk", path: filePath }, 404);
    const stats = statSync(filePath);
    if (!stats.isFile()) return c.json({ error: "not a file", path: filePath }, 400);

    if (process.platform === "win32") {
      spawn("explorer.exe", ["/select,", filePath], { detached: true, stdio: "ignore", windowsHide: false }).unref();
      return c.json({ ok: true, action: "reveal", path: filePath });
    }

    const opener = process.platform === "darwin" ? "open" : "xdg-open";
    spawn(opener, [dirname(filePath)], { detached: true, stdio: "ignore" }).unref();
    return c.json({ ok: true, action: "open_parent", path: filePath });
  });

  // ==========================================================
  // Streaming chat over SSE — emits iteration/tool_call/tool_result/final events
  // ==========================================================
  app.post("/api/chat/stream", async (c) => {
    const body = await c.req.json<{ sessionId?: string; text: string }>();
    const sessionId = body.sessionId ?? ulid();

    const stream = new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder();
        const send = (evt: string, data: any) => {
          try {
            controller.enqueue(encoder.encode(`event: ${evt}\ndata: ${JSON.stringify(data)}\n\n`));
          } catch { /* controller closed */ }
        };
        send("session", { sessionId });

        try {
          const answer = await ctx.runTask(body.text, sessionId, (ev: any) => {
            send(ev.type, ev);
          });
          send("done", { sessionId, answer });
        } catch (e: any) {
          send("error", { error: e?.message ?? String(e) });
        } finally {
          try { controller.close(); } catch { /* */ }
        }
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  });

  // ==========================================================
  // Memory — search + stats + session detail
  // ==========================================================
  app.get("/api/memory/stats", (c) => {
    if (!hasDb) return c.json({ error: "no db" }, 500);
    try {
      const episodic = (ctx.db.prepare("SELECT COUNT(*) as n FROM episodic").get() as any).n;
      const sessions = (ctx.db.prepare("SELECT COUNT(*) as n FROM sessions").get() as any).n;
      const semantic = (ctx.db.prepare("SELECT COUNT(*) as n FROM semantic").get() as any).n;
      const tools = (ctx.db.prepare("SELECT COUNT(*) as n FROM audit").get() as any).n;
      return c.json({ episodic, sessions, semantic, tool_calls: tools });
    } catch (e: any) { return c.json({ error: e.message }, 500); }
  });

  app.get("/api/memory/search", (c) => {
    if (!hasDb) return c.json([]);
    const q = c.req.query("q") || "";
    const limit = Math.min(parseInt(c.req.query("limit") || "20", 10), 100);
    if (!q.trim()) return c.json([]);
    try {
      const results = ctx.episodicMemory.recall(q, limit);
      return c.json(results);
    } catch (e: any) { return c.json({ error: e.message }, 500); }
  });

  app.get("/api/memory/session/:id", (c) => {
    if (!hasDb) return c.json([]);
    const id = c.req.param("id");
    const limit = Math.min(parseInt(c.req.query("limit") || "200", 10), 500);
    try {
      const rows = ctx.episodicMemory.recallBySession(id, limit);
      return c.json(rows);
    } catch (e: any) { return c.json({ error: e.message }, 500); }
  });

  app.get("/api/memory/recent", (c) => {
    if (!hasDb) return c.json([]);
    const limit = Math.min(parseInt(c.req.query("limit") || "50", 10), 200);
    try {
      const rows = ctx.db.prepare("SELECT * FROM episodic ORDER BY created_at DESC LIMIT ?").all(limit);
      return c.json(rows);
    } catch (e: any) { return c.json({ error: e.message }, 500); }
  });

  app.get("/api/memory/semantic", (c) => {
    if (!hasDb) return c.json([]);
    const limit = Math.min(parseInt(c.req.query("limit") || "50", 10), 200);
    try {
      const rows = ctx.db.prepare("SELECT id, content, pinned, created_at FROM semantic ORDER BY pinned DESC, created_at DESC LIMIT ?").all(limit);
      return c.json(rows);
    } catch (e: any) { return c.json({ error: e.message }, 500); }
  });

  /**
   * Recent consolidation events — sessions that have been compressed into
   * semantic memory. Joins to a count of semantic facts written from each
   * source session so the Memory UI can show "session X → 5 facts".
   */
  app.get("/api/memory/consolidations", (c) => {
    if (!hasDb) return c.json([]);
    const limit = Math.min(parseInt(c.req.query("limit") || "20", 10), 100);
    try {
      const rows = ctx.db.prepare(`
        SELECT
          s.id as session_id,
          s.consolidated_at,
          s.created_at as session_started_at,
          (SELECT COUNT(*) FROM episodic e WHERE e.session_id = s.id) as turn_count,
          (SELECT COUNT(*) FROM episodic e WHERE e.session_id = s.id AND e.compressed_at IS NOT NULL) as compressed_count,
          (SELECT COUNT(*) FROM semantic se WHERE se.source_session = s.id) as facts_count
        FROM sessions s
        WHERE s.consolidated_at IS NOT NULL
        ORDER BY s.consolidated_at DESC
        LIMIT ?
      `).all(limit);
      return c.json(rows);
    } catch (e: any) { return c.json({ error: e.message }, 500); }
  });

  // Override the real sessions list (the stub above returned []).
  app.get("/api/sessions", (c) => {
    if (!hasDb) return c.json([]);
    try {
      const rows = ctx.db.prepare(`
        SELECT s.id, s.agent_id, s.channel, s.created_at, s.updated_at,
               (SELECT COUNT(*) FROM episodic e WHERE e.session_id = s.id) as msg_count,
               (SELECT MAX(created_at) FROM episodic e WHERE e.session_id = s.id) as last_message_at
        FROM sessions s
        ORDER BY COALESCE(last_message_at, s.updated_at) DESC
        LIMIT 100
      `).all();
      return c.json(rows);
    } catch (e: any) { return c.json({ error: e.message }, 500); }
  });

  app.delete("/api/sessions/:id", (c) => {
    if (!hasDb) return c.json({ error: "no db" }, 500);
    const id = c.req.param("id");
    try {
      ctx.db.prepare("DELETE FROM episodic WHERE session_id = ?").run(id);
      ctx.db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
      return c.json({ ok: true, id });
    } catch (e: any) { return c.json({ error: e.message }, 500); }
  });

  // ==========================================================
  // Skills — search / install / uninstall / reload
  // ==========================================================
  app.get("/api/skills/search", async (c) => {
    const q = c.req.query("q") || "";
    try {
      const { searchSkills } = await import("../skills/hub.js");
      const result = await searchSkills(q);
      if (typeof result === "string") return c.json({ error: result }, 500);
      return c.json(result);
    } catch (e: any) { return c.json({ error: e.message }, 500); }
  });

  app.post("/api/skills/install", async (c) => {
    const body = await c.req.json<{ name: string }>();
    if (!body?.name) return c.json({ error: "name required" }, 400);
    try {
      const { installSkill } = await import("../skills/hub.js");
      const msg = await installSkill(body.name, ctx.config.runtime.home_dir.replace(/^~/, homedir()));
      // Reload skills so the new one registers as a tool.
      if (typeof (ctx as any).reloadSkills === "function") (ctx as any).reloadSkills();
      return c.json({ ok: true, message: msg });
    } catch (e: any) { return c.json({ error: e.message }, 500); }
  });

  app.delete("/api/skills/:name", async (c) => {
    const name = c.req.param("name");
    try {
      const { rmSync } = await import("node:fs");
      const dir = join(ctx.config.runtime.home_dir.replace(/^~/, homedir()), "skills", name);
      rmSync(dir, { recursive: true, force: true });
      if (typeof (ctx as any).reloadSkills === "function") (ctx as any).reloadSkills();
      return c.json({ ok: true, name });
    } catch (e: any) { return c.json({ error: e.message }, 500); }
  });

  app.post("/api/skills/reload", (c) => {
    if (typeof (ctx as any).reloadSkills === "function") (ctx as any).reloadSkills();
    return c.json({ ok: true, count: opts?.skillRegistry?.list().length ?? 0 });
  });

  // ==========================================================
  // Media catalog REST surface (Media UI tab + scriptable access)
  // ==========================================================
  app.get("/api/media/stats", async (c) => {
    if (!hasDb) return c.json({ error: "no db" }, 500);
    try {
      const { MediaEpisodic } = await import("../memory/media_episodic.js");
      const ep = new MediaEpisodic(ctx.db);
      return c.json(ep.stats());
    } catch (e: any) { return c.json({ error: e.message }, 500); }
  });

  app.get("/api/media", async (c) => {
    if (!hasDb) return c.json([]);
    try {
      const { MediaEpisodic } = await import("../memory/media_episodic.js");
      const ep = new MediaEpisodic(ctx.db);
      const filter = {
        brand: c.req.query("brand") ?? undefined,
        category: c.req.query("category") ?? undefined,
        kind: c.req.query("kind") ?? undefined,
        intent: c.req.query("intent") ?? undefined,
        path_glob: c.req.query("path_glob") ?? undefined,
        min_duration_sec: c.req.query("min_duration_sec") ? parseFloat(c.req.query("min_duration_sec")!) : undefined,
        max_duration_sec: c.req.query("max_duration_sec") ? parseFloat(c.req.query("max_duration_sec")!) : undefined,
        modified_after: c.req.query("modified_after") ?? undefined,
        modified_before: c.req.query("modified_before") ?? undefined,
        limit: c.req.query("limit") ? parseInt(c.req.query("limit")!, 10) : 100,
      };
      return c.json(ep.query(filter));
    } catch (e: any) { return c.json({ error: e.message }, 500); }
  });

  app.get("/api/media/:id", async (c) => {
    if (!hasDb) return c.json({ error: "no db" }, 500);
    try {
      const { MediaEpisodic } = await import("../memory/media_episodic.js");
      const ep = new MediaEpisodic(ctx.db);
      const item = ep.getById(c.req.param("id"));
      if (!item) return c.json({ error: "not found" }, 404);
      return c.json(item);
    } catch (e: any) { return c.json({ error: e.message }, 500); }
  });

  app.get("/api/media/:id/file", async (c) => {
    if (!hasDb) return c.json({ error: "no db" }, 500);
    try {
      const { MediaEpisodic } = await import("../memory/media_episodic.js");
      const ep = new MediaEpisodic(ctx.db);
      const item = ep.getById(c.req.param("id"));
      if (!item) return c.json({ error: "not found" }, 404);
      if (!existsSync(item.path)) return c.json({ error: "file missing on disk", path: item.path }, 404);

      const stats = statSync(item.path);
      const contentType = mediaContentType(item.path);
      const inline = c.req.query("download") !== "1";
      const filename = item.path.split(/[\\/]/).pop() ?? item.id;
      const baseHeaders: Record<string, string> = {
        "Content-Type": contentType,
        "Accept-Ranges": "bytes",
        "Cache-Control": "private, max-age=60",
        "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${filename}"`,
      };

      const range = c.req.header("range");
      if (range) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(range);
        if (!match) return c.body(null, 416);
        const start = match[1] ? parseInt(match[1], 10) : 0;
        const end = match[2] ? Math.min(parseInt(match[2], 10), stats.size - 1) : stats.size - 1;
        if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= stats.size) {
          return c.body(null, 416, { "Content-Range": `bytes */${stats.size}` });
        }
        return new Response(Readable.toWeb(createReadStream(item.path, { start, end })) as any, {
          status: 206,
          headers: {
            ...baseHeaders,
            "Content-Length": String(end - start + 1),
            "Content-Range": `bytes ${start}-${end}/${stats.size}`,
          },
        });
      }

      return new Response(Readable.toWeb(createReadStream(item.path)) as any, {
        headers: {
          ...baseHeaders,
          "Content-Length": String(stats.size),
        },
      });
    } catch (e: any) { return c.json({ error: e.message }, 500); }
  });

  app.get("/api/media/:id/preview.mp4", async (c) => {
    if (!hasDb) return c.json({ error: "no db" }, 500);
    try {
      const { MediaEpisodic } = await import("../memory/media_episodic.js");
      const ep = new MediaEpisodic(ctx.db);
      const item = ep.getById(c.req.param("id"));
      if (!item) return c.json({ error: "not found" }, 404);
      if (item.kind !== "video") return c.json({ error: "not a video" }, 400);
      if (!existsSync(item.path)) return c.json({ error: "file missing on disk", path: item.path }, 404);

      const previewPath = await ensureBrowserVideoPreview(item.id, item.path);
      const stats = statSync(previewPath);
      const range = c.req.header("range");
      const baseHeaders: Record<string, string> = {
        "Content-Type": "video/mp4",
        "Accept-Ranges": "bytes",
        "Cache-Control": "private, max-age=3600",
        "Content-Disposition": `inline; filename="${item.id}-preview.mp4"`,
      };

      if (range) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(range);
        if (!match) return c.body(null, 416);
        const start = match[1] ? parseInt(match[1], 10) : 0;
        const end = match[2] ? Math.min(parseInt(match[2], 10), stats.size - 1) : stats.size - 1;
        if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= stats.size) {
          return c.body(null, 416, { "Content-Range": `bytes */${stats.size}` });
        }
        return new Response(Readable.toWeb(createReadStream(previewPath, { start, end })) as any, {
          status: 206,
          headers: {
            ...baseHeaders,
            "Content-Length": String(end - start + 1),
            "Content-Range": `bytes ${start}-${end}/${stats.size}`,
          },
        });
      }

      return new Response(Readable.toWeb(createReadStream(previewPath)) as any, {
        headers: { ...baseHeaders, "Content-Length": String(stats.size) },
      });
    } catch (e: any) { return c.json({ error: e.message }, 500); }
  });

  app.get("/api/media/:id/pipeline", async (c) => {
    if (!hasDb) return c.json([]);
    try {
      const { MediaWorkflow } = await import("../memory/media_workflow.js");
      const wf = new MediaWorkflow(ctx.db);
      return c.json(wf.pipelineFor(c.req.param("id")));
    } catch (e: any) { return c.json({ error: e.message }, 500); }
  });

  app.get("/api/media/unposted/:step", async (c) => {
    if (!hasDb) return c.json({ source_ids: [] });
    try {
      const { MediaWorkflow } = await import("../memory/media_workflow.js");
      const wf = new MediaWorkflow(ctx.db);
      const ids = wf.sourcesMissingStep(c.req.param("step"), {
        brand: c.req.query("brand") ?? undefined,
        category: c.req.query("category") ?? undefined,
        limit: c.req.query("limit") ? parseInt(c.req.query("limit")!, 10) : 50,
      });
      return c.json({ source_ids: ids });
    } catch (e: any) { return c.json({ error: e.message }, 500); }
  });

  // ==========================================================
  // MCP server management — add / remove / test
  // ==========================================================
  app.post("/api/mcp", async (c) => {
    const body = await c.req.json<{ name: string; command: string; args?: string[]; env?: Record<string, string> }>();
    if (!body?.name || !body?.command) return c.json({ error: "name + command required" }, 400);

    // Persist to config
    const newServer = { name: body.name, command: body.command, args: body.args ?? [], env: body.env };
    const existing = ctx.config.mcp_servers.findIndex((s) => s.name === body.name);
    if (existing >= 0) ctx.config.mcp_servers[existing] = newServer as any;
    else ctx.config.mcp_servers.push(newServer as any);

    try {
      const cfgPath = resolve(homedir(), ".polymath", "polymath.json");
      writeFileSync(cfgPath, JSON.stringify(ctx.config, null, 2), "utf-8");
    } catch { /* ignore */ }

    // Start/restart the server
    try {
      await (ctx.mcpRegistry as any).stop?.(body.name);
    } catch { /* ignore */ }
    try {
      await (ctx.mcpRegistry as any).start?.(newServer);
      return c.json({ ok: true, name: body.name });
    } catch (e: any) {
      return c.json({ ok: false, error: e?.message ?? String(e) }, 500);
    }
  });

  app.delete("/api/mcp/:name", async (c) => {
    const name = c.req.param("name");
    const idx = ctx.config.mcp_servers.findIndex((s) => s.name === name);
    if (idx < 0) return c.json({ error: "not found" }, 404);
    ctx.config.mcp_servers.splice(idx, 1);

    try {
      const cfgPath = resolve(homedir(), ".polymath", "polymath.json");
      writeFileSync(cfgPath, JSON.stringify(ctx.config, null, 2), "utf-8");
    } catch { /* ignore */ }

    try { await (ctx.mcpRegistry as any).stop?.(name); } catch { /* */ }
    return c.json({ ok: true, name });
  });

  // ==========================================================
  // Channel / transport configuration
  // ==========================================================
  app.post("/api/settings/channels", async (c) => {
    const body = await c.req.json<any>();
    // Merge only known keys onto config.channels.
    const ch = ctx.config.channels;
    if (body.telegram) ch.telegram = { ...ch.telegram, ...body.telegram };
    if (body.discord) ch.discord = { ...ch.discord, ...body.discord };
    if (body.signal) ch.signal = { ...ch.signal, ...body.signal };
    if (body.email) ch.email = { ...ch.email, ...body.email };
    if (body.webchat) ch.webchat = { ...ch.webchat, ...body.webchat };

    try {
      const cfgPath = resolve(homedir(), ".polymath", "polymath.json");
      writeFileSync(cfgPath, JSON.stringify(ctx.config, null, 2), "utf-8");
    } catch { /* ignore */ }

    return c.json({ ok: true, channels: ch, note: "Restart the gateway to connect newly-enabled transports." });
  });

  // ==========================================================
  // Quick actions — trigger a builtin or MCP tool directly
  // ==========================================================
  app.post("/api/actions/invoke", async (c) => {
    const body = await c.req.json<{ tool: string; args?: any; sessionId?: string }>();
    if (!body?.tool) return c.json({ error: "tool required" }, 400);
    try {
      const sid = body.sessionId || `ui-${ulid()}`;
      // MCP-namespaced tools (e.g. "media-memory.media_index") live in the
      // McpRegistry, NOT the builtin ToolRouter. Detect the namespaced form
      // and route it directly to the MCP server. Builtin tools (no dot, or
      // a dot that doesn't match a connected MCP server) fall through to
      // the ToolRouter.
      const dot = body.tool.indexOf(".");
      if (dot > 0 && (ctx as any).mcpRegistry?.resolveTool) {
        const resolved = (ctx as any).mcpRegistry.resolveTool(body.tool);
        if (resolved) {
          const serverName = body.tool.slice(0, dot);
          const toolName = body.tool.slice(dot + 1);
          const result = await (ctx as any).mcpRegistry.callTool(serverName, toolName, body.args ?? {});
          return c.json({ ok: true, result });
        }
      }
      const result = await ctx.toolRouter.invoke(body.tool, body.args ?? {}, { sessionId: sid });
      return c.json({ ok: true, result });
    } catch (e: any) {
      return c.json({ ok: false, error: e?.message ?? String(e) }, 500);
    }
  });

  // ==========================================================
  // GPU Broker — state, claim, release, evacuate
  // ==========================================================
  app.get("/api/gpu/state", (c) => {
    if (!(ctx as any).gpuBroker) return c.json({ dormant: true });
    return c.json((ctx as any).gpuBroker.getState());
  });

  app.post("/api/gpu/claim", async (c) => {
    if (!(ctx as any).gpuBroker) return c.json({ ok: false, error: "broker dormant" }, 400);
    const body = await c.req.json<{ owner: string; reason?: string; hold_minutes?: number; vram_gb?: number }>();
    const res = await (ctx as any).gpuBroker.claim({
      owner: body.owner ?? "unknown",
      reason: body.reason,
      holdMs: body.hold_minutes ? body.hold_minutes * 60 * 1000 : undefined,
      vramNeededMb: body.vram_gb ? body.vram_gb * 1024 : undefined,
    });
    return c.json(res);
  });

  app.post("/api/gpu/release", async (c) => {
    if (!(ctx as any).gpuBroker) return c.json({ ok: true });
    const body = await c.req.json<{ token: string }>();
    return c.json(await (ctx as any).gpuBroker.release(body.token));
  });

  app.post("/api/gpu/evacuate", async (c) => {
    if (!(ctx as any).gpuBroker) return c.json({ ok: true });
    await (ctx as any).gpuBroker.evacuateOllama();
    return c.json({ ok: true });
  });

  // ==========================================================
  // Codex (ChatGPT subscription) auth — import / login / status / logout
  // ==========================================================
  app.get("/api/auth/codex/status", async (c) => {
    const { loadAuth } = await import("../llm/codex/auth_store.js");
    const auth = await loadAuth();
    if (!auth) {
      return c.json({ configured: false });
    }
    const ageMs = Date.now() - new Date(auth.last_refresh).getTime();
    let state: "fresh" | "stale" | "expired" = "fresh";
    if (ageMs > 60 * 60 * 1000) state = "expired";
    else if (ageMs > 25 * 60 * 1000) state = "stale";

    let modelsCache: any = null;
    try {
      const { loadModelsCache } = await import("../llm/codex/models.js");
      modelsCache = loadModelsCache();
    } catch { /* swallow */ }

    return c.json({
      configured: true,
      account_id: auth.tokens.account_id,
      last_refresh: auth.last_refresh,
      state,
      age_minutes: Math.round(ageMs / 60_000),
      models: modelsCache
        ? { fetched_at: modelsCache.fetched_at, count: modelsCache.models.length }
        : null,
    });
  });

  app.post("/api/auth/codex/import", async (c) => {
    try {
      const { importCodexAuth } = await import("../llm/codex/import_codex.js");
      const { account_id } = await importCodexAuth({ yes: true });
      // Update the live config so the doctor and adapter see the new state.
      ctx.config.llm.codex_account_id = account_id;
      return c.json({ ok: true, account_id });
    } catch (e: any) {
      return c.json({ ok: false, error: e?.message ?? String(e) }, 400);
    }
  });

  app.post("/api/auth/codex/logout", async (c) => {
    const { wipeAuth } = await import("../llm/codex/auth_store.js");
    await wipeAuth();
    delete ctx.config.llm.codex_account_id;
    return c.json({ ok: true });
  });

  /**
   * SSE-style login flow. Browsers can't `EventSource` POST, so we accept
   * GET here and emit progress events as the OAuth dance unfolds.
   * Settings UI binds to this; CLI uses `polymath llm login` instead.
   */
  app.get("/api/auth/codex/login", async (c) => {
    const { loginCodex } = await import("../llm/codex/oauth_login.js");
    const stream = new ReadableStream({
      start(controller) {
        const enc = new TextEncoder();
        const send = (event: string, data: any) => {
          controller.enqueue(enc.encode(`event: ${event}\n`));
          controller.enqueue(enc.encode(`data: ${JSON.stringify(data)}\n\n`));
        };
        loginCodex({ onProgress: (msg) => send("progress", { msg }) })
          .then((result) => {
            ctx.config.llm.codex_account_id = result.account_id;
            send("done", { account_id: result.account_id });
            controller.close();
          })
          .catch((err) => {
            send("error", { error: err?.message ?? String(err) });
            controller.close();
          });
      },
    });
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  });

  /**
   * Codex models discovery — wraps the 24h cache in `models.ts`.
   * Settings UI populates the model dropdown from here when provider
   * is set to `openai-codex`.
   */
  app.get("/api/auth/codex/models", async (c) => {
    try {
      const refresh = c.req.query("refresh") === "1";
      const { discoverModels } = await import("../llm/codex/models.js");
      const cache = await discoverModels({ version: "0.1.1", refresh });
      return c.json(cache);
    } catch (e: any) {
      const message = e?.message ?? String(e);
      if (message.includes("HTTP 403") || message.includes("HTTP 404")) {
        const { loadAuth } = await import("../llm/codex/auth_store.js");
        const auth = await loadAuth().catch(() => null);
        return c.json({
          account_id: ctx.config.llm.codex_account_id ?? auth?.tokens?.account_id ?? null,
          fetched_at: new Date().toISOString(),
          models: [
            { id: "gpt-5.5", name: "gpt-5.5" },
            { id: "gpt-5.4", name: "gpt-5.4" },
            { id: "gpt-5.4-mini", name: "gpt-5.4-mini" },
            { id: "gpt-5.3-codex", name: "gpt-5.3-codex" },
            { id: "gpt-5.2", name: "gpt-5.2" },
          ],
          fallback: true,
          warning: "Codex model discovery was blocked, using known ChatGPT subscription model slugs.",
        });
      }
      return c.json({ ok: false, error: message }, 500);
    }
  });

  return app;
}
