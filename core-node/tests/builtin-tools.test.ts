import { describe, it, expect, vi, afterAll } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { rm } from "node:fs/promises";
import { ToolRegistry } from "../src/tools/registry.js";
import { register as registerTerminal } from "../src/tools/builtin/terminal.js";
import { register as registerFiles } from "../src/tools/builtin/files.js";
import { register as registerCore } from "../src/tools/builtin/core.js";

const testDir = join(tmpdir(), `polymath-test-${randomBytes(4).toString("hex")}`);

afterAll(async () => {
  await rm(testDir, { recursive: true, force: true });
});

describe("shell_run", () => {
  it("echoes text", async () => {
    const reg = new ToolRegistry();
    registerTerminal(reg);
    const tool = reg.get("shell_run")!;
    const result = (await tool.handler({ command: 'echo hello' }, null)) as any;
    expect(result.stdout.trim()).toBe("hello");
    expect(result.exitCode).toBe(0);
  });
});

describe("fs_write + fs_read round-trip", () => {
  it("writes and reads back content", async () => {
    const reg = new ToolRegistry();
    registerFiles(reg);
    const filePath = join(testDir, "test.txt");
    const write = reg.get("fs_write")!;
    const read = reg.get("fs_read")!;

    await write.handler({ path: filePath, content: "line1\nline2\nline3" }, null);
    const result = (await read.handler({ path: filePath }, null)) as any;
    expect(result.content).toBe("line1\nline2\nline3");
  });

  it("reads with offset and limit", async () => {
    const reg = new ToolRegistry();
    registerFiles(reg);
    const filePath = join(testDir, "lines.txt");
    const write = reg.get("fs_write")!;
    const read = reg.get("fs_read")!;

    await write.handler({ path: filePath, content: "a\nb\nc\nd\ne" }, null);
    const result = (await read.handler({ path: filePath, offset: 1, limit: 2 }, null)) as any;
    expect(result.content).toBe("b\nc");
  });
});

describe("fs_edit", () => {
  it("replaces string in file", async () => {
    const reg = new ToolRegistry();
    registerFiles(reg);
    const filePath = join(testDir, "edit.txt");
    const write = reg.get("fs_write")!;
    const edit = reg.get("fs_edit")!;
    const read = reg.get("fs_read")!;

    await write.handler({ path: filePath, content: "hello world" }, null);
    await edit.handler({ path: filePath, old_str: "world", new_str: "polymath" }, null);
    const result = (await read.handler({ path: filePath }, null)) as any;
    expect(result.content).toBe("hello polymath");
  });

  it("returns error when old_str not found", async () => {
    const reg = new ToolRegistry();
    registerFiles(reg);
    const filePath = join(testDir, "edit2.txt");
    const write = reg.get("fs_write")!;
    const edit = reg.get("fs_edit")!;

    await write.handler({ path: filePath, content: "hello" }, null);
    const result = (await edit.handler({ path: filePath, old_str: "xyz", new_str: "abc" }, null)) as any;
    expect(result.error).toContain("not found");
  });
});

describe("core.think", () => {
  it("returns ok", async () => {
    const reg = new ToolRegistry();
    registerCore(reg);
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const tool = reg.get("core.think")!;
    const result = (await tool.handler({ thought: "testing" }, null)) as any;
    expect(result.ok).toBe(true);
    spy.mockRestore();
  });
});
