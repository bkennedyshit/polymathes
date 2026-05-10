import { z } from "zod";
import type { ToolRegistry } from "../registry.js";

export function register(registry: ToolRegistry): void {
  registry.register({
    name: "core.think",
    description: "Log a thought (chain-of-thought scratchpad)",
    parameters: z.object({ thought: z.string() }),
    async handler(args) {
      const { thought } = args as { thought: string };
      console.log(`[think] ${thought}`);
      return { ok: true };
    },
    toolset: "core",
  });

  registry.register({
    name: "core.final_answer",
    description: "Return the final answer to the user",
    parameters: z.object({ answer: z.string() }),
    async handler(args) {
      const { answer } = args as { answer: string };
      return { answer };
    },
    toolset: "core",
  });

  registry.register({
    name: "core.list_tools",
    description: "List all registered tool names",
    parameters: z.object({}),
    async handler(_args, ctx) {
      const reg = ctx as ToolRegistry;
      return { tools: reg.list().map((d) => d.name) };
    },
    toolset: "core",
  });
}
