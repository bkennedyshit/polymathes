import { z } from "zod";
import type { ToolRegistry } from "../registry.js";

const MSG = "media-memory MCP server not connected. Configure in polymath.json mcp_servers.";

export function register(registry: ToolRegistry): void {
  const check_fn = () => false;

  registry.register({
    name: "media_index",
    description: "Index media files for semantic search",
    parameters: z.object({ path: z.string() }),
    async handler() { return { error: MSG }; },
    check_fn,
    toolset: "media",
  });

  registry.register({
    name: "media_search",
    description: "Search indexed media by text query",
    parameters: z.object({ query: z.string(), limit: z.number().optional() }),
    async handler() { return { error: MSG }; },
    check_fn,
    toolset: "media",
  });

  registry.register({
    name: "media_search_by_image",
    description: "Search indexed media by image similarity",
    parameters: z.object({ image_path: z.string() }),
    async handler() { return { error: MSG }; },
    check_fn,
    toolset: "media",
  });

  registry.register({
    name: "media_describe",
    description: "Describe media file contents",
    parameters: z.object({ path: z.string() }),
    async handler() { return { error: MSG }; },
    check_fn,
    toolset: "media",
  });
}
