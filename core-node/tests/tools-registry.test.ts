import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { ToolRegistry, type ToolDef } from "../src/tools/registry.js";

function makeDef(name: string, opts: Partial<ToolDef> = {}): ToolDef {
  return {
    name,
    description: `desc for ${name}`,
    parameters: z.object({ x: z.string() }),
    handler: async () => "ok",
    ...opts,
  };
}

describe("ToolRegistry", () => {
  it("register and get", () => {
    const reg = new ToolRegistry();
    reg.register(makeDef("a"));
    expect(reg.get("a")?.name).toBe("a");
    expect(reg.get("b")).toBeUndefined();
  });

  it("warns and skips on collision", () => {
    const reg = new ToolRegistry();
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    reg.register(makeDef("a"));
    reg.register(makeDef("a"));
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("list filters by check_fn", () => {
    const reg = new ToolRegistry();
    reg.register(makeDef("available", { check_fn: () => true }));
    reg.register(makeDef("unavailable", { check_fn: () => false }));
    reg.register(makeDef("nocheck"));
    const names = reg.list().map((d) => d.name);
    expect(names).toContain("available");
    expect(names).toContain("nocheck");
    expect(names).not.toContain("unavailable");
  });

  it("list filters by toolset", () => {
    const reg = new ToolRegistry();
    reg.register(makeDef("a", { toolset: "core" }));
    reg.register(makeDef("b", { toolset: "media" }));
    expect(reg.list({ toolset: "core" }).map((d) => d.name)).toEqual(["a"]);
  });

  it("schemas returns OpenAI-compatible format", () => {
    const reg = new ToolRegistry();
    reg.register(makeDef("test"));
    const schemas = reg.schemas();
    expect(schemas).toHaveLength(1);
    expect(schemas[0].type).toBe("function");
    expect(schemas[0].function.name).toBe("test");
    expect(schemas[0].function.parameters).toHaveProperty("type", "object");
  });
});
