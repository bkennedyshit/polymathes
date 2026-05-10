import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Tool as McpTool } from '@modelcontextprotocol/sdk/types.js';

export interface McpServerConfig {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  allow_tools?: string[];
  deny_tools?: string[];
}

export type HealthStatus = 'connected' | 'crashed' | 'unavailable';

export interface CapabilityHandle {
  name: string;
  client: Client;
  tools: McpTool[];
  health: HealthStatus;
  startedAt: Date;
  pid: number | null;
}

export class McpCapabilityClient {
  private handle: CapabilityHandle | null = null;
  private transport: StdioClientTransport | null = null;

  async start(config: McpServerConfig): Promise<CapabilityHandle> {
    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args ?? [],
      env: config.env,
    });
    this.transport = transport;

    const client = new Client({ name: 'polymath', version: '0.1.0' });
    await client.connect(transport);

    const { tools } = await client.listTools();

    // Try to get pid from transport internals
    const tAny = transport as unknown as Record<string, unknown>;
    const proc = (tAny._process ?? tAny.process ?? tAny._child) as { pid?: number } | undefined;
    const pid = proc?.pid ?? null;

    this.handle = { name: config.name, client, tools: tools as McpTool[], health: 'connected', startedAt: new Date(), pid };
    return this.handle;
  }

  async call(toolName: string, args: unknown, timeoutMs = 30000): Promise<unknown> {
    if (!this.handle || this.handle.health !== 'connected') {
      throw new Error(`MCP capability not connected: ${toolName}`);
    }
    const result = await Promise.race([
      this.handle.client.callTool({ name: toolName, arguments: args as Record<string, unknown> }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`MCP call timeout: ${toolName} (${timeoutMs}ms)`)), timeoutMs)),
    ]);
    return result;
  }

  async shutdown(): Promise<void> {
    if (!this.handle) return;
    try { await this.handle.client.close(); } catch { /* ignore */ }
    this.handle.health = 'unavailable';
    this.handle = null;
    this.transport = null;
  }

  getHandle(): CapabilityHandle | null {
    return this.handle;
  }
}
