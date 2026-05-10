import { z } from "zod";
import { exec, spawn } from "node:child_process";
import { writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { ToolRegistry } from "../registry.js";

export function register(registry: ToolRegistry): void {
  registry.register({
    name: "shell_run",
    description: "Execute a shell command and return stdout, stderr, exitCode",
    parameters: z.object({ command: z.string(), cwd: z.string().optional(), timeout: z.number().optional() }),
    async handler(args) {
      const { command, cwd, timeout } = args as { command: string; cwd?: string; timeout?: number };
      return new Promise((resolve) => {
        exec(command, { cwd, timeout: timeout ?? 30_000 }, (err, stdout, stderr) => {
          resolve({ stdout: stdout.toString(), stderr: stderr.toString(), exitCode: err?.code ?? 0 });
        });
      });
    },
    toolset: "terminal",
  });

  registry.register({
    name: "shell_run_streaming",
    description: "Execute a shell command, streaming stdout/stderr lines as they arrive",
    parameters: z.object({ command: z.string(), cwd: z.string().optional() }),
    async handler(args) {
      const { command, cwd } = args as { command: string; cwd?: string };
      const isWin = process.platform === "win32";
      const shell = isWin ? "cmd.exe" : "/bin/sh";
      const shellArgs = isWin ? ["/c", command] : ["-c", command];
      return new Promise<{ lines: string[]; exitCode: number }>((resolve) => {
        const child = spawn(shell, shellArgs, { cwd, stdio: ["ignore", "pipe", "pipe"] });
        const lines: string[] = [];
        let outBuf = "", errBuf = "";
        child.stdout.on("data", (chunk: Buffer) => {
          outBuf += chunk.toString();
          const parts = outBuf.split("\n");
          outBuf = parts.pop()!;
          for (const l of parts) lines.push(l);
        });
        child.stderr.on("data", (chunk: Buffer) => {
          errBuf += chunk.toString();
          const parts = errBuf.split("\n");
          errBuf = parts.pop()!;
          for (const l of parts) lines.push(l);
        });
        child.on("close", (code) => {
          if (outBuf) lines.push(outBuf);
          if (errBuf) lines.push(errBuf);
          resolve({ lines, exitCode: code ?? 0 });
        });
      });
    },
    toolset: "terminal",
  });

  registry.register({
    name: "shell_run_script",
    description: "Write script to temp file, execute it, return output",
    parameters: z.object({ script: z.string(), interpreter: z.string().optional() }),
    async handler(args) {
      const { script, interpreter } = args as { script: string; interpreter?: string };
      const ext = process.platform === "win32" ? ".cmd" : ".sh";
      const tmp = join(tmpdir(), `polymath-${randomBytes(4).toString("hex")}${ext}`);
      await writeFile(tmp, script, { mode: 0o755 });
      const cmd = interpreter ? `${interpreter} "${tmp}"` : process.platform === "win32" ? `"${tmp}"` : `bash "${tmp}"`;
      return new Promise((resolve) => {
        exec(cmd, { timeout: 30_000 }, async (err, stdout, stderr) => {
          await unlink(tmp).catch(() => {});
          resolve({ stdout: stdout.toString(), stderr: stderr.toString(), exitCode: err?.code ?? 0 });
        });
      });
    },
    toolset: "terminal",
  });
}
