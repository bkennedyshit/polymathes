import { execFile } from "node:child_process";
import { existsSync } from "node:fs";

export function detectFirejail(): boolean {
  return existsSync("/usr/bin/firejail");
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export async function firejailExecute(
  command: string,
  opts: { cwd?: string; env?: Record<string, string> },
  signal: AbortSignal,
): Promise<ExecResult> {
  if (signal.aborted) throw new Error("aborted");
  if (!detectFirejail()) throw new Error("firejail not available");

  const args = ["--net=none", "--private-tmp", "--quiet", "--", "sh", "-c", command];

  return new Promise((resolve, reject) => {
    const proc = execFile("firejail", args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      maxBuffer: 10 * 1024 * 1024,
    }, (err, stdout, stderr) => {
      resolve({ stdout, stderr, exitCode: err ? (err as any).code ?? 1 : 0 });
    });

    const onAbort = () => { proc.kill(); reject(new Error("aborted")); };
    signal.addEventListener("abort", onAbort, { once: true });
    proc.on("close", () => signal.removeEventListener("abort", onAbort));
  });
}
