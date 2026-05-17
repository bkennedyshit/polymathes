import { z } from "zod";
import type { ToolRegistry } from "../registry.js";

export function register(registry: ToolRegistry): void {
  registry.register({
    name: "core.think",
    description:
      "INTERNAL scratchpad ONLY. Writes a thought to the log. The user never sees this. " +
      "Do NOT use core.think to answer questions — it will not be shown. " +
      "Use core.final_answer for anything the user should see.",
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
    description:
      "Send the final user-facing answer and END the episode. ALWAYS call this when you have " +
      "what the user asked for. This is the ONLY tool that actually delivers text to the user.",
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
