# Capability Authoring

A **capability** is an MCP server that exposes tools to Polymath. It runs as a subprocess and communicates over stdio using the Model Context Protocol.

## Configuration

Add your capability to `~/.polymath/config.toml`:

```toml
[[mcp_servers]]
name = "my-cap"
command = "node"
args = ["./my-cap/dist/server.js"]
# Optional: restrict which tools are exposed
allow_tools = ["my-cap.*"]
```

## TypeScript Example

```typescript
// my-cap/src/server.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "my-cap", version: "1.0.0" });

server.tool("greet", { name: z.string() }, async ({ name }) => ({
  content: [{ type: "text", text: `Hello, ${name}!` }],
}));

const transport = new StdioServerTransport();
await server.connect(transport);
```

Build and point `command`/`args` at the output.

## Python Example

```python
# my_cap/server.py
import asyncio
from mcp.server import Server
from mcp.server.stdio import stdio_server

app = Server("my-cap")

@app.tool()
async def greet(name: str) -> str:
    """Greet someone by name."""
    return f"Hello, {name}!"

async def main():
    async with stdio_server() as (read, write):
        await app.run(read, write, app.create_initialization_options())

asyncio.run(main())
```

Config:
```toml
[[mcp_servers]]
name = "my-cap"
command = "python"
args = ["./my_cap/server.py"]
```

## Health & Reconnection

Polymath monitors each capability's health. If a server crashes, it will attempt up to 3 exponential-backoff restarts. You can also trigger reconnection from the UI or CLI (`/reconnect my-cap`).

## Tool Naming

Tools are namespaced as `{capability_name}.{tool_name}`. The agent sees them as `my-cap.greet`.

## Filtering

Use `allow_tools` and `deny_tools` with glob patterns:
```toml
allow_tools = ["search_*"]
deny_tools = ["dangerous_*"]
```
