import type { ToolRegistry } from "./registry.js";
import type { SandboxPolicy } from "../sandbox/policy.js";
import { evaluate } from "../sandbox/policy.js";
import type { AuditWriter } from "../audit/writer.js";
import type { ApprovalQueue } from "../security/approval.js";

export interface ToolRouterConfig {
  timeoutMs?: number;
  maxResultSize?: number;
  sessionId?: string;
}

function deniedResult(toolName: string, reason: string): Record<string, unknown> {
  return {
    ok: false,
    status: "denied",
    tool: toolName,
    reason,
    message: `Tool call denied: ${reason}. The command did not run.`,
  };
}

export class ToolRouter {
  private timeoutMs: number;
  private maxResultSize: number;
  private sessionId: string;

  constructor(
    private registry: ToolRegistry,
    private policy: SandboxPolicy,
    private audit: AuditWriter,
    private approvalQueue: ApprovalQueue,
    config: ToolRouterConfig = {},
  ) {
    this.timeoutMs = config.timeoutMs ?? 30_000;
    this.maxResultSize = config.maxResultSize ?? 100_000;
    this.sessionId = config.sessionId ?? "default";
  }

  async invoke(name: string, args: unknown, ctx: unknown): Promise<unknown> {
    const start = Date.now();
    const def = this.registry.get(name);
    if (!def) throw new Error(`tool not found: ${name}`);

    // Policy check
    const decision = evaluate(name, args as Record<string, unknown> | undefined, this.policy);
    if (decision.outcome === "deny") {
      this.audit.record({ tool_name: name, args: args as any, outcome: "deny", session_id: this.sessionId });
      return deniedResult(name, decision.reason);
    }
    if (decision.outcome === "approval_required") {
      const approved = await this.approvalQueue.enqueue(name, args as Record<string, unknown>, this.sessionId);
      if (!approved) {
        this.audit.record({ tool_name: name, args: args as any, outcome: "deny", session_id: this.sessionId });
        return deniedResult(name, "approval denied");
      }
    }

    // Validate args
    const parsed = def.parameters.safeParse(args);
    if (!parsed.success) {
      this.audit.record({ tool_name: name, args: args as any, outcome: "error", session_id: this.sessionId, error: "schema validation failed" });
      throw new Error(`schema validation failed: ${(parsed as any).error?.message ?? "invalid args"}`);
    }

    // Execute with timeout
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let result: unknown;
    try {
      result = await Promise.race([
        def.handler(parsed.data, ctx),
        new Promise<never>((_, reject) => {
          controller.signal.addEventListener("abort", () => reject(new Error("timeout")), { once: true });
        }),
      ]);
    } catch (e: any) {
      clearTimeout(timer);
      const outcome = e.message === "timeout" ? "timeout" : "error";
      this.audit.record({ tool_name: name, args: args as any, outcome, session_id: this.sessionId, duration_ms: Date.now() - start, error: e.message });
      throw e;
    }
    clearTimeout(timer);

    // Truncation
    const serialized = JSON.stringify(result);
    if (serialized && serialized.length > this.maxResultSize) {
      result = { _truncated: true, original_size: serialized.length, preview: serialized.slice(0, 200) };
    }

    this.audit.record({ tool_name: name, args: args as any, outcome: "allow", session_id: this.sessionId, duration_ms: Date.now() - start });
    return result;
  }
}
