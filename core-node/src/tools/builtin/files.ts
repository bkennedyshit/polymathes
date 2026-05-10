import { z } from "zod";
import { readFile, writeFile, readdir, stat, mkdir, rm, rename } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ToolRegistry } from "../registry.js";

async function globWalk(dir: string, pattern: RegExp, results: string[] = []): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) await globWalk(full, pattern, results);
    else if (pattern.test(full)) results.push(full);
  }
  return results;
}

function globToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "§").replace(/\*/g, "[^/\\\\]*").replace(/§/g, ".*").replace(/\?/g, ".");
  return new RegExp(escaped);
}

function applyUnifiedDiff(original: string, diff: string): string | null {
  const lines = original.split("\n");
  const diffLines = diff.split("\n");
  let i = 0;
  // skip --- and +++ header lines
  while (i < diffLines.length && (diffLines[i].startsWith("---") || diffLines[i].startsWith("+++"))) i++;
  while (i < diffLines.length) {
    const hunk = diffLines[i].match(/^@@\s*-(\d+)(?:,\d+)?\s*\+\d+(?:,\d+)?\s*@@/);
    if (!hunk) { i++; continue; }
    let lineIdx = parseInt(hunk[1], 10) - 1;
    i++;
    const removals: number[] = [];
    const additions: { at: number; text: string }[] = [];
    while (i < diffLines.length && !diffLines[i].startsWith("@@")) {
      const dl = diffLines[i];
      if (dl.startsWith("-")) { removals.push(lineIdx); lineIdx++; }
      else if (dl.startsWith("+")) { additions.push({ at: lineIdx, text: dl.slice(1) }); }
      else { lineIdx++; }
      i++;
    }
    // apply removals in reverse
    for (const r of removals.reverse()) lines.splice(r, 1);
    // apply additions
    let offset = 0;
    for (const a of additions) {
      const insertAt = a.at - removals.filter((r) => r < a.at).length + offset;
      lines.splice(insertAt, 0, a.text);
      offset++;
    }
  }
  return lines.join("\n");
}

export function register(registry: ToolRegistry): void {
  registry.register({
    name: "fs_read",
    description: "Read file content, optionally a line range (offset/limit are 0-based line numbers)",
    parameters: z.object({ path: z.string(), offset: z.number().optional(), limit: z.number().optional() }),
    async handler(args) {
      const { path, offset, limit } = args as { path: string; offset?: number; limit?: number };
      const content = await readFile(path, "utf-8");
      if (offset !== undefined || limit !== undefined) {
        const lines = content.split("\n");
        return { content: lines.slice(offset ?? 0, limit !== undefined ? (offset ?? 0) + limit : undefined).join("\n") };
      }
      return { content };
    },
    toolset: "files",
  });

  registry.register({
    name: "fs_write",
    description: "Write content to a file (creates parent dirs if needed)",
    parameters: z.object({ path: z.string(), content: z.string() }),
    async handler(args) {
      const { path: p, content } = args as { path: string; content: string };
      const dir = resolve(p, "..");
      await mkdir(dir, { recursive: true });
      await writeFile(p, content, "utf-8");
      return { ok: true };
    },
    toolset: "files",
  });

  registry.register({
    name: "fs_edit",
    description: "Replace old_str with new_str in a file. If old_str starts with '---', it is parsed as a unified diff.",
    parameters: z.object({ path: z.string(), old_str: z.string(), new_str: z.string() }),
    async handler(args) {
      const { path: p, old_str, new_str } = args as { path: string; old_str: string; new_str: string };
      const content = await readFile(p, "utf-8");
      if (old_str.startsWith("---")) {
        const patched = applyUnifiedDiff(content, old_str);
        if (patched === null) return { error: "failed to apply unified diff" };
        await writeFile(p, patched, "utf-8");
        return { ok: true };
      }
      if (!content.includes(old_str)) return { error: "old_str not found in file" };
      await writeFile(p, content.replace(old_str, new_str), "utf-8");
      return { ok: true };
    },
    toolset: "files",
  });

  registry.register({
    name: "fs_move",
    description: "Move/rename a file or directory",
    parameters: z.object({ src: z.string(), dest: z.string() }),
    async handler(args) {
      const { src, dest } = args as { src: string; dest: string };
      const destDir = resolve(dest, "..");
      await mkdir(destDir, { recursive: true });
      await rename(src, dest);
      return { ok: true };
    },
    toolset: "files",
  });

  registry.register({
    name: "fs_glob",
    description: "Find files matching a glob pattern",
    parameters: z.object({ pattern: z.string(), cwd: z.string().optional() }),
    async handler(args) {
      const { pattern, cwd } = args as { pattern: string; cwd?: string };
      const regex = globToRegex(pattern);
      const files = await globWalk(cwd ?? ".", regex);
      return { files };
    },
    toolset: "files",
  });

  registry.register({
    name: "fs_ls",
    description: "List directory contents",
    parameters: z.object({ path: z.string() }),
    async handler(args) {
      const { path: p } = args as { path: string };
      const entries = await readdir(p, { withFileTypes: true });
      return { entries: entries.map((e) => ({ name: e.name, type: e.isDirectory() ? "dir" : "file" })) };
    },
    toolset: "files",
  });

  registry.register({
    name: "fs_stat",
    description: "Get file stats",
    parameters: z.object({ path: z.string() }),
    async handler(args) {
      const { path: p } = args as { path: string };
      const s = await stat(p);
      return { size: s.size, isFile: s.isFile(), isDirectory: s.isDirectory(), mtime: s.mtime.toISOString() };
    },
    toolset: "files",
  });

  registry.register({
    name: "fs_mkdir",
    description: "Create directory (recursive)",
    parameters: z.object({ path: z.string() }),
    async handler(args) {
      const { path: p } = args as { path: string };
      await mkdir(p, { recursive: true });
      return { ok: true };
    },
    toolset: "files",
  });

  registry.register({
    name: "fs_delete",
    description: "Delete a file or directory",
    parameters: z.object({ path: z.string() }),
    async handler(args) {
      const { path: p } = args as { path: string };
      await rm(p, { recursive: true, force: true });
      return { ok: true };
    },
    toolset: "files",
  });
}
