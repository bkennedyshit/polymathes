import { describe, it, expect, vi } from "vitest";
import { join } from "node:path";
import { ToolRegistry } from "../src/tools/registry.js";
import { discoverTools } from "../src/tools/discover.js";

describe("discoverTools", () => {
  it("loads valid tool modules and skips invalid ones", async () => {
    const reg = new ToolRegistry();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await discoverTools(reg, join(import.meta.dirname, "fixtures/tools"));
    expect(reg.get("fixture.valid")).toBeDefined();
    expect(spy).toHaveBeenCalled(); // invalid-tool.ts throws
    spy.mockRestore();
  });

  it("handles non-existent directory gracefully", async () => {
    const reg = new ToolRegistry();
    await discoverTools(reg, "/nonexistent/path");
    expect(reg.list()).toHaveLength(0);
  });
});
