import { describe, it, expect } from "vitest";
import { detectWsl, wslExecute } from "../src/sandbox/wsl.js";

const enabled = process.env.WSL_TESTS === "1";

describe.skipIf(!enabled)("wsl sandbox", () => {
  it("detectWsl returns boolean", () => {
    expect(typeof detectWsl()).toBe("boolean");
  });

  it("wslExecute runs echo", async () => {
    const controller = new AbortController();
    const result = await wslExecute("echo hello", {}, controller.signal);
    expect(result.stdout.trim()).toBe("hello");
    expect(result.exitCode).toBe(0);
  });

  it("throws if signal already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(wslExecute("echo x", {}, controller.signal)).rejects.toThrow("aborted");
  });
});
