import { readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ToolRegistry } from "./registry.js";

export async function discoverTools(registry: ToolRegistry, dir: string): Promise<void> {
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".ts") || f.endsWith(".js"));
  } catch {
    return;
  }
  for (const file of files) {
    try {
      const mod = await import(pathToFileURL(join(dir, file)).href);
      if (typeof mod.register === "function") {
        mod.register(registry);
      }
    } catch (e) {
      console.error(`[tools] failed to load ${file}:`, e);
    }
  }
}
