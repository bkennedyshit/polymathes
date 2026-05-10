import { describe, it, expect, afterAll } from "vitest";
import { ToolRegistry } from "../src/tools/registry.js";
import { register } from "../src/tools/builtin/browser.js";

const skip = !process.env.BROWSER_TESTS;

describe.skipIf(skip)("browser tools", () => {
  const reg = new ToolRegistry();
  register(reg);

  afterAll(async () => {
    const close = reg.get("browser_close")!;
    await close.handler({}, null);
  });

  it("browser_open on a data: URL", async () => {
    const tool = reg.get("browser_open")!;
    const result = (await tool.handler({ url: "data:text/html,<title>Hello</title><body>World</body>" }, null)) as any;
    expect(result.title).toBe("Hello");
    expect(result.text).toContain("World");
  });

  it("browser_eval returns result", async () => {
    const tool = reg.get("browser_eval")!;
    const result = (await tool.handler({ script: "1 + 2" }, null)) as any;
    expect(result.result).toBe(3);
  });

  it("browser_close cleans up", async () => {
    const tool = reg.get("browser_close")!;
    const result = (await tool.handler({}, null)) as any;
    expect(result.ok).toBe(true);
  });
});
