import { describe, it, expect, afterEach } from "vitest";
import { z } from "zod";
import { ToolRegistry } from "../src/tools/registry.js";
import { ToolRouter } from "../src/tools/router.js";
import { SandboxPolicySchema, type SandboxPolicy } from "../src/sandbox/policy.js";
import { AuditWriter } from "../src/audit/writer.js";
import { ApprovalQueue } from "../src/security/approval.js";
import { openDb } from "../src/db/open.js";
import { runMigrations } from "../src/db/migrate.js";
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TEST_DB = join(tmpdir(), `polymath-router-test-${Date.now()}.db`);

function setup(policyOverrides: Partial<SandboxPolicy> = {}, config = {}) {
  const db = openDb(TEST_DB);
  runMigrations(db);
  const registry = new ToolRegistry();
  const policy = SandboxPolicySchema.parse({ allow: ["*"], ...policyOverrides });
  const audit = new AuditWriter(db);
  const approval = new ApprovalQueue(db);
  const router = new ToolRouter(registry, policy, audit, approval, config);
  return { db, registry, router, approval };
}

describe("ToolRouter", () => {
  let db: any;

  afterEach(() => {
    if (db) db.close();
    try { unlinkSync(TEST_DB); } catch {}
    try { unlinkSync(TEST_DB + "-wal"); } catch {}
    try { unlinkSync(TEST_DB + "-shm"); } catch {}
  });

  it("happy path invokes handler", async () => {
    const s = setup();
    db = s.db;
    s.registry.register({
      name: "core.echo",
      description: "echo",
      parameters: z.object({ msg: z.string() }),
      handler: async (args: any) => args.msg,
    });
    const result = await s.router.invoke("core.echo", { msg: "hi" }, {});
    expect(result).toBe("hi");
  });

  it("throws on deny", async () => {
    const s = setup({ deny: ["bad.*"] });
    db = s.db;
    s.registry.register({
      name: "bad.tool",
      description: "bad",
      parameters: z.object({}),
      handler: async () => "x",
    });
    await expect(s.router.invoke("bad.tool", {}, {})).rejects.toThrow("denied");
  });

  it("throws on schema validation failure", async () => {
    const s = setup();
    db = s.db;
    s.registry.register({
      name: "core.strict",
      description: "strict",
      parameters: z.object({ n: z.number() }),
      handler: async () => "x",
    });
    await expect(s.router.invoke("core.strict", { n: "not a number" }, {})).rejects.toThrow("schema validation failed");
  });

  it("timeout rejects", async () => {
    const s = setup({}, { timeoutMs: 50 });
    db = s.db;
    s.registry.register({
      name: "core.slow",
      description: "slow",
      parameters: z.object({}),
      handler: async () => new Promise((r) => setTimeout(r, 500)),
    });
    await expect(s.router.invoke("core.slow", {}, {})).rejects.toThrow("timeout");
  });

  it("truncates oversized results", async () => {
    const s = setup({}, { maxResultSize: 50 });
    db = s.db;
    s.registry.register({
      name: "core.big",
      description: "big",
      parameters: z.object({}),
      handler: async () => "x".repeat(200),
    });
    const result = await s.router.invoke("core.big", {}, {}) as any;
    expect(result._truncated).toBe(true);
    expect(result.original_size).toBeGreaterThan(50);
    expect(result.preview).toBeDefined();
  });
});
