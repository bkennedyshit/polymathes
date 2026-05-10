import { z } from "zod";
import type { ToolRegistry } from "../registry.js";
import { SkillRegistry } from "../../skills/registry.js";
import { invokeSkill } from "../../skills/invoke.js";
import { createSkill } from "../../skills/mutate.js";
import type { EpisodeContext } from "../../orchestrator/loop.js";

let skillRegistry: SkillRegistry | undefined;

export function getSkillRegistry(): SkillRegistry {
  if (!skillRegistry) skillRegistry = new SkillRegistry();
  return skillRegistry;
}

export function register(registry: ToolRegistry): void {
  const sr = getSkillRegistry();

  registry.register({
    name: "skill_list",
    description: "List all discovered skills",
    parameters: z.object({}),
    async handler() {
      return { skills: sr.list().map((s) => ({ name: s.name, description: s.description, tags: s.tags })) };
    },
    toolset: "skills",
  });

  registry.register({
    name: "skill_invoke",
    description: "Invoke a skill by name with input",
    parameters: z.object({ name: z.string(), input: z.string() }),
    async handler(args, ctx) {
      const { name, input } = args as { name: string; input: string };
      const skill = sr.get(name);
      if (!skill) return { error: `Skill "${name}" not found` };
      const result = await invokeSkill(skill, { input }, ctx as EpisodeContext & { sessionId: string });
      return { result };
    },
    toolset: "skills",
  });

  registry.register({
    name: "skill_create",
    description: "Create a new skill",
    parameters: z.object({ name: z.string(), description: z.string(), prompt: z.string() }),
    async handler(args) {
      const { name, description, prompt } = args as { name: string; description: string; prompt: string };
      const workspacePath = process.env.POLYMATH_WORKSPACE || join(homedir(), ".polymath", "workspace");
      const file = createSkill(workspacePath, name, description, prompt);
      sr.discover(workspacePath);
      return { created: file };
    },
    toolset: "skills",
  });
}

import { join } from "node:path";
import { homedir } from "node:os";
