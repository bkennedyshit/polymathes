import { z } from "zod";

export const SandboxPolicySchema = z.object({
  // Default allows mirror the agent's expected surface: core lifecycle,
  // memory + media catalog ops, gpu lease management, MCP tool fan-out,
  // skills, comms (channel send to known transports), web search/fetch,
  // and read-only filesystem helpers. Anything genuinely dangerous —
  // terminal shell exec, writing files, spawning processes, browser
  // automation — sits in `requireApproval` instead so the orchestrator
  // can prompt the user.
  allow: z.array(z.string()).default([
    // Trust registered tools by default. Dangerous tool families are
    // matched by requireApproval before this allow-list is checked.
    "*",
    "core.*",
    "memory.*",
    "media.*",
    "media-memory.*",       // C++ MCP server fan-out
    "gpu.*",
    "skill.*",
    "skills.*",
    "skill_list",
    "skill_search",
    "skill_run",
    "skill_install",
    "skill_reload",
    "comms.*",
    "channel.*",
    "session.*",
    "sessions.*",
    "history.*",
    "cron.*",
    "fs_read",
    "fs_stat",
    "fs_glob",
    "fs_ls",
    "files.read",
    "files.stat",
    "files.glob",
    "files.fs_read",
    "files.fs_stat",
    "files.fs_glob",
    "files.fs_list",
    "web.search",
    "web.fetch",
    "web.fetch_text",
    "web_search",
    "web_fetch",
    "vision.*",
    "voice.*",
    "media-memory.search",
    "media-memory.index",
    "media-memory.recall",
  ]),
  deny: z.array(z.string()).default([]),
  // Tools that genuinely change machine state — gate behind approval queue.
  requireApproval: z.array(z.string()).default([
    "terminal.run",
    "terminal.exec",
    "shell_run",
    "shell_run_streaming",
    "shell_run_script",
    "shell_*",
    "files.write",
    "files.fs_write",
    "files.fs_append",
    "files.fs_delete",
    "fs_write",
    "fs_edit",
    "fs_move",
    "fs_mkdir",
    "fs_delete",
    "processes.spawn",
    "processes.kill",
    "process_spawn",
    "process_kill",
    "proc_spawn",
    "proc_kill",
    "browser.*",
    "browser_*",
    "browser_open",
    "browser_click",
    "browser_type",
    "browser_screenshot",
    "browser_eval",
    "browser_html",
    "browser_close",
    "code_exec.*",
    "execute_code",
    "web_screenshot",
    "input.*",                // virtual-input MCP — keystrokes/clicks
  ]),
  maxCallsPerMinute: z.record(z.string(), z.number()).default({}),
  fsAllow: z.array(z.string()).default([]),
  fsDeny: z.array(z.string()).default([]),
  toolOverrides: z.record(z.string(), z.enum(["allow", "deny", "approval_required"])).default({}),
});

export type SandboxPolicy = z.infer<typeof SandboxPolicySchema>;
export type PolicyOutcome = "allow" | "deny" | "approval_required";
export interface PolicyDecision {
  outcome: PolicyOutcome;
  reason?: string;
}

// Rate limiter state
const buckets = new WeakMap<SandboxPolicy, Map<string, { tokens: number; lastRefill: number }>>();

function getBuckets(policy: SandboxPolicy) {
  let b = buckets.get(policy);
  if (!b) { b = new Map(); buckets.set(policy, b); }
  return b;
}

function checkRateLimit(tool: string, policy: SandboxPolicy): boolean {
  const limit = policy.maxCallsPerMinute[tool];
  if (!limit) return false;
  const now = Date.now();
  const b = getBuckets(policy);
  let bucket = b.get(tool);
  if (!bucket) { bucket = { tokens: limit, lastRefill: now }; b.set(tool, bucket); }
  const elapsed = (now - bucket.lastRefill) / 60000;
  bucket.tokens = Math.min(limit, bucket.tokens + elapsed * limit);
  bucket.lastRefill = now;
  if (bucket.tokens < 1) return true;
  bucket.tokens -= 1;
  return false;
}

function globMatch(pattern: string, value: string): boolean {
  const isPath = pattern.includes("/");
  let re = "";
  let i = 0;
  while (i < pattern.length) {
    if (pattern[i] === "*" && pattern[i + 1] === "*") {
      re += ".*";
      i += 2;
    } else if (pattern[i] === "*") {
      re += isPath ? "[^/]*" : ".*";
      i++;
    } else if (".+^${}()|[]\\".includes(pattern[i]!)) {
      re += "\\" + pattern[i];
      i++;
    } else {
      re += pattern[i];
      i++;
    }
  }
  return new RegExp("^" + re + "$").test(value);
}

function matchesAny(value: string, patterns: string[]): boolean {
  return patterns.some((p) => globMatch(p, value));
}

export function resetRateLimiter(policy: SandboxPolicy): void {
  buckets.delete(policy);
}

export function evaluate(
  toolName: string,
  args: Record<string, unknown> | undefined,
  policy: SandboxPolicy
): PolicyDecision {
  // Per-tool override takes highest precedence
  const override = policy.toolOverrides[toolName];
  if (override) return { outcome: override, reason: "tool override" };

  // Deny > allow precedence
  if (matchesAny(toolName, policy.deny)) return { outcome: "deny", reason: "denied by policy" };

  // Approval-gated tools are intentionally not in the normal allow-list.
  // Check this before the allow-list so shell/browser/write actions can
  // reach the approval queue instead of being mislabeled as "not allowed".
  if (matchesAny(toolName, policy.requireApproval)) return { outcome: "approval_required" };

  if (!matchesAny(toolName, policy.allow)) return { outcome: "deny", reason: "not in allow list" };

  // FS path checking
  const pathArg = args?.["path"] as string | undefined;
  if (pathArg && policy.fsDeny.length > 0 && matchesAny(pathArg, policy.fsDeny)) {
    return { outcome: "deny", reason: "fs path denied" };
  }
  if (pathArg && policy.fsAllow.length > 0 && !matchesAny(pathArg, policy.fsAllow)) {
    return { outcome: "deny", reason: "fs path not in allow list" };
  }

  // Rate limiting
  if (checkRateLimit(toolName, policy)) return { outcome: "deny", reason: "rate limit exceeded" };

  return { outcome: "allow" };
}
