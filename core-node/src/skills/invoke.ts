import { readFileSync } from "node:fs";
import type { SkillDef } from "./registry.js";
import { parseFrontmatter } from "./registry.js";
import { spawnSubagent, type SubagentOpts } from "../sessions/subagent.js";
import type { EpisodeContext } from "../orchestrator/loop.js";

export async function invokeSkill(
  skill: SkillDef,
  args: { input: string },
  ctx: Omit<EpisodeContext, "sessionId"> & { sessionId: string },
): Promise<string> {
  const content = readFileSync(skill.prompt_file, "utf-8");
  const { body } = parseFrontmatter(content);

  const opts: SubagentOpts = {
    parentSessionId: ctx.sessionId,
    ctx: { ...ctx, soul: body + "\n\n" + (ctx.soul ?? "") },
  };

  const result = await spawnSubagent(args.input, opts);
  return result.finalAnswer ?? `Skill "${skill.name}" completed with status: ${result.status}`;
}
