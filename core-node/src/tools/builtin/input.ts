import { z } from "zod";
import type { ToolRegistry } from "../registry.js";

const MSG = "virtual-input not connected. Enable in policy and configure MCP server.";

export function register(registry: ToolRegistry): void {
  const check_fn = () => false;

  registry.register({
    name: "input_move",
    description: "Move mouse cursor to coordinates",
    parameters: z.object({ x: z.number(), y: z.number() }),
    async handler() { return { error: MSG }; },
    check_fn,
    toolset: "input",
  });

  registry.register({
    name: "input_click",
    description: "Click at coordinates",
    parameters: z.object({ x: z.number(), y: z.number(), button: z.string().optional() }),
    async handler() { return { error: MSG }; },
    check_fn,
    toolset: "input",
  });

  registry.register({
    name: "input_type",
    description: "Type text via virtual keyboard",
    parameters: z.object({ text: z.string() }),
    async handler() { return { error: MSG }; },
    check_fn,
    toolset: "input",
  });

  registry.register({
    name: "input_hotkey",
    description: "Press a keyboard shortcut",
    parameters: z.object({ keys: z.string() }),
    async handler() { return { error: MSG }; },
    check_fn,
    toolset: "input",
  });
}
