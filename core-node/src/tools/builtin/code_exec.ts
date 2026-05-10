import { z } from "zod";
import { execFile } from "node:child_process";
import { writeFile, unlink, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolRegistry } from "../registry.js";

function run(cmd: string, args: string[], timeout: number): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const proc = execFile(cmd, args, { timeout }, (err, stdout, stderr) => {
      resolve({ stdout, stderr, code: err ? (err as any).code ?? 1 : 0 });
    });
  });
}

export function register(registry: ToolRegistry): void {
  registry.register({
    name: "execute_code",
    description: "Execute code in a sandboxed subprocess",
    parameters: z.object({ language: z.string(), source: z.string(), timeout: z.number().optional() }),
    async handler(args) {
      const { language, source, timeout = 30000 } = args as { language: string; source: string; timeout?: number };
      const dir = await mkdtemp(join(tmpdir(), "polymath-exec-"));

      if (language === "javascript") {
        const file = join(dir, "script.mjs");
        await writeFile(file, source);
        const result = await run("node", [file], timeout);
        await unlink(file).catch(() => {});
        return result;
      }

      if (language === "python") {
        const file = join(dir, "script.py");
        await writeFile(file, source);
        const cmd = process.platform === "win32" ? "python" : "python3";
        const result = await run(cmd, [file], timeout);
        await unlink(file).catch(() => {});
        return result;
      }

      return { error: `language not supported: ${language}` };
    },
    toolset: "code",
  });
}
