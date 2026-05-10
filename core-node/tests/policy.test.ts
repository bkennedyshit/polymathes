import { describe, it, expect } from "vitest";
import { evaluate, resetRateLimiter, SandboxPolicySchema, type SandboxPolicy } from "../src/sandbox/policy.js";

function makePolicy(overrides: Partial<SandboxPolicy> = {}): SandboxPolicy {
  return SandboxPolicySchema.parse(overrides);
}

describe("sandbox policy", () => {
  it("allows tools matching allow list", () => {
    const policy = makePolicy({ allow: ["core.*"] });
    expect(evaluate("core.read", undefined, policy).outcome).toBe("allow");
  });

  it("denies tools not in allow list", () => {
    const policy = makePolicy({ allow: ["core.*"] });
    expect(evaluate("fs.write", undefined, policy).outcome).toBe("deny");
  });

  it("deny takes precedence over allow", () => {
    const policy = makePolicy({ allow: ["*"], deny: ["dangerous.*"] });
    expect(evaluate("dangerous.exec", undefined, policy).outcome).toBe("deny");
  });

  it("requireApproval returns approval_required", () => {
    const policy = makePolicy({ allow: ["*"], requireApproval: ["shell.*"] });
    expect(evaluate("shell.exec", undefined, policy).outcome).toBe("approval_required");
  });

  it("rate limiting denies after exhaustion", () => {
    const policy = makePolicy({ allow: ["*"], maxCallsPerMinute: { "api.call": 2 } });
    expect(evaluate("api.call", undefined, policy).outcome).toBe("allow");
    expect(evaluate("api.call", undefined, policy).outcome).toBe("allow");
    expect(evaluate("api.call", undefined, policy).outcome).toBe("deny");
    resetRateLimiter(policy);
  });

  it("toolOverrides take highest precedence", () => {
    const policy = makePolicy({ allow: ["*"], deny: ["tool.x"], toolOverrides: { "tool.x": "allow" } });
    expect(evaluate("tool.x", undefined, policy).outcome).toBe("allow");
  });

  it("fsDeny blocks matching paths", () => {
    const policy = makePolicy({ allow: ["*"], fsDeny: ["/etc/**"] });
    expect(evaluate("fs.read", { path: "/etc/passwd" }, policy).outcome).toBe("deny");
  });

  it("fsAllow restricts to allowed paths", () => {
    const policy = makePolicy({ allow: ["*"], fsAllow: ["/home/**"] });
    expect(evaluate("fs.read", { path: "/tmp/x" }, policy).outcome).toBe("deny");
    expect(evaluate("fs.read", { path: "/home/user/file" }, policy).outcome).toBe("allow");
  });
});
