import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { parseFrontmatter } from "./registry.js";

export function createSkill(workspacePath: string, name: string, description: string, prompt: string): string {
  const dir = join(workspacePath, "skills", name);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "SKILL.md");
  const content = `---\nname: ${name}\ndescription: ${description}\n---\n${prompt}\n`;
  writeFileSync(file, content, "utf-8");
  return file;
}

export function editSkill(skillFile: string, newPrompt: string): void {
  const content = readFileSync(skillFile, "utf-8");
  const { frontmatter } = parseFrontmatter(content);
  const yamlLines = Object.entries(frontmatter)
    .map(([k, v]) => `${k}: ${Array.isArray(v) ? `[${v.join(", ")}]` : v}`)
    .join("\n");
  writeFileSync(skillFile, `---\n${yamlLines}\n---\n${newPrompt}\n`, "utf-8");
}
