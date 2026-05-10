import { describe, it, expect } from "vitest";
import { detectDocker, dockerExecute } from "../src/sandbox/docker.js";
import type { SandboxPolicy } from "../src/sandbox/policy.js";

const enabled = process.env.DOCKER_TESTS === "1";

describe.skipIf(!enabled)("docker sandbox", () => {
  const policy: SandboxPolicy = {
    allow: ["*"],
    deny: [],
    requireApproval: [],
    maxCallsPerMinute: {},
    fsAllow: [],
    fsDeny: [],
    toolOverrides: {},
  };

  it("detectDocker returns boolean", async () => {
    const result = await detectDocker();
    expect(typeof result).toBe("boolean");
  });

  it("dockerExecute runs echo", async () => {
    const controller = new AbortController();
    const result = await dockerExecute(
      undefined as never,
      "echo hello",
      { cwd: process.cwd() },
      policy,
      controller.signal,
    );
    expect(result.stdout.trim()).toBe("hello");
    expect(result.exitCode).toBe(0);
  });

  it("throws if signal already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      dockerExecute(undefined as never, "echo x", {}, policy, controller.signal),
    ).rejects.toThrow("aborted");
  });
});
