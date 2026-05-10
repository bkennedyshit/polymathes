import { z } from "zod";
import { exec, spawn } from "node:child_process";
import type { ToolRegistry } from "../registry.js";

export function register(registry: ToolRegistry): void {
  registry.register({
    name: "proc_list",
    description: "List running processes",
    parameters: z.object({}),
    async handler() {
      const cmd = process.platform === "win32" ? "tasklist /FO CSV /NH" : "ps aux";
      return new Promise((resolve) => {
        exec(cmd, (err, stdout) => {
          if (err) return resolve({ error: err.message });
          resolve({ output: stdout.toString() });
        });
      });
    },
    toolset: "processes",
  });

  registry.register({
    name: "proc_kill",
    description: "Kill a process by PID",
    parameters: z.object({ pid: z.number() }),
    async handler(args) {
      const { pid } = args as { pid: number };
      try {
        process.kill(pid);
        return { ok: true };
      } catch (e: any) {
        return { error: e.message };
      }
    },
    toolset: "processes",
  });

  registry.register({
    name: "proc_spawn",
    description: "Spawn a detached process, return its PID",
    parameters: z.object({ command: z.string(), args: z.array(z.string()).optional(), cwd: z.string().optional() }),
    async handler(args) {
      const { command, args: spawnArgs, cwd } = args as { command: string; args?: string[]; cwd?: string };
      const child = spawn(command, spawnArgs ?? [], { cwd, detached: true, stdio: "ignore" });
      child.unref();
      return { pid: child.pid };
    },
    toolset: "processes",
  });

  registry.register({
    name: "proc_wait",
    description: "Wait for a process to exit by PID",
    parameters: z.object({ pid: z.number(), timeout: z.number().optional() }),
    async handler(args) {
      const { pid, timeout } = args as { pid: number; timeout?: number };
      const start = Date.now();
      const limit = timeout ?? 30_000;
      return new Promise<{ exitCode: number | null; timedOut?: boolean }>((resolve) => {
        const check = () => {
          try {
            process.kill(pid, 0); // test if alive
            if (Date.now() - start > limit) return resolve({ exitCode: null, timedOut: true });
            setTimeout(check, 200);
          } catch {
            resolve({ exitCode: 0 });
          }
        };
        check();
      });
    },
    toolset: "processes",
  });
}
