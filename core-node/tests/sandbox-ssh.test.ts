import { describe, it, expect } from "vitest";
import { sshExecute, type SshConfig } from "../src/sandbox/ssh.js";

const enabled = process.env.SSH_TESTS === "1";

describe.skipIf(!enabled)("ssh sandbox", () => {
  const config: SshConfig = {
    host: process.env.SSH_TEST_HOST || "localhost",
    port: Number(process.env.SSH_TEST_PORT) || 22,
    user: process.env.SSH_TEST_USER || "test",
    key_path: process.env.SSH_TEST_KEY || "~/.ssh/id_rsa",
  };

  it("sshExecute runs echo", async () => {
    const controller = new AbortController();
    const result = await sshExecute("echo hello", {}, config, controller.signal);
    expect(result.stdout.trim()).toBe("hello");
    expect(result.exitCode).toBe(0);
  });

  it("throws if signal already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(sshExecute("echo x", {}, config, controller.signal)).rejects.toThrow("aborted");
  });
});
