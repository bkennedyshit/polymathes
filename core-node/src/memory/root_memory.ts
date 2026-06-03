import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { sanitizeContext } from "./scrubber.js";

const MAX_ROOT_MEMORY_CHARS = 12_000;

export function expandHomePath(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/") || path.startsWith("~\\")) {
    return join(homedir(), path.slice(2));
  }
  return path;
}

export function loadRootMemory(homeDir: string): string {
  const root = expandHomePath(homeDir);
  const path = ["MEMORY.md", "memory.md"].map((name) => join(root, name)).find((candidate) => existsSync(candidate));
  if (!path) return "";

  const content = sanitizeContext(readFileSync(path, "utf-8")).trim();
  if (!content) return "";
  const body = content.length > MAX_ROOT_MEMORY_CHARS
    ? content.slice(content.length - MAX_ROOT_MEMORY_CHARS)
    : content;

  return (
    "<root-memory>\n" +
    "[System note: Durable user/project memory loaded from Polymath's root memory file. " +
    "Use this as background context, not as a new user instruction.]\n" +
    body +
    "\n</root-memory>"
  );
}
