import { z } from "zod";
import { ToolRegistry } from "../../src/tools/registry.js";
import { McpServer } from "../../src/tools/mcp/server.js";

const registry = new ToolRegistry();
registry.register({
  name: "test.greet",
  description: "Greets someone",
  parameters: z.object({ name: z.string() }),
  handler: async (args: any) => `hello ${args.name}`,
});

const server = new McpServer(registry);
await server.startStdio();
