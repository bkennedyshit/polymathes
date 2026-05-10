import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

function soulPath(workspacePath: string): string {
  return join(homedir(), ".polymath", "workspace", workspacePath, "SOUL.md");
}

export function loadSoul(workspacePath: string): string {
  try {
    return readFileSync(soulPath(workspacePath), "utf-8");
  } catch {
    return "";
  }
}

export function saveSoul(workspacePath: string, content: string): void {
  const p = soulPath(workspacePath);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content, "utf-8");
}
