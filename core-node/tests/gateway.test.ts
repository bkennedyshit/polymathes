import { describe, it, expect, vi, beforeAll } from "vitest";
import { createApp } from "../src/gateway/server.js";
import type { RuntimeContext } from "../src/main.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { z } from "zod";

// Mock auth to use a known token
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
  const toolRegistry = new ToolRegistry();
  toolRegistry.register({
    name: "test.echo",
    description: "echoes input",
    parameters: z.object({ text: z.string() }),
    handler: async (args: any) => args.text,
  });
  return {
    config: { runtime: { port: 18789 } } as any,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any,
    db: {} as any,
    audit: { record: vi.fn() } as any,
    policy: {} as any,
    mcpRegistry: {} as any,
    toolRegistry,
    transports: [],
    runTask: async (text: string) => `echo: ${text}`,
    shutdown: async () => {},
  };
}

describe("gateway", () => {
  let app: ReturnType<typeof createApp>;

  beforeAll(() => {
    app = createApp(makeCtx());
  });

  it("GET /health returns 200", async () => {
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(body.uptime).toBeTypeOf("number");
  });

  it("GET /api/tools requires auth token", async () => {
    const res = await app.request("/api/tools");
    expect(res.status).toBe(401);
  });

  it("GET /api/tools with valid token returns tool list", async () => {
    const res = await app.request("/api/tools", { headers: { authorization: "Bearer test-token" } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body[0].function.name).toBe("test.echo");
  });
});
