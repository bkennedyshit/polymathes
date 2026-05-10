import { describe, it, expect } from "vitest";
import { detectFirejail, firejailExecute } from "../src/sandbox/firejail.js";

const enabled = process.env.FIREJAIL_TESTS === "1";

describe.skipIf(!enabled)("firejail sandbox", () => {
  it("detectFirejail returns boolean", () => {
    expect(typeof detectFirejail()).toBe("boolean");
  });

  it("firejailExecute runs echo", async () => {
    const controller = new AbortController();
    const result = await firejailExecute("echo hello", {}, controller.signal);
    expect(result.stdout.trim()).toBe("hello");
    expect(result.exitCode).toBe(0);
  });

  it("throws if signal already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(firejailExecute("echo x", {}, controller.signal)).rejects.toThrow("aborted");
  });
});
