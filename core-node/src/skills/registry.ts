import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { ToolRegistry } from "../tools/registry.js";
import type { EpisodeContext } from "../orchestrator/loop.js";
import { invokeSkill } from "./invoke.js";

export interface SkillDef {
  name: string;
  description: string;
  version?: string;
  author?: string;
  tags?: string[];
  toolsets?: string[];
  prompt_file: string;
}

/**
 * SkillRegistry discovers SKILL.md files in the workspace and registers each
 * as a tool named `skill.<name>`. When the LLM calls that tool, the handler
 * invokes the skill in a subagent using the prompt body from SKILL.md.
 *
 * The handler needs a live EpisodeContext to spawn into. Because skills are
 * discovered at boot (before the runtime context exists for any given episode),
 * we use a context provider function that the Gateway installs later and that
 * returns whatever context is active when the tool fires.
 */
export type SkillContextProvider = () => Omit<EpisodeContext, "sessionId"> & { sessionId: string };

export class SkillRegistry {
  private skills = new Map<string, SkillDef>();
  private contextProvider: SkillContextProvider | null = null;

  /**
   * Install the context provider. Until this is called, skill invocations
   * will return an informative error instead of crashing.
   */
  setContextProvider(provider: SkillContextProvider): void {
    this.contextProvider = provider;
  }

  discover(workspacePath: string, toolRegistry?: ToolRegistry): void {
    const skillsDir = join(workspacePath, "skills");
    const files = findSkillFiles(skillsDir);
    for (const file of files) {
      try {
        const content = readFileSync(file, "utf-8");
        const { frontmatter } = parseFrontmatter(content);
        if (!frontmatter.name || !frontmatter.description) continue;
        const def: SkillDef = {
          name: frontmatter.name,
          description: frontmatter.description,
          version: frontmatter.version,
          author: frontmatter.author,
          tags: frontmatter.tags,
          toolsets: frontmatter.toolsets,
          prompt_file: file,
        };
        this.skills.set(def.name, def);

        if (toolRegistry) {
          toolRegistry.register({
            name: `skill.${def.name}`,
            description: def.description,
            parameters: z.object({ input: z.string() }),
            handler: async (args: unknown) => {
              if (!this.contextProvider) {
                return { ok: false, error: "skill runtime not initialized" };
              }
              const { input } = args as { input: string };
              const ctx = this.contextProvider();
              const result = await invokeSkill(def, { input }, ctx);
              return { ok: true, result };
            },
            toolset: "skills",
          });
        }
      } catch { /* skip unparseable */ }
    }
  }

  get(name: string): SkillDef | undefined {
    return this.skills.get(name);
  }

  list(): SkillDef[] {
    return [...this.skills.values()];
  }
}

function findSkillFiles(dir: string): string[] {
  const results: string[] = [];
  try {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const stat = statSync(full, { throwIfNoEntry: false });
      if (!stat) continue;
      if (stat.isDirectory()) results.push(...findSkillFiles(full));
      else if (entry === "SKILL.md") results.push(full);
    }
  } catch { /* dir doesn't exist */ }
  return results;
}

export function parseFrontmatter(content: string): { frontmatter: Record<string, any>; body: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { frontmatter: {}, body: content };
  const raw = match[1];
  const body = match[2];
  const frontmatter: Record<string, any> = {};
  for (const line of raw.split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    let val: any = line.slice(idx + 1).trim();
    if (val.startsWith("[") && val.endsWith("]")) {
      val = val.slice(1, -1).split(",").map((s: string) => s.trim().replace(/^['"]|['"]$/g, ""));
    }
    frontmatter[key] = val;
  }
  return { frontmatter, body };
}
