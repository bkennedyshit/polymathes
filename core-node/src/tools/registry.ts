import { z, toJSONSchema } from "zod";

export interface ToolDef {
  name: string;
  description: string;
  parameters: z.ZodType;
  handler: (args: unknown, ctx: unknown) => Promise<unknown>;
  check_fn?: () => boolean;
  toolset?: string;
}

export class ToolRegistry {
  private tools = new Map<string, ToolDef>();

  register(def: ToolDef): void {
    if (this.tools.has(def.name)) {
      console.warn(`[tools] collision: "${def.name}" already registered, skipping`);
      return;
    }
    this.tools.set(def.name, def);
  }

  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  get(name: string): ToolDef | undefined {
    return this.tools.get(name);
  }

  list(filter?: { toolset?: string }): ToolDef[] {
    let defs = [...this.tools.values()].filter((d) => !d.check_fn || d.check_fn());
    if (filter?.toolset) defs = defs.filter((d) => d.toolset === filter.toolset);
    return defs;
  }

  schemas(): Array<{ type: "function"; function: { name: string; description: string; parameters: unknown } }> {
    return this.list().map((d) => ({
      type: "function" as const,
      function: {
        name: d.name,
        description: d.description,
        parameters: toJSONSchema(d.parameters),
      },
    }));
  }
}
