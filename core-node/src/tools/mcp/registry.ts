import type { Tool as McpTool } from '@modelcontextprotocol/sdk/types.js';
import { McpCapabilityClient, type McpServerConfig, type CapabilityHandle } from './client.js';

export interface ResolvedTool {
  namespaced: string;
  capability: string;
  tool: McpTool;
}

function globMatch(pattern: string, name: string): boolean {
  const re = new RegExp('^' + pattern.replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
  return re.test(name);
}

function isToolAllowed(toolName: string, config: McpServerConfig): boolean {
  if (config.deny_tools?.some(p => globMatch(p, toolName))) return false;
  if (config.allow_tools && config.allow_tools.length > 0) {
    return config.allow_tools.some(p => globMatch(p, toolName));
  }
  return true;
}

export class McpRegistry {
  private clients = new Map<string, McpCapabilityClient>();
  private handles = new Map<string, CapabilityHandle>();
  private configs = new Map<string, McpServerConfig>();
  private restartCounts = new Map<string, number>();

  async startAll(configs: McpServerConfig[]): Promise<void> {
    await Promise.allSettled(configs.map(cfg => this.startOne(cfg)));
  }

  /** Public entry point used by /api/mcp add/update flows. */
  async start(cfg: McpServerConfig): Promise<void> {
    await this.startOne(cfg);
  }

  /** Stop a single server and remove it from the registry. */
  async stop(name: string): Promise<boolean> {
    const client = this.clients.get(name);
    if (!client) return false;
    try { await client.shutdown(); } catch { /* ignore */ }
    this.clients.delete(name);
    this.handles.delete(name);
    this.configs.delete(name);
    this.restartCounts.delete(name);
    return true;
  }

  private async startOne(cfg: McpServerConfig): Promise<void> {
    this.configs.set(cfg.name, cfg);
    const client = new McpCapabilityClient();
    const handle = await client.start(cfg);
    this.clients.set(cfg.name, client);
    this.handles.set(cfg.name, handle);
    this.restartCounts.set(cfg.name, 0);
  }

  resolveTool(namespacedName: string): ResolvedTool | null {
    const dot = namespacedName.indexOf('.');
    if (dot === -1) return null;
    const capName = namespacedName.slice(0, dot);
    const toolName = namespacedName.slice(dot + 1);
    const handle = this.handles.get(capName);
    if (!handle || handle.health !== 'connected') return null;
    const cfg = this.configs.get(capName)!;
    if (!isToolAllowed(toolName, cfg)) return null;
    const tool = handle.tools.find(t => t.name === toolName);
    if (!tool) return null;
    return { namespaced: namespacedName, capability: capName, tool };
  }

  listTools(): ResolvedTool[] {
    const out: ResolvedTool[] = [];
    for (const [capName, handle] of this.handles) {
      if (handle.health !== 'connected') continue;
      const cfg = this.configs.get(capName)!;
      for (const tool of handle.tools) {
        if (!isToolAllowed(tool.name, cfg)) continue;
        out.push({ namespaced: `${capName}.${tool.name}`, capability: capName, tool });
      }
    }
    return out;
  }

  async restart(name: string): Promise<boolean> {
    const count = this.restartCounts.get(name) ?? 0;
    if (count >= 3) return false;
    const cfg = this.configs.get(name);
    if (!cfg) return false;
    const existing = this.clients.get(name);
    if (existing) await existing.shutdown();
    const delay = Math.pow(2, count) * 500;
    await new Promise(r => setTimeout(r, delay));
    this.restartCounts.set(name, count + 1);
    try {
      await this.startOne(cfg);
      return true;
    } catch {
      const handle = this.handles.get(name);
      if (handle) handle.health = 'unavailable';
      return false;
    }
  }

  listServers(): Array<{ name: string; health: string; tools: number }> {
    const out: Array<{ name: string; health: string; tools: number }> = [];
    for (const [name, handle] of this.handles) {
      out.push({ name, health: handle.health, tools: handle.tools.length });
    }
    return out;
  }

  async shutdownAll(): Promise<void> {
    for (const client of this.clients.values()) {
      await client.shutdown();
    }
    this.clients.clear();
    this.handles.clear();
  }
}
