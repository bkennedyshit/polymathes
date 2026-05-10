import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

export async function installSkill(name: string, workspacePath: string): Promise<string> {
  try {
    const res = await fetch(`https://agentskills.io/api/skills/${encodeURIComponent(name)}/download`);
    if (!res.ok) return `Failed to download skill '${name}': HTTP ${res.status}`;
    const body = await res.text();
    const shaHeader = res.headers.get("x-sha256");
    if (shaHeader) {
      const hash = createHash("sha256").update(body).digest("hex");
      if (hash !== shaHeader) return `Integrity check failed for skill '${name}'`;
    }
    const dir = join(workspacePath, "skills", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), body, "utf-8");
    return `Installed skill '${name}' to ${dir}`;
  } catch (e: any) {
    return `Error installing skill '${name}': ${e.message}`;
  }
}

export async function searchSkills(query: string): Promise<Array<{ name: string; description: string }> | string> {
  try {
    const res = await fetch(`https://agentskills.io/api/skills?q=${encodeURIComponent(query)}`);
    if (!res.ok) return `Search failed: HTTP ${res.status}`;
    return await res.json() as Array<{ name: string; description: string }>;
  } catch (e: any) {
    return `Error searching skills: ${e.message}`;
  }
}
