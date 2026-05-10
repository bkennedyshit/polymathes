import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { toJSONSchema } from "zod";
import type { ToolRegistry } from "../registry.js";

export class McpServer {
  private server: Server;

  constructor(private registry: ToolRegistry) {
    this.server = new Server({ name: "polymath", version: "0.1.0" }, { capabilities: { tools: {} } });

    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: this.registry.list().map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: toJSONSchema(t.parameters) as any,
      })),
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (req) => {
      const { name, arguments: args } = req.params;
      const tool = this.registry.get(name);
      if (!tool) throw new Error(`Unknown tool: ${name}`);
      const result = await tool.handler(args, {});
      return { content: [{ type: "text" as const, text: typeof result === "string" ? result : JSON.stringify(result) }] };
    });
  }

  async startStdio(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
  }
}
