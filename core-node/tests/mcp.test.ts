import { describe, it, expect, afterEach } from 'vitest';
import { resolve } from 'node:path';
import { McpCapabilityClient } from '../src/tools/mcp/client.js';
import { McpRegistry } from '../src/tools/mcp/registry.js';

const stubServer = resolve(import.meta.dirname, 'fixtures/stub_mcp_server.ts');
const tsxBin = resolve(import.meta.dirname, '../node_modules/.bin/tsx');

function stubConfig(name = 'stub') {
  return { name, command: tsxBin, args: [stubServer] };
}

describe('McpCapabilityClient', () => {
  let client: McpCapabilityClient;

  afterEach(async () => {
    if (client) await client.shutdown();
  });

  it('starts stub server and lists tools', async () => {
    client = new McpCapabilityClient();
    const handle = await client.start(stubConfig());
    expect(handle.health).toBe('connected');
    expect(handle.tools.length).toBeGreaterThan(0);
    expect(handle.tools[0].name).toBe('echo');
  });

  it('calls echo tool', async () => {
    client = new McpCapabilityClient();
    await client.start(stubConfig());
    const result = await client.call('echo', { message: 'hello' }) as any;
    expect(result.content[0].text).toBe('hello');
  });

  it('shuts down cleanly', async () => {
    client = new McpCapabilityClient();
    await client.start(stubConfig());
    await client.shutdown();
    expect(client.getHandle()).toBeNull();
  });
});

describe('McpRegistry', () => {
  let registry: McpRegistry;

  afterEach(async () => {
    if (registry) await registry.shutdownAll();
  });

  it('namespaces tools as serverName.toolName', async () => {
    registry = new McpRegistry();
    await registry.startAll([stubConfig('myserver')]);
    const tools = registry.listTools();
    expect(tools.length).toBeGreaterThan(0);
    expect(tools[0].namespaced).toBe('myserver.echo');
  });

  it('resolves namespaced tool', async () => {
    registry = new McpRegistry();
    await registry.startAll([stubConfig('s1')]);
    const resolved = registry.resolveTool('s1.echo');
    expect(resolved).not.toBeNull();
    expect(resolved!.capability).toBe('s1');
    expect(resolved!.tool.name).toBe('echo');
  });

  it('returns null for unknown tool', async () => {
    registry = new McpRegistry();
    await registry.startAll([stubConfig()]);
    expect(registry.resolveTool('stub.nonexistent')).toBeNull();
    expect(registry.resolveTool('unknown.echo')).toBeNull();
  });
});
