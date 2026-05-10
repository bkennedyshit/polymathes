import { describe, it, expect, afterEach } from "vitest";
import { resolve } from "node:path";
import { McpCapabilityClient } from "../src/tools/mcp/client.js";

const serverScript = resolve(import.meta.dirname, "fixtures/polymath_mcp_server.ts");
const tsxBin = resolve(import.meta.dirname, "../node_modules/.bin/tsx");

describe("McpServer", () => {
  let client: McpCapabilityClient;

  afterEach(async () => {
    if (client) await client.shutdown();
  });

  it("lists registered tools via MCP protocol", async () => {
    client = new McpCapabilityClient();
    const handle = await client.start({ name: "polymath", command: tsxBin, args: [serverScript] });
    expect(handle.health).toBe("connected");
    expect(handle.tools.length).toBeGreaterThan(0);
    expect(handle.tools[0].name).toBe("test.greet");
  });

  it("calls a registered tool via MCP protocol", async () => {
    client = new McpCapabilityClient();
    await client.start({ name: "polymath", command: tsxBin, args: [serverScript] });
    const result = await client.call("test.greet", { name: "world" }) as any;
    expect(result.content[0].text).toBe("hello world");
  });
});
