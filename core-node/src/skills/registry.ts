import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { z } from "zod";
import type { ToolRegistry } from "../tools/registry.js";
import type { EpisodeContext } from "../orchestrator/loop.js";
import { invokeSkill } from "./invoke.js";

function expandHome(p: string): string {
  return p.startsWith("~") ? p.replace(/^~/, homedir()) : p;
}

export interface SkillDef {
  name: string;
  description: string;
  version?: string;
  author?: string;
  tags?: string[];
  toolsets?: string[];
  /** Optional specialist model (e.g. "qwen2.5vl:7b") that this skill needs.
   * When set, the skill invoker swaps Ollama to this model for the duration
   * of the skill and swaps back to the parent's model afterward. */
  model?: string;
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

export interface SkillRegistryOptions {
  gpuBroker?: import("../gpu/broker.js").GpuBroker;
  ollamaUrl?: string;
  getParentModel?: () => string;
  mediaEpisodic?: import("../memory/media_episodic.js").MediaEpisodic;
  mediaWorkflow?: import("../memory/media_workflow.js").MediaWorkflow;
}

export class SkillRegistry {
  private skills = new Map<string, SkillDef>();
  private contextProvider: SkillContextProvider | null = null;
  private deps: SkillRegistryOptions = {};

  /**
   * Install the context provider. Until this is called, skill invocations
   * will return an informative error instead of crashing.
   */
  setContextProvider(provider: SkillContextProvider): void {
    this.contextProvider = provider;
  }

  /** Wire the GPU broker + parent-model accessor so model-swap skills work. */
  setDeps(deps: SkillRegistryOptions): void {
    this.deps = { ...this.deps, ...deps };
  }

  discover(workspacePath: string, toolRegistry?: ToolRegistry): void {
    const skillsDir = join(expandHome(workspacePath), "skills");
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
          model: frontmatter.model,
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
              const result = await invokeSkill(def, { input }, ctx, {
                gpuBroker: this.deps.gpuBroker,
                ollamaUrl: this.deps.ollamaUrl,
                parentModel: this.deps.getParentModel?.(),
                mediaEpisodic: this.deps.mediaEpisodic,
                mediaWorkflow: this.deps.mediaWorkflow,
              });
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
